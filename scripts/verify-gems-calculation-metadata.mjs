import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import vm from "node:vm";
import ts from "typescript";

register("./monitor-nsw-postcodes-loader.mjs", import.meta.url);
const lib = await import("../lib/gems-calculation-metadata.ts");
const { GEMS_AIRCON_RESOURCE_IDS, GEMS_VERIFIED_INVENTORY_SOURCE } = await import("../lib/gems-model-search.ts");
const { createGemsCalculationMetadata: create, GEMS_INVENTORY_MAX_AGE_MS: hour } = lib;
const brand = "Fujitsu General", model = "AOTG09KMTC / ASTG09KMTC";
const row = {
  Brand: brand, Model_No: model, SubmitStatus: "Approved", "Availability Status": "Available", Sold_in: "Australia, New Zealand",
  Configuration1: "Non Ducted", Configuration2: "Single Split System", "Product Class": "Class 8", Phase: "Single",
  "C-Total Cool Rated": "2.50", "H-Total Heat Rated": 3.2, "C-Power_Inp_Rated": 0.53, "Rated AEER": 4.701, "Rated ACOP": 4.8352,
  "Residential TCSPF_mixed": 6.755, "Residential HSPF_mixed": 4.975, "Residential HSPF_cold": 4.548,
  "Residential tcec_hot": 452, "Residential tcec_mixed": 155, "Residential tcec_cold": 97,
  "Residential thec_hot": 0, "Residential thec_mixed": 351, "Residential thec_cold": 920,
  "Residential TCSPF_cold": "5.500", "Residential TCSPF_hot": 7.25, "Residential HSPF_hot": 5.95,
  privateValue: "must not escape",
};
const date = Date.parse("2026-11-06T12:00:00Z");
const fixed = rows => create({ fetchInventory: async () => rows, now: () => date });
const reject = (promise, status, code) => assert.rejects(promise, { status, code });
const success = await fixed([row])("Fujitsu", "ASTG09-KMTC / AOTG09KMTC");
assert.deepEqual(Object.keys(success), ["schemaVersion", "meta", "brand", "model", "source", "verifiedAt", "expiresAt"]);
assert.equal(success.schemaVersion, 1);
assert.equal(success.source, "GEMS registry + NSW formula");
assert.equal(success.verifiedAt, date);
assert.equal(success.expiresAt, date + hour);
assert.equal(success.meta["Cooling Capacity"], "2.50");
assert.equal(success.meta["Input Power"], 0.53);
assert.equal(success.meta["Residential thec_hot"], 0);
assert.equal(success.meta["Residential TCSPF_cold"], "5.500");
assert.equal(success.meta["Residential TCSPF_hot"], 7.25);
assert.equal(success.meta["Residential HSPF_hot"], 5.95);
assert.doesNotMatch(JSON.stringify(success), /must not escape/);

