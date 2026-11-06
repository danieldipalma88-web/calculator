import assert from "node:assert/strict";
import fs from "node:fs";
import { probeRebateService, createServiceStatusReader, serviceFailureCode, NSW_CALCULATION_URL } from "../lib/rebate-service-status.ts";

const expired = new TypeError("fetch failed", { cause: { code: "CERT_HAS_EXPIRED" } });
assert.equal(serviceFailureCode(expired), "certificate_error");
assert.equal(serviceFailureCode(new DOMException("timeout", "TimeoutError")), "timeout");
assert.equal(serviceFailureCode(new Error("private provider detail")), "unavailable");
assert.equal(serviceFailureCode({ cause: { code: "ERR_TLS_HANDSHAKE_TIMEOUT" } }), "timeout");
assert.equal(serviceFailureCode({ code: "ERR_TLS_INVALID_PROTOCOL_VERSION" }), "unavailable");
assert.equal(serviceFailureCode({ code: "ERR_TLS_CERT_ALTNAME_INVALID" }), "certificate_error");
const result = await probeRebateService(async (url, options) => {
  assert.equal(url, NSW_CALCULATION_URL);
  assert.equal(options.redirect, "error");
  assert.equal(options.cache, "no-store");
  assert.equal(options.method, "POST");
  assert.equal(JSON.parse(options.body).buildings.building_1.HVAC1_PDRSAug24_PDRS__postcode["2021-01-01"], "2145");
  return Response.json({ buildings: { building_1: {
    HVAC1_PDRSAug24_get_climate_zone_by_postcode: { "2021-01-01": "mixed" },
    HVAC1_PDRSAug24_BCA_climate_zone_by_postcode: { "2021-01-01": 6 },
  } } });
});
assert.equal(result.available, true);
assert.equal(result.code, "ok");
for (const [climate, bca, expected] of [
  ["mixed", true, false], ["mixed", [6], false], [["mixed"], 6, false],
  ["mixed", {}, false], ["mixed", null, false], ["mixed", "", false],
  ["mixed", 1.5, false], ["mixed", 9, false], ["mixed", "6", true],
]) {
  const health = await probeRebateService(async () => Response.json({ buildings: { building_1: {
    HVAC1_PDRSAug24_get_climate_zone_by_postcode: { "2021-01-01": climate },
    HVAC1_PDRSAug24_BCA_climate_zone_by_postcode: { "2021-01-01": bca },
  } } }));
  assert.equal(health.available, expected, JSON.stringify({ climate, bca }));
}

// Run the real, plain-JS route body with dependency stubs; no network or session secrets.
const route = fs.readFileSync(new URL("../app/api/rebate-service-status/route.ts", import.meta.url), "utf8");
const makeGet = new Function("getApprovedCalculatorSession", "readRebateServiceStatus", "NextResponse",
  route.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "") + "\nreturn GET;");
for (const status of [401, 403, 503, 200]) {
  let probes = 0;
  const get = makeGet(async () => ({ status, error: "Access denied" }),
    async () => { probes++; return result; }, { json: (body, options) => ({ body, ...options }) });
  const response = await get();
  assert.equal(response.status || 200, status);
  assert.equal(response.headers["Cache-Control"], "private, no-store");
  assert.equal(probes, status === 200 ? 1 : 0);
}
for (const response of [Response.json({}), new Response("", {status:503}), new Response("<html>")]) {
  assert.equal((await probeRebateService(async () => response)).available, false);
}
assert.equal((await probeRebateService(async () => { throw expired; })).code, "certificate_error");
let clock = 0, calls = 0, release;
const reader = createServiceStatusReader(() => { calls++; return new Promise(resolve => { release = resolve; }); }, () => clock);
const first = reader(), second = reader();
assert.equal(calls, 1);
release(result);
await Promise.all([first, second]);
await reader();
assert.equal(calls, 1);
clock = 30_001;
const refreshed = reader();
assert.equal(calls, 2);
release({ available:false, code:"certificate_error", checkedAt:result.checkedAt });
assert.equal((await refreshed).available, false);
console.log("Rebate service status: fixed target, TLS errors, malformed responses, deduplication and expiry passed.");
