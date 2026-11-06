export const BACKUP_URL = "https://rebate-portal-nsw-backup.vercel.app/api/calculate";
const prefix = "HVAC1_PDRSAug24_";
const date = "2021-01-01";
// Fujitsu AAC8714, new installation in 2170. Independent pre-outage reference.
export const referenceRequest = {
  buildings: { building_1: Object.fromEntries(Object.entries({
    PDRS__postcode: "2170", Activity: "new_installation_activity", Air_Conditioner_type: "non_ducted_single_split_system",
    product_class_input: "Class 8", BCA_Climate_Zone: "BCA_Climate_Zone_6", cooling_capacity_input: 2.5,
    heating_capacity_input: 3.2, input_power: 0.53, rated_AEER_input: 4.701, rated_ACOP_input: 4.8352,
    TCSPF_mixed: 6.755, HSPF_mixed: 4.975, HSPF_cold: 4.548, residential_TCEC: 155, residential_THEC: 351,
    electricity_savings: null, PDRS__regional_network_factor: null,
    peak_demand_reduction_capacity: null, get_network_loss_factor_by_postcode: null,
  }).map(([key, value]) => [prefix + key, { [date]: value }])) }, persons: { person1: {} },
};

function verifyReference(body) {
  const building = body?.buildings?.building_1;
  const expected = referenceRequest.buildings.building_1;
  if (!building || Object.keys(building).length !== Object.keys(expected).length) throw new Error("Invalid calculation response fields");
  for (const [field, input] of Object.entries(expected)) {
    const actual = building[field];
    if (!actual || Object.keys(actual).length !== 1 || !Object.hasOwn(actual, date)) throw new Error("Invalid calculation response period");
    const value = actual[date];
    if (input[date] === null ? typeof value !== "number" || !Number.isFinite(value) : value !== input[date]) throw new Error("Mismatched calculation response");
  }
  const value = (field) => building[prefix + field][date];
  const esc = value("electricity_savings") * value("PDRS__regional_network_factor") * 1.06;
  const prc = value("peak_demand_reduction_capacity") * value("get_network_loss_factor_by_postcode") * 10;
  if (!Number.isFinite(esc) || !Number.isFinite(prc) || Math.abs(esc - 8.61131174) > 1e-9 || Math.abs(prc - 86.646231) > 1e-9) throw new Error("Certificate reference mismatch");
  return { verified: true, esc, prc };
}

export async function probePrimaryCalculation(fetchImpl = fetch) {
  try {
    const origin = "https://calculator.rebateportal.com.au";
    const preflight = await fetchImpl("https://of-sfg-rac-prd.energy.nsw.gov.au/calculate", {
      method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Content-Type" },
      signal: AbortSignal.timeout(6000), redirect: "error",
    });
    if (!preflight.ok || preflight.redirected || ![origin, "*"].includes(preflight.headers.get("Access-Control-Allow-Origin"))
      || !(preflight.headers.get("Access-Control-Allow-Methods") || "").toUpperCase().split(/\s*,\s*/).includes("POST")
      || !(preflight.headers.get("Access-Control-Allow-Headers") || "").toLowerCase().split(/\s*,\s*/).includes("content-type")) throw new Error("Primary browser preflight failed");
    const response = await fetchImpl("https://of-sfg-rac-prd.energy.nsw.gov.au/calculate", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(referenceRequest), signal: AbortSignal.timeout(6000), redirect: "error",
    });
    if (!response.ok || response.redirected) throw new Error(`Primary reference HTTP ${response.status}`);
    if (![origin, "*"].includes(response.headers.get("Access-Control-Allow-Origin"))) throw new Error("Primary browser access unavailable");
    return verifyReference(await response.json());
  } catch (error) {
    return { verified: false, reason: error instanceof Error ? error.message : "Primary reference unavailable" };
  }
}

export async function probeBackupCalculation(fetchImpl = fetch) {
  try {
    const origin = "https://calculator.rebateportal.com.au";
    const preflight = await fetchImpl(BACKUP_URL, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Content-Type" }, signal: AbortSignal.timeout(6000), redirect: "error" });
    if (!preflight.ok || preflight.redirected || preflight.headers.get("Access-Control-Allow-Origin") !== origin
      || !(preflight.headers.get("Access-Control-Allow-Methods") || "").split(/\s*,\s*/).includes("POST")
      || !(preflight.headers.get("Access-Control-Allow-Headers") || "").toLowerCase().split(/\s*,\s*/).includes("content-type")) throw new Error("Backup browser preflight failed");
    const response = await fetchImpl(BACKUP_URL, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(referenceRequest), signal: AbortSignal.timeout(6000), redirect: "error" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (response.redirected || response.headers.get("X-NSW-Calculation-Source") !== "OpenFisca-ae8d778-HVAC1_PDRSAug24"
      || response.headers.get("Access-Control-Allow-Origin") !== origin
      || !(response.headers.get("Access-Control-Expose-Headers") || "").toLowerCase().split(/\s*,\s*/).includes("x-nsw-calculation-source")) throw new Error("Unverified backup browser response");
    return verifyReference(await response.json());
  } catch (error) {
    return { verified: false, reason: error instanceof Error ? error.message : "Backup unavailable" };
  }
}