for (const [badBrand, badModel] of [[null, model], [brand, null], ["A".repeat(101), model], [brand, "A".repeat(161)], ["Fu\njitsu", model], [brand, "AOTG<test>"], [brand, "OUT01 // IN01"]]) {
  await reject(create({ fetchInventory: () => assert.fail("Invalid input cannot fetch") })(badBrand, badModel), 400, "GEMS_INVALID_REQUEST");
}
const mhi = "Mitsubishi Heavy Industries", mhiPair = "FDCA71VNX-W / FDU71VH", mhiPackage = "FDU71AVNXWVH";
assert.equal((await fixed([{ ...row, Brand: mhi, Model_No: mhiPackage }])(mhi, mhiPair)).model, mhiPackage);
assert.equal((await fixed([{ ...row, Brand: mhi, Model_No: mhiPair }])("Mitsubishi HI", mhiPackage)).model, mhiPair);
await reject(fixed([{ ...row, Brand: mhi, Model_No: mhiPackage, "Outdoor Unit Only": "Yes" }])(mhi, mhiPair), 422, "GEMS_MODEL_REJECTED");
await reject(fixed([{ ...row, "Outdoor Unit Only": true }])(brand, model), 422, "GEMS_MODEL_REJECTED");
await reject(fixed([{ ...row, Brand: mhi, Model_No: "FDU71VH" }])(mhi, mhiPair), 404, "GEMS_MODEL_NOT_FOUND");
await reject(fixed([{ ...row, Brand: "Toshiba", Model_No: "RAS-07E2AVG-A / RAS-07E2KVG-A" }])("Toshiba", "RAS-07E2AVG-A"), 404, "GEMS_MODEL_NOT_FOUND");
await reject(fixed([{ ...row, Model_No: "AOTG09KMTC" }])(brand, model), 404, "GEMS_MODEL_NOT_FOUND");
await reject(fixed([row])(brand, "AOTG09KMTC"), 404, "GEMS_MODEL_NOT_FOUND");
const hisense = { ...row, Brand: "Hisense", Model_No: "HAWG9KR", "Registration Number": "AAC8005", "Outdoor unit only": "No" };
assert.equal((await fixed([hisense])("Hisense", "HAWG9KR")).model, "HAWG9KR");
for (const change of [{ "Outdoor unit only": "Yes" }, { "Outdoor unit only": null }, { Configuration2: "" }, { Model_No: "HAWG9KR-O" }]) {
  const candidate = { ...hisense, ...change };
  await reject(fixed([candidate])("Hisense", candidate.Model_No), 422, "GEMS_MODEL_REJECTED");
}
const multi = { ...row, Model_No: "OUTDOOR-1", Configuration2: "Fixed", ApplStandard: "[SEER Multi-Split <=65kW]" };
assert.equal((await fixed([multi])(brand, "OUTDOOR-1")).model, multi.Model_No);
await reject(fixed([{ ...multi, ApplStandard: "[SEER Non Multi-Split <=65kW]" }])(brand, "OUTDOOR-1"), 422, "GEMS_MODEL_REJECTED");
const gree = "GWH09ATBXB-K6DNA1C/O / GWH09ATBXB-K6DNA1C/I";
assert.equal((await fixed([{ ...row, Brand: "Gree", Model_No: gree.replaceAll(" ", "") }])("Gree", gree)).model, gree.replaceAll(" ", ""));
await reject(fixed([{ ...row, Brand: "Different" }])(brand, model), 503, "GEMS_UNAVAILABLE");

