import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { checkCertificate, dependencyHealth } from "./monitor-rebate-dependencies.mjs";
import { probeBackupCalculation } from "./nsw-backup-probe.mjs";
import handler from "../services/nsw-rebate-backup/api/calculate.mjs";

async function scenario(days, error) {
  let destroyed = false;
  const now = Date.parse("2026-11-06T00:00:00Z");
  const result = await checkCertificate("example.test", options => {
    assert.equal(options.rejectUnauthorized, true, "Certificate validation must never be bypassed");
    assert.equal(options.servername, "example.test");
    const socket = new EventEmitter();
    socket.destroy = () => { destroyed = true; };
    socket.getPeerCertificate = () => ({ valid_to:new Date(now + days * 86_400_000).toUTCString() });
    queueMicrotask(() => error ? socket.emit("error", {code:error}) : socket.emit("secureConnect"));
    return socket;
  }, now);
  assert.equal(destroyed, true);
  return result;
}
assert.equal((await scenario(30)).ok, true);
assert.equal((await scenario(7)).ok, false);
assert.equal((await scenario(1)).ok, false);
assert.equal((await scenario(0, "CERT_HAS_EXPIRED")).reason, "CERT_HAS_EXPIRED");
assert.equal((await probeBackupCalculation((url, options) => handler.fetch(new Request(url, options)))).verified, true);
assert.equal((await probeBackupCalculation(async () => Response.json({ buildings: {} }))).verified, false);
assert.equal((await probeBackupCalculation(async () => { throw new Error("offline"); })).verified, false);
for (const header of ["Access-Control-Allow-Origin", "Access-Control-Allow-Methods", "Access-Control-Allow-Headers", "Access-Control-Expose-Headers", "X-NSW-Calculation-Source"]) {
  const result = await probeBackupCalculation(async (url, options) => {
    assert.equal(options.redirect, "error");
    const response = await handler.fetch(new Request(url, options));
    response.headers.delete(header);
    return response;
  });
  assert.equal(result.verified, false, `Reject missing ${header}`);
}
assert.equal((await probeBackupCalculation(async (url, options) => {
  const response = await handler.fetch(new Request(url, options));
  Object.defineProperty(response, "redirected", { value: true });
  return response;
})).verified, false, "Redirected services must not be trusted");
for (const mutate of [
  (building) => { building.HVAC1_PDRSAug24_PDRS__postcode["2021-01-01"] = "9999"; },
  (building) => { building.HVAC1_PDRSAug24_electricity_savings["2021-01-01"] = String(building.HVAC1_PDRSAug24_electricity_savings["2021-01-01"]); },
  (building) => { building.HVAC1_PDRSAug24_electricity_savings = { "2022-01-01": 8.123879 }; },
]) {
  const result = await probeBackupCalculation(async (url, options) => {
    const response = await handler.fetch(new Request(url, options));
    if (options.method === "OPTIONS") return response;
    const body = await response.json();
    mutate(body.buildings.building_1);
    return Response.json(body, { headers: response.headers });
  });
  assert.equal(result.verified, false, "The monitor must reject responses rejected by the calculator");
}
const renewal = dependencyHealth({ available: true }, await scenario(4), { verified: false });
assert.equal(renewal.ok, true, "An approaching renewal is not an outage");
assert.equal(renewal.degraded, true);
assert.equal(dependencyHealth({ available: false }, { ok: false }, { verified: true }).ok, true);
assert.equal(dependencyHealth({ available: false }, { ok: false }, { verified: false }).ok, false);
console.log("TLS expiry monitor validates certificates and warns seven days before expiry.");
