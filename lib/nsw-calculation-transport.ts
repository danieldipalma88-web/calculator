export const NSW_PRIMARY_CALCULATE_URL = "https://of-sfg-rac-prd.energy.nsw.gov.au/calculate";
export const NSW_BACKUP_CALCULATE_URL = "https://rebate-portal-nsw-backup.vercel.app/api/calculate";
let primaryRetryAfter = 0;

export async function requestNswCalculation(options: RequestInit = {}) {
  if (options.method !== "POST" || typeof options.body !== "string") throw new Error("Invalid NSW calculation request");
  const request = async (url: string, timeoutMs: number) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal?.aborted) controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: options.body, signal: controller.signal, cache: "no-store", redirect: "error",
      });
      if (!response.ok) {
        let detail = "";
        try { detail = (await response.text()).slice(0, 300); } catch {}
        const error = new Error(`HTTP ${response.status} - ${detail}`);
        Object.assign(error, { status: response.status });
        throw error;
      }
      if (url === NSW_BACKUP_CALCULATE_URL && response.headers.get("X-NSW-Calculation-Source") !== "OpenFisca-ae8d778-HVAC1_PDRSAug24") {
        throw new Error("Unverified NSW backup calculation source");
      }
      const result = await response.json();
      if (url === NSW_BACKUP_CALCULATE_URL) {
        const expected = JSON.parse(options.body as string).buildings?.building_1;
        const actual = result?.buildings?.building_1;
        if (!expected || !actual || Object.keys(expected).length !== Object.keys(actual).length) throw new Error("Invalid NSW backup response");
        for (const field of Object.keys(expected)) {
          const periods = Object.keys(expected[field]);
          if (periods.length !== 1 || !actual[field] || Object.keys(actual[field]).length !== 1) throw new Error("Invalid NSW backup response period");
          const period = periods[0];
          const value = actual[field][period];
          const input = expected[field][period];
          const valid = input !== null ? value === input
            : field === "HVAC1_PDRSAug24_get_climate_zone_by_postcode" ? ["0", "hot", "mixed", "cold"].includes(value)
              : field === "HVAC1_PDRSAug24_BCA_climate_zone_by_postcode" ? typeof value === "string" && /^[1-8]$/.test(value)
                : typeof value === "number" && Number.isFinite(value);
          if (!valid) throw new Error("Incomplete or mismatched NSW backup response");
        }
        result._nswCalculationSource = "Verified NSW backup (ae8d778)";
      }
      return result;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  };
  if (Date.now() >= primaryRetryAfter) {
    try {
      const result = await request(NSW_PRIMARY_CALCULATE_URL, 4000);
      primaryRetryAfter = 0;
      return result;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (error instanceof Error && /no field of name 0/i.test(error.message)) throw error;
      const status = Number((error as { status?: number })?.status);
      if (status >= 400 && status < 500 && ![408, 429].includes(status)) throw error;
      primaryRetryAfter = Date.now() + 60000;
    }
  }
  return request(NSW_BACKUP_CALCULATE_URL, 6000);
}