for (const unapproved of [{ SubmitStatus: "Pending" }, { "Availability Status": "Unavailable" }, { Sold_in: "Not Australia" }]) {
  await reject(fixed([{ ...row, ...unapproved }])(brand, model), 422, "GEMS_MODEL_REJECTED");
  assert.equal((await fixed([{ ...row, ...unapproved, "C-Power_Inp_Rated": 0.9 }, row])(brand, model)).meta["Input Power"], 0.53);
}
await reject(fixed([{ ...row, "Availability Status": null }])(brand, model), 422, "GEMS_MODEL_INCOMPLETE");
for (const value of [null, " ", true, [], "0x10"]) await reject(fixed([{ ...row, "Rated ACOP": value }])(brand, model), 422, "GEMS_MODEL_INCOMPLETE");
for (const ExpDate of ["2000-01-01", "2026-02-31", ""]) await reject(fixed([{ ...row, ExpDate }])(brand, model), 422, "GEMS_MODEL_REJECTED");
assert.equal((await fixed([{ ...row, ExpDate: "2000-01-01", "C-Power_Inp_Rated": 0.9 }, row])(brand, model)).meta["Input Power"], 0.53);
const endOfDay = create({ now: () => Date.parse("2026-11-06T23:30:00Z"), fetchInventory: async () => [{ ...row, ExpDate: "2026-11-06" }] });
assert.equal((await endOfDay(brand, model)).expiresAt, Date.parse("2026-11-07T00:00:00Z"));
const mirror = { ...row, "C-Total Cool Rated": 2.5, "Product Class": "8", Phase: "1-phase" };
assert.deepEqual(await fixed([row, mirror])(brand, model), await fixed([mirror, row])(brand, model));
for (const change of [{ "C-Power_Inp_Rated": 0.77 }, { "Residential HSPF_hot": 6.1 }, { "Product Class": "Class 9" }]) {
  for (const rows of [[row, { ...mirror, ...change }], [{ ...mirror, ...change }, row]]) {
    await reject(fixed(rows)(brand, model), 409, "GEMS_MODEL_CONFLICT");
  }
}
await reject(fixed([{ ...row, Brand: mhi, Model_No: mhiPair }, { ...row, Brand: mhi, Model_No: mhiPackage, "C-Power_Inp_Rated": 0.81 }])(mhi, mhiPair), 409, "GEMS_MODEL_CONFLICT");
const modern = { Brand: brand, Model_No: model, SubmitStatus: "Approved", Sold_in: "Australia", "Cooling Capacity": 2.5, "Input Power": 0.53 };
assert.equal((await fixed([modern, row])(brand, model)).meta["Input Power"], 0.53, "Agreeing unknown evidence cannot replace the eligible row");
await reject(fixed([modern])(brand, model), 422, "GEMS_MODEL_INCOMPLETE");
const modernIdentity = { Brand: brand, Model_No: model, SubmitStatus: "Approved", Sold_in: "Australia" };
for (const [field, agreed, different] of [["Rated Total Cool Capacity kW", 2.5, 3.5], ["Rated Heating Capacity kW", 3.2, 4.2], ["Rated cooling power input kW", 0.53, 0.9]]) {
  assert.equal((await fixed([{ ...modernIdentity, [field]: agreed }, row])(brand, model)).meta["Input Power"], 0.53);
  const conflict = { ...modernIdentity, [field]: different };
  await reject(fixed([row, conflict])(brand, model), 409, "GEMS_MODEL_CONFLICT");
  await reject(fixed([conflict, row])(brand, model), 409, "GEMS_MODEL_CONFLICT");
}
const { "C-Total Cool Rated": legacyCooling, "H-Total Heat Rated": legacyHeating, ...otherRatings } = row;
const labelled = await fixed([{ ...otherRatings, "Rated Total Cool Capacity kW": legacyCooling, "Rated Heating Capacity kW": legacyHeating }])(brand, model);
assert.equal(labelled.meta["Cooling Capacity"], legacyCooling);
assert.equal(labelled.meta["Heating Capacity"], legacyHeating);
const from = (index, row) => ({ ...row, [GEMS_VERIFIED_INVENTORY_SOURCE]: GEMS_AIRCON_RESOURCE_IDS[index] });
for (const [registration, precise, rounded] of [["AAC8714", "4.8352", "4.835"], ["AAC10167", "4.1832", "4.183"], ["AAC8788", "3.9555", "3.955"]]) {
  const legacy = from(1, { ...row, "Registration Number": registration, "Rated ACOP": precise });
  const labelled = from(0, { ...modernIdentity, "Registration Number": registration, "Rated ACOP": rounded });
  for (const ordered of [[labelled, legacy], [legacy, labelled]]) assert.equal((await fixed(ordered)(brand, model)).meta["Rated ACOP"], precise);
  for (const conflict of [
    { ...labelled, "Registration Number": "OTHER" }, { ...labelled, "Rated ACOP": Number(rounded) },
    { ...labelled, "Rated ACOP": `${rounded}0` }, { ...labelled, "Rated Total Cool Capacity kW": 3.5 },
    { ...labelled, "Availability Status": "Available" }, { ...labelled, [GEMS_VERIFIED_INVENTORY_SOURCE]: undefined },
  ]) await reject(fixed([legacy, conflict])(brand, model), 409, "GEMS_MODEL_CONFLICT");
}
for (const field of ["Rated AEER", "Rated ACOP"]) {
  const testPrecision = async (precise, rounded, accepted) => {
    const legacy = from(1, { ...row, "Registration Number": "AAC8788", [field]: precise });
    const labelled = from(0, { ...modernIdentity, "Registration Number": "AAC8788", [field]: rounded });
    for (const ordered of [[legacy, labelled], [labelled, legacy]]) {
      if (accepted) assert.equal((await fixed(ordered)(brand, model)).meta[field], precise);
      else await reject(fixed(ordered)(brand, model), 409, "GEMS_MODEL_CONFLICT");
    }
  };
  for (const [precise, rounded] of [
    ["3.9555", "3.955"], ["3.9555", "3.956"], ["3.9555000", "3.955"],
    ["3.9995", "4.000"], ["3.9995", "3.999"], ["3.9554", "3.955"], ["3.9556", "3.956"],
  ]) await testPrecision(precise, rounded, true);
  for (const [precise, rounded] of [
    ["3.9555001", "3.955"], ["3.9554999", "3.956"], ["3.9555", "3.954"],
    ["3.9555", "3.957"], ["3.9555", "3.9550"], ["3.9556", "3.955"],
  ]) await testPrecision(precise, rounded, false);
}
const tclFixture = JSON.parse(await readFile(new URL("./fixtures/tcl-gems-rounding-20261112.json", import.meta.url), "utf8"));
const tclRecords = tclFixture.records.map(({ resource, record }) => ({ ...record, [GEMS_VERIFIED_INVENTORY_SOURCE]: resource }));
const tclPrecise = tclRecords.find(record => record[GEMS_VERIFIED_INVENTORY_SOURCE] === GEMS_AIRCON_RESOURCE_IDS[1]);
for (const ordered of [tclRecords, [...tclRecords].reverse()]) {
  const before = await fixed([tclPrecise])("TCL", tclFixture.model);
  assert.deepEqual(await fixed(ordered)("TCL", tclFixture.model), before, "Export reconciliation must not change precise metadata");
}
for (const change of [{ "Rated ACOP": "3.954" }, { "Registration Number": "OTHER" }, { "Residential HSPF_mixed": "4.504" }]) {
  const conflicting = tclRecords.map(record => record === tclPrecise ? record : { ...record, ...change });
  await reject(fixed(conflicting)("TCL", tclFixture.model), 409, "GEMS_MODEL_CONFLICT");
}
const hisenseLegacy = from(1, { ...hisense, "Rated AEER": "4.7582", "Rated ACOP": "4.7379", "C-Total Cool Rated": "3.5302" });
const hisenseMirror = from(0, { ...hisense, "Availability Status": undefined, "Rated AEER": "4.758", "Rated ACOP": "4.738", "C-Total Cool Rated": "3.5302" });
for (const ordered of [[hisenseLegacy, hisenseMirror], [hisenseMirror, hisenseLegacy]]) {
  const { meta } = await fixed(ordered)("Hisense", "HAWG9KR");
  assert.equal(meta["Rated AEER"], "4.7582");
  assert.equal(meta["Rated ACOP"], "4.7379");
}
const { "C-Total Cool Rated": _legacyCoolingColumn, ...hisenseMirrorWithoutCooling } = hisenseMirror;
const coolingConflict = { ...hisenseMirrorWithoutCooling, "Rated Total Cool Capacity kW": "3.530" };
for (const ordered of [[hisenseLegacy, coolingConflict], [coolingConflict, hisenseLegacy]]) {
  await reject(fixed(ordered)("Hisense", "HAWG9KR"), 409, "GEMS_MODEL_CONFLICT");
}
for (const change of [{ "Cooling Capacity": 3.5 }, { "Input Power": 0.9 }, { "Residential HSPF_hot": 6.2 }, { "C-Power_Inp_Rated": 0.9 }]) {
  for (const rows of [[{ ...modern, ...change }, row], [row, { ...modern, ...change }]]) {
    await reject(fixed(rows)(brand, model), 409, "GEMS_MODEL_CONFLICT");
  }
}
for (const change of [
  { "C-Total Cool Rated": 0 }, { "C-Power_Inp_Rated": -1 }, { "Rated AEER": 0 }, { "H-Total Heat Rated": -1 },
  { "Rated ACOP": -1 }, { "Residential TCSPF_mixed": -1 }, { "Residential HSPF_hot": -1 }, { "Residential thec_hot": -1 },
  { "Residential tcec_mixed": "1e999" },
]) {
  await reject(fixed([{ ...row, ...change }])(brand, model), 422, "GEMS_MODEL_INCOMPLETE");
  await reject(fixed([{ ...modern, ...change }, row])(brand, model), 422, "GEMS_MODEL_INCOMPLETE");
}
const zeroAllowed = { ...row, "H-Total Heat Rated": 0, "Rated ACOP": "0", "Residential TCSPF_mixed": 0, "Residential HSPF_cold": 0, "Residential TCSPF_hot": 0, "Residential tcec_cold": 0 };
const validZero = await fixed([zeroAllowed])(brand, model);
for (const field of ["Heating Capacity", "Rated ACOP", "Residential TCSPF_mixed", "Residential HSPF_cold", "Residential TCSPF_hot", "Residential tcec_cold"]) assert.equal(Number(validZero.meta[field]), 0);

