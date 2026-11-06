import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { referenceRequest } from "./nsw-backup-probe.mjs";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const start = html.indexOf("async function requestNswCalculation(");
const end = html.indexOf("async function fetchJson(", start);
assert.ok(start >= 0 && end > start, "Locate the browser transport implementation.");
const frontend = html.slice(start, end);
const backend = ts.transpileModule(await readFile(new URL("../lib/nsw-calculation-transport.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const primary = "https://of-sfg-rac-prd.energy.nsw.gov.au/calculate";
const backup = "https://rebate-portal-nsw-backup.vercel.app/api/calculate";
const revision = "OpenFisca-ae8d778-HVAC1_PDRSAug24";
const attribution = "Verified NSW backup (ae8d778)";
const prefix = "HVAC1_PDRSAug24_";
const date = "2021-01-01";
const postcode = prefix + "PDRS__postcode";
const climate = prefix + "get_climate_zone_by_postcode";
const bca = prefix + "BCA_climate_zone_by_postcode";
const savings = prefix + "electricity_savings";
const climateRequest = {
  buildings: { building_1: { [postcode]: { [date]: "2170" }, [climate]: { [date]: null }, [bca]: { [date]: null } } },
  persons: { person1: {} },
};
const building = (payload) => payload.buildings.building_1;
const post = (payload) => ({ method: "POST", body: JSON.stringify(payload) });

function withOutputs(request, outputs) {
  const result = structuredClone(request);
  for (const [field, value] of Object.entries(outputs)) building(result)[field] = { [date]: value };
  return result;
}

const climateResult = withOutputs(climateRequest, { [climate]: "mixed", [bca]: "6" });
const certResult = withOutputs(referenceRequest, {
  [savings]: 8.123879, [prefix + "PDRS__regional_network_factor"]: 1,
  [prefix + "peak_demand_reduction_capacity"]: 8.252022, [prefix + "get_network_loss_factor_by_postcode"]: 1.05,
});
const verified = (result) => Response.json(result, { headers: { "X-NSW-Calculation-Source": revision } });
const unavailable = () => { throw new TypeError("fetch failed"); };
const waitForAbort = ({ signal }) => new Promise((_, reject) => {
  signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
});

function harness(name, code) {
  let now = 1000;
  const calls = [];
  const timers = new Map();
  const responders = {
    [primary]: () => Response.json(climateResult),
    [backup]: () => verified(climateResult),
  };
  const context = vm.createContext({
    exports: {}, AbortController, Object, Error, Number,
    Date: { now: () => now },
    ESS_CALCULATE_API: primary, NSW_BACKUP_CALCULATE_API: backup, nswPrimaryRetryAfter: 0,
    setTimeout: (callback, delay) => { timers.set(callback, delay); return callback; },
    clearTimeout: (callback) => timers.delete(callback),
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (options.signal.aborted) throw new Error("Aborted");
      return responders[url](options);
    },
  });
  vm.runInContext(code, context);
  return {
    request: name === "server" ? context.exports.requestNswCalculation : context.requestNswCalculation,
    responders,
    advance: (ms) => { now += ms; },
    expire: (ms) => {
      const matches = [...timers].filter(([, delay]) => delay === ms);
      assert.equal(matches.length, 1, "Expected exactly one pending primary timeout.");
      matches[0][0]();
    },
    assertCalls: (urls, options = post(climateRequest)) => {
      assert.deepEqual(calls.map(({ url }) => url), urls);
      for (const { options: sent } of calls.splice(0)) {
        assert.equal(sent.method, "POST");
        assert.equal(sent.body, options.body, "Forward the exact input, never stale values.");
        assert.equal(sent.cache, "no-store");
        assert.equal(sent.redirect, "error");
        assert.deepEqual(Object.entries(sent.headers), [["Content-Type", "application/json"]]);
      }
      assert.equal(timers.size, 0, "Clear attempt timers on success and failure.");
    },
  };
}

for (const [name, code] of [["browser", frontend], ["server", backend]]) {
  const { request, responders, advance, expire, assertCalls } = harness(name, code);
  const options = post(climateRequest);
  const expectedBackup = { ...climateResult, _nswCalculationSource: attribution };
  assert.deepEqual(await request(options), climateResult, "Do not attach backup attribution to a primary response.");
  assertCalls([primary]);

  responders[primary] = async () => {
    const response = new Response("already consumed", { status: 400 });
    await response.text();
    return response;
  };
  await assert.rejects(request(options), { status: 400, message: /^HTTP 400\b/ });
  assertCalls([primary]);

  // The immediately following primary request also proves the 400 left the circuit closed.
  responders[primary] = () => new Response("no field of name 0", { status: 500 });
  await assert.rejects(request(options), { status: 500, message: /HTTP 500.*no field of name 0/ });
  assertCalls([primary]);
  responders[primary] = () => Response.json(climateResult);
  assert.deepEqual(await request(options), climateResult);
  assertCalls([primary]);

  responders[primary] = unavailable;
  assert.deepEqual(await request(options), expectedBackup);
  assertCalls([primary, backup]);
  assert.deepEqual(await request(options), expectedBackup);
  assertCalls([backup]);
  advance(60001);
  responders[primary] = () => Response.json(climateResult);
  assert.deepEqual(await request(options), climateResult);
  assertCalls([primary]);

  responders[primary] = waitForAbort;
  const timedOut = request(options);
  expire(4000);
  assert.deepEqual(await timedOut, expectedBackup);
  assertCalls([primary, backup]);

  advance(60001);
  responders[primary] = unavailable;
  responders[backup] = unavailable;
  await assert.rejects(request(options), /fetch failed/);
  assertCalls([primary, backup]);
  for (const headers of [{}, { "X-NSW-Calculation-Source": "OpenFisca-outdated-HVAC1_PDRSAug24" }]) {
    responders[backup] = () => Response.json(climateResult, { headers });
    await assert.rejects(request(options), /Unverified NSW backup calculation source/);
    assertCalls([backup]);
  }

  const certOptions = post(referenceRequest);
  for (const [label, mutate, error] of [
    ["null count", (b) => { b[savings][date] = null; }, /Incomplete or mismatched NSW backup response/],
    ["string count", (b) => { b[savings][date] = "0"; }, /Incomplete or mismatched NSW backup response/],
    ["wrong period", (b) => { b[savings] = { "2022-01-01": 0 }; }, /Incomplete or mismatched NSW backup response/],
    ["missing output", (b) => { delete b[savings]; }, /Invalid NSW backup response/],
    ["wrong echo", (b) => { b[postcode][date] = "2000"; }, /Incomplete or mismatched NSW backup response/],
  ]) {
    const malformed = structuredClone(certResult);
    mutate(building(malformed));
    responders[backup] = () => verified(malformed);
    await assert.rejects(request(certOptions), error, label);
    assertCalls([backup], certOptions);
  }

  const zero = withOutputs(certResult, { [savings]: 0, [prefix + "peak_demand_reduction_capacity"]: 0 });
  responders[backup] = () => verified(zero);
  assert.deepEqual(await request(certOptions), { ...zero, _nswCalculationSource: attribution });
  assertCalls([backup], certOptions);

  advance(60001);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(request({ ...options, signal: controller.signal }), /Aborted/);
  assertCalls([primary]);
  await assert.rejects(request({ method: "GET" }), /Invalid NSW calculation request/);
  assertCalls([]);
  console.log(`${name}: status passthrough, circuit recovery, timeout/outage, source and response validation, zero, redirect policy and cancellation passed`);
}
