export const NSW_CALCULATION_URL = "https://of-sfg-rac-prd.energy.nsw.gov.au/calculate";
export const SERVICE_PROBE_TIMEOUT_MS = 4_000;
export const SERVICE_STATUS_TTL_MS = 30_000;

export type RebateServiceStatus = {
  available: boolean;
  code: "ok" | "certificate_error" | "timeout" | "unavailable";
  checkedAt: string;
};

export function serviceFailureCode(error: unknown): RebateServiceStatus["code"] {
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 6; depth += 1) {
    const item = current as { code?: string; name?: string; cause?: unknown };
    const code = typeof item.code === "string" ? item.code : "";
    if (item.name === "TimeoutError" || item.name === "AbortError" || /TIMEOUT|TIMEDOUT/.test(code)) return "timeout";
    if (/CERT_|CERTIFICATE|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS_CERT_ALTNAME_INVALID/.test(code)) return "certificate_error";
    current = item.cause;
  }
  return "unavailable";
}

// Fixed, non-customer input. This verifies the dependency without exposing a proxy.
export async function probeRebateService(fetchImpl: typeof fetch = fetch): Promise<RebateServiceStatus> {
  const date = "2021-01-01";
  const checkedAt = new Date().toISOString();
  try {
    const response = await fetchImpl(NSW_CALCULATION_URL, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(SERVICE_PROBE_TIMEOUT_MS),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        buildings: { building_1: {
          HVAC1_PDRSAug24_PDRS__postcode: { [date]: "2145" },
          HVAC1_PDRSAug24_get_climate_zone_by_postcode: { [date]: null },
          HVAC1_PDRSAug24_BCA_climate_zone_by_postcode: { [date]: null },
        } },
        persons: { person1: {} },
      }),
    });
    if (!response.ok) throw new Error("NSW calculation service unavailable");
    const result = (await response.json())?.buildings?.building_1;
    const rawClimate = result?.HVAC1_PDRSAug24_get_climate_zone_by_postcode?.[date];
    const rawBca = result?.HVAC1_PDRSAug24_BCA_climate_zone_by_postcode?.[date];
    if (typeof rawClimate !== "string" ||
        !(typeof rawBca === "number" || (typeof rawBca === "string" && /^[1-8]$/.test(rawBca.trim())))) {
      throw new Error("Invalid service response types");
    }
    const climate = rawClimate.trim().toLowerCase();
    const bca = Number(rawBca);
    if (!["hot", "mixed", "average", "cold"].includes(climate) || !Number.isInteger(bca) || bca < 1 || bca > 8) {
      throw new Error("Invalid service response");
    }
    return { available: true, code: "ok", checkedAt };
  } catch (error) {
    return { available: false, code: serviceFailureCode(error), checkedAt };
  }
}

export function createServiceStatusReader(probe = probeRebateService, now = Date.now) {
  let cached: { expiresAt: number; value: RebateServiceStatus } | null = null;
  let pending: Promise<RebateServiceStatus> | null = null;
  return async function readStatus(): Promise<RebateServiceStatus> {
    if (cached && cached.expiresAt > now()) return cached.value;
    if (!pending) {
      pending = probe().then(value => {
        cached = { value, expiresAt: now() + SERVICE_STATUS_TTL_MS };
        return value;
      }).finally(() => { pending = null; });
    }
    return pending;
  };
}

export const readRebateServiceStatus = createServiceStatusReader();