let clock = date;
let cached;
let reads = 0;
let lastBrands;
let resolveLoad;
const first = new Promise(resolve => { resolveLoad = resolve; });
const lookup = create({ now: () => clock, fetchInventory: async names => { lastBrands = names; reads++; return reads === 1 ? first : [row]; },
  wrapInventory: load => async key => cached ??= await load(key) });
const sameBrand = [lookup(brand, model), lookup("FUJITSU", model), lookup("fujitsu", "missing-unit / missing-head")];
const checked = Promise.allSettled(sameBrand);
await new Promise(resolve => setImmediate(resolve));
assert.equal(reads, 1);
assert.deepEqual(lastBrands, ["fujitsu general", "fujitsu"]);
resolveLoad([row]);
const found = await checked;
assert.deepEqual(found[0], found[1]);
assert.equal(found[2].reason.code, "GEMS_MODEL_NOT_FOUND");
clock += hour - 1;
assert.equal((await lookup(brand, model)).verifiedAt, date, "In-window stale data retains original timestamp");
clock++;
assert.equal((await lookup(brand, model)).verifiedAt, clock, "Hard expiry waits for fresh data without requiring user retry");
assert.equal(reads, 2);
clock += 1000;
assert.equal((await lookup(brand, model)).verifiedAt, clock - 1000, "Bridge a still-stale framework cache without relabelling the refresh timestamp");
assert.equal(reads, 2, "No repeated provider fetch while a just-completed refresh remains valid");
clock += 300000;
assert.equal((await lookup(brand, model)).verifiedAt, clock, "Short refresh bridge cannot become an indefinitely retained snapshot");
assert.equal(reads, 3);

let swrClock = date, swrCache, swrReads = 0, releaseRefresh, refreshPromise;
const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
const swr = create({ now: () => swrClock, fetchInventory: async () => { swrReads++; return swrReads === 1 ? [row] : refreshGate; },
  wrapInventory: load => async key => {
    if (!swrCache) swrCache = await load(key);
    else if (swrClock - swrCache.verifiedAt >= hour) refreshPromise ??= load(key).then(value => { swrCache = value; });
    return swrCache;
  } });
await swr(brand, model);
swrClock += hour;
const waiting = Promise.all([swr(brand, model), swr("Fujitsu", model)]);
await new Promise(resolve => setImmediate(resolve));
assert.equal(swrReads, 2, "Foreground recovery joins the existing background refresh");
releaseRefresh([row]);
const recovered = await waiting;
assert.equal(recovered[0].verifiedAt, swrClock);
assert.deepEqual(recovered[0], recovered[1]);
await refreshPromise;
assert.equal(swrReads, 2);

let repeatedClock = date, repeatedCache, repeatedReads = 0;
const repeatedBackground = create({ now: () => repeatedClock, fetchInventory: async () => { repeatedReads++; return [row]; },
  wrapInventory: load => async key => {
    if (!repeatedCache) repeatedCache = await load(key);
    else if (repeatedClock - repeatedCache.verifiedAt >= hour) void load(key).catch(() => {});
    return repeatedCache;
  } });
await repeatedBackground(brand, model);
repeatedClock += hour;
for (let i = 0; i < 4; i++) {
  assert.equal((await repeatedBackground(brand, model)).verifiedAt, repeatedClock);
  await new Promise(resolve => setImmediate(resolve));
}
assert.equal(repeatedReads, 2, "Even repeated background refresh attempts reuse the completed recovery, without extra provider reads");

for (const timestamp of [String(date), NaN, Infinity, date + 1]) {
  const malformedCache = create({ now: () => date, fetchInventory: async () => [row],
    wrapInventory: load => async key => ({ ...await load(key), verifiedAt: timestamp }) });
  await reject(malformedCache(brand, model), 503, "GEMS_UNAVAILABLE");
}

for (const refreshedRows of [
  [{ ...row, "Availability Status": "Unavailable" }],
  [row, { ...row, "C-Power_Inp_Rated": 0.99 }],
  [{ ...row, ExpDate: "2000-01-01" }],
]) {
  let current = date, prior, count = 0;
  const checkedRefresh = create({ now: () => current, fetchInventory: async () => ++count === 1 ? [row] : refreshedRows,
    wrapInventory: load => async key => prior ??= await load(key) });
  await checkedRefresh(brand, model);
  current += hour;
  const conflict = refreshedRows.length === 2;
  await reject(checkedRefresh(brand, model), conflict ? 409 : 422, conflict ? "GEMS_MODEL_CONFLICT" : "GEMS_MODEL_REJECTED");
}

let failedClock = date, failedCache, failedReads = 0, failRefresh = false;
const failedRefresh = create({ now: () => failedClock, fetchInventory: async () => {
  failedReads++;
  if (failRefresh) throw new Error("Registry unavailable during expiry recovery");
  return [row];
}, wrapInventory: load => async key => failedCache ??= await load(key) });
await failedRefresh(brand, model);
failedClock += hour;
failRefresh = true;
await reject(failedRefresh(brand, model), 503, "GEMS_UNAVAILABLE");
await reject(failedRefresh(brand, model), 503, "GEMS_UNAVAILABLE");
assert.equal(failedReads, 2, "Outage recovery is bounded and keeps the existing cooldown");
failedClock += 5000;
failRefresh = false;
assert.equal((await failedRefresh(brand, model)).verifiedAt, failedClock);
assert.equal(failedReads, 3);

let slowClock = date, slowCache, slowReads = 0, slowSignal;
const slowRecovery = create({ now: () => slowClock, deadlineMs: 30, fetchInventory: async (_names, signal) => {
  slowReads++;
  slowSignal = signal;
  return slowReads === 1 ? [row] : new Promise(() => {});
}, wrapInventory: load => async key => slowCache ??= await load(key) });
await slowRecovery(brand, model);
slowClock += hour;
const timeoutStarted = performance.now();
await reject(slowRecovery(brand, model), 503, "GEMS_UNAVAILABLE");
assert.ok(performance.now() - timeoutStarted < 1000, "Hard-expiry recovery cannot hang the request");
assert.equal(slowSignal.aborted, true);

let remoteCalls = 0;
let transient = true;
const retry = create({ now: () => clock, fetchInventory: async () => {
  remoteCalls++;
  if (transient) throw new Error("fixture TLS error");
  return [row];
} });
for (let i = 0; i < 2; i++) await reject(retry(brand, model), 503, "GEMS_UNAVAILABLE");
assert.equal(remoteCalls, 1);
clock += 5000;
transient = false;
assert.equal((await retry(brand, model)).model, model);
assert.equal(remoteCalls, 2);
let missed = [];
const noMissCache = create({ fetchInventory: async () => missed });
await reject(noMissCache(brand, model), 404, "GEMS_MODEL_NOT_FOUND");
missed = [row];
assert.equal((await noMissCache(brand, model)).model, model);

const originalFetch = globalThis.fetch;
const sqlOrigin = "https://data.gov.au";
let scenario = "healthy";
let signals = [];
let fetches = 0;
globalThis.fetch = async (input, init) => {
  fetches++;
  const url = new URL(input);
  assert.equal(url.origin, sqlOrigin, "All network is stubbed");
  assert.equal(init.cache, "no-store");
  assert.equal(init.redirect, "error");
  assert.match(url.searchParams.get("sql"), /LOWER\("Brand"\) IN \('fujitsu general', 'fujitsu'\)/);
  assert.doesNotMatch(url.searchParams.get("sql"), /SubmitStatus|Availability Status/, "Keep contrary exact registrations visible");
  signals.push(init.signal);
  const primary = url.searchParams.get("sql").includes("0973a476");
  if (scenario === "slow-fetch" && primary) return new Promise(() => {});
  if (scenario === "slow-body" && primary) return new Response(new ReadableStream({ start() {} }));
  if (scenario === "TLS" && primary) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } });
  if ([403, 503].includes(scenario) && primary) return new Response(null, { status: scenario });
  const records = scenario === "rounded" ? (primary
    ? [{ ...modernIdentity, "Registration Number": "AAC8714", "Rated ACOP": "4.835" }]
    : [{ ...row, "Registration Number": "AAC8714", "Rated ACOP": "4.8352" }]) : primary ? [] : [row];
  if (scenario === "cap") return Response.json({ success: true, result: { records: Array.from({ length: 10000 }, () => ({ Brand: brand })) } });
  return Response.json({ success: scenario !== "bad-envelope", result: { records, ...(scenario === "truncated" ? { records_truncated: true } : {}), ...(scenario === "total" ? { total: records.length + 1 } : {}) } });
};
try {
  for (const failure of [403, 503, "TLS", "truncated", "cap", "total", "bad-envelope", "slow-fetch", "slow-body"]) {
    scenario = failure;
    signals = [];
    const upstream = create({ deadlineMs: 35 });
    await reject(upstream(brand, model), 503, "GEMS_UNAVAILABLE");
    assert.ok(signals.length && signals.every(signal => signal.aborted), `${failure}: abort the provider request(s)`);
  }
  scenario = "rounded";
  assert.equal((await create()(brand, model)).meta["Rated ACOP"], "4.8352", "HTTP loader assigns trusted dataset provenance");
  scenario = "healthy";
  let cacheOptions;
  const source = await readFile(new URL("../app/api/gems-model-metadata/route.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const sandbox = { exports: {}, URL, require(name) {
    if (name === "next/server") return { NextResponse: { json: Response.json } };
    if (name === "next/cache") return { unstable_cache(load, keys, options) { cacheOptions = { keys, ...options }; return load; } };
    return lib;
  } };
  vm.runInNewContext(outputText, sandbox);
  const { GET } = sandbox.exports;
  assert.equal(cacheOptions.revalidate, 300);
  assert.ok(cacheOptions.keys[0].includes("inventory-v3"));
  const bad = await GET(new Request("https://calculator.test/api/gems-model-metadata?brand=Fujitsu&brand=Other&model=AB123"));
  assert.equal(bad.status, 400);
  const before = fetches;
  const url = new URL("https://calculator.test/api/gems-model-metadata");
  url.search = new URLSearchParams({ brand, model });
  const good = await GET(new Request(url));
  assert.equal(good.status, 200);
  assert.equal(good.headers.get("cache-control"), "no-store");
  assert.equal((await good.json()).meta["Input Power"], 0.53);
  assert.equal(fetches - before, 2, "Both datasets, one read each");
  scenario = 403;
  const unavailable = await GET(new Request(url));
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("retry-after"), "5");
  assert.equal((await unavailable.json()).code, "GEMS_UNAVAILABLE");
} finally { globalThis.fetch = originalFetch; }

console.log("Exact GEMS metadata: real GET envelope, aliases and components, registered outdoor, complete ratings, conflicts, expiry, single-flight, recovery, cap, provider failures and fetch/body deadlines passed.");
