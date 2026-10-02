import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

function functionSource(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing function ${name}`);
  let depth = 0;
  let opened = false;
  for (let index = start; index < html.length; index += 1) {
    if (html[index] === "{") {
      depth += 1;
      opened = true;
    } else if (html[index] === "}") {
      depth -= 1;
      if (opened && depth === 0) return html.slice(start, index + 1);
    }
  }
  throw new Error(`Could not parse ${name}`);
}

function asyncFunctionSource(name) {
  const start = html.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`Missing async function ${name}`);
  let depth = 0;
  let opened = false;
  for (let index = start; index < html.length; index += 1) {
    if (html[index] === "{") {
      depth += 1;
      opened = true;
    } else if (html[index] === "}") {
      depth -= 1;
      if (opened && depth === 0) return html.slice(start, index + 1);
    }
  }
  throw new Error(`Could not parse ${name}`);
}

function contextWith(source, globals = {}) {
  const context = vm.createContext({ ...globals });
  vm.runInContext(source, context);
  return context;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const fetchJsonSource = asyncFunctionSource("fetchJson");
const certificatePayloadSource = functionSource("certificatePayload");
const certificateFetchSource = asyncFunctionSource("fetchCertificateCalculation");
const rebateEstimatorSource = asyncFunctionSource("estimateLiveEssRebate");
const optionGroupsSource = functionSource("optionGroups");

// The timeout must cover response-body parsing, not just receipt of headers.
{
  const scheduled = new Map();
  const cleared = [];
  let timerId = 0;
  let abortCount = 0;
  let capturedSignal;
  let globalsResponseReject;
  const responseJson = new Promise((resolve, reject) => {
    globalsResponseReject = reject;
  });
  const controller = new AbortController();
  const context = contextWith(`const DEFAULT_FETCH_TIMEOUT_MS = 12000;\n${fetchJsonSource}`, {
    AbortController: class {
      constructor() {
        return controller;
      }
    },
    setTimeout(callback, delay) {
      const id = ++timerId;
      scheduled.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
      scheduled.delete(id);
    },
    fetch: async (_url, options) => {
      capturedSignal = options.signal;
      options.signal.addEventListener("abort", () => {
        abortCount += 1;
        globalsResponseReject(new Error("body stream aborted"));
      });
      return { ok: true, json: () => responseJson };
    },
  });
  const request = vm.runInContext("fetchJson('/slow-body')", context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(capturedSignal, "fetch receives the abort signal");
  assert.equal(scheduled.size, 1, "a request timeout is armed while parsing JSON");
  const [[id, timer]] = scheduled;
  assert.equal(timer.delay, 12000, "the existing timeout duration is retained");
  timer.callback();
  await assert.rejects(request, /Live rebate service timed out/);
  assert.equal(abortCount, 1, "body timeout aborts the request");
  assert.equal(capturedSignal.aborted, true);
  assert.deepEqual(cleared, [id], "timeout is cleared after body-parse failure");
  assert.equal(scheduled.size, 0);
}

function certificateContext(fetchJson) {
  return contextWith(
    `
      const ESS_CALC_DATE = '2024-08-01';
      const ESS_CALCULATE_API = 'https://rebate.example/calculate';
      function normalizeAirConditionerType(value) { return String(value || '').toLowerCase(); }
      ${certificatePayloadSource}
      const pendingCertificateCalculations = new Map();
      ${certificateFetchSource}
    `,
    { fetchJson },
  );
}

// Equal endpoint+body requests share only while in flight; all input dimensions
// remain represented in the serialized request, and settled outcomes are removed.
{
  const gate = deferred();
  const calls = [];
  const context = certificateContext((url, options) => {
    calls.push({ url, body: options.body });
    return gate.promise;
  });
  const base = {
    HVAC1_PDRSAug24_Air_Conditioner_type: { "2024-08-01": "split" },
    HVAC1_PDRSAug24_activity: { "2024-08-01": "replacement" },
    HVAC1_PDRSAug24_rating: { "2024-08-01": 3.5 },
    unchanged: "kept",
  };
  const fields = ["field_a", "field_b"];
  const first = vm.runInContext(
    "fetchCertificateCalculation(base, fields, '2000')",
    Object.assign(context, { base, fields }),
  );
  const shared = vm.runInContext(
    "fetchCertificateCalculation(base, fields, '2000')",
    context,
  );
  assert.equal(calls.length, 1, "concurrent identical requests issue one fetch");

  const sent = JSON.parse(calls[0].body).buildings.building_1;
  assert.equal(sent.HVAC1_PDRSAug24_PDRS__postcode["2024-08-01"], "2000");
  assert.deepEqual(Object.keys(sent).filter((key) => key.startsWith("field_")), fields);
  assert.equal(sent.field_a["2024-08-01"], null);
  assert.equal(sent.field_b["2024-08-01"], null);
  assert.equal(sent.unchanged, "kept");

  gate.resolve({ ok: true });
  await Promise.all([first, shared]);
  await vm.runInContext("fetchCertificateCalculation(base, fields, '2000')", context);
  assert.equal(calls.length, 2, "successful results are not cached");

  const dimensions = [
    "fetchCertificateCalculation(base, fields, '2001')",
    "fetchCertificateCalculation({...base, HVAC1_PDRSAug24_activity: {'2024-08-01':'new'}}, fields, '2000')",
    "fetchCertificateCalculation({...base, HVAC1_PDRSAug24_Air_Conditioner_type: {'2024-08-01':'ducted'}}, fields, '2000')",
    "fetchCertificateCalculation({...base, HVAC1_PDRSAug24_rating: {'2024-08-01':4.2}}, fields, '2000')",
    "fetchCertificateCalculation(base, ['field_a'], '2000')",
  ];
  for (const expression of dimensions) {
    await vm.runInContext(expression, context);
  }
  assert.equal(calls.length, 7, "postcode, activity, type, rating, and requested fields separate payloads");
}

{
  let attempts = 0;
  const context = certificateContext(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary failure");
    return { ok: true };
  });
  context.base = { stable: true };
  context.fields = ["field"];
  await assert.rejects(
    vm.runInContext("fetchCertificateCalculation(base, fields, '2000')", context),
    /temporary failure/,
  );
  await vm.runInContext("fetchCertificateCalculation(base, fields, '2000')", context);
  assert.equal(attempts, 2, "failed result is evicted and the next call retries");
}

// Metadata and climate lookup must both begin before either deferred result settles.
{
  const metadata = deferred();
  const climate = deferred();
  let metadataStarted = 0;
  let climateStarted = 0;
  const context = contextWith(rebateEstimatorSource, {
    systemType: "split",
    installType: "replacement",
    HVAC_AIR_CONDITIONER_TYPES: { split: "split" },
    resolveModelMetadataForRebate() {
      metadataStarted += 1;
      return metadata.promise;
    },
    getClimateContext() {
      climateStarted += 1;
      return climate.promise;
    },
    normalizeAirConditionerType: (value) => value,
    calculateCertificatesForModel: async (_meta, _climate, options) => {
      assert.equal(options.installType, "replacement");
      return {
        esc: 2,
        prc: 3,
        officialEsc: 2,
        officialPrc: 3,
        eligibility: { essEligible: true },
      };
    },
    getEssEscRate: () => 99,
    getEssPrcRate: () => 88,
  });
  const calculation = vm.runInContext(
    `estimateLiveEssRebate('Brand', 'Model', {
      systemType: 'split', installType: 'replacement', escRate: 31.25, prcRate: 4.5
    })`,
    context,
  );
  assert.equal(metadataStarted, 1);
  assert.equal(climateStarted, 1, "climate lookup starts before metadata settles");
  metadata.resolve({ meta: { model: "Model" }, brand: "Brand", model: "Model", source: "registry" });
  climate.resolve({ climateZone: "mixed", bcaZone: "3" });
  const result = await calculation;
  assert.equal(result.escRate, 31.25);
  assert.equal(result.prcRate, 4.5);
  assert.equal(result.escValue, 62.5);
  assert.equal(result.prcValue, 13.5);
  assert.equal(result.rebate, 76);
}

function makeGroupsContext(quotes, quoteOptionDefs) {
  return contextWith(
    `
      let quotes = suppliedQuotes;
      let quoteOptionDefs = suppliedOptionDefs;
      function ensureOptionDefs() {}
      ${optionGroupsSource}
    `,
    { suppliedQuotes: quotes, suppliedOptionDefs: quoteOptionDefs },
  );
}

function oldOptionGroups(quotes, quoteOptionDefs) {
  return quoteOptionDefs.map((def, index) => ({
    def,
    number: index + 1,
    rows: quotes
      .map((row, rowIndex) => ({ ...row, _index: rowIndex }))
      .filter((row) => row.optionId === def.id),
  }));
}

for (const [quotes, defs] of [
  [[], [{ id: "a" }]],
  [
    [
      { id: "q1", optionId: "a", total: 10 },
      { id: "q2", optionId: "unknown", total: 20 },
      { id: "q3", total: 30 },
      { id: "q4", optionId: "a", total: 40 },
    ],
    [{ id: "a" }, { id: "empty" }, { id: "a" }],
  ],
]) {
  const original = structuredClone({ quotes, defs });
  const actual = vm.runInContext("optionGroups()", makeGroupsContext(quotes, defs));
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), oldOptionGroups(quotes, defs));
  assert.deepEqual({ quotes, defs }, original, "grouping must not mutate source rows or definitions");
}

// Deterministic operation comparison for the old per-group full-row cloning.
{
  const groupCount = 200;
  const rowCount = 1000;
  const defs = Array.from({ length: groupCount }, (_, index) => ({ id: `group-${index}` }));
  let actualCopies = 0;
  const rows = Array.from({ length: rowCount }, (_, index) => {
    const row = { id: index, optionId: defs[index % groupCount].id };
    return new Proxy(row, { ownKeys(target) { actualCopies += 1; return Reflect.ownKeys(target); } });
  });
  const output = vm.runInContext("optionGroups()", makeGroupsContext(rows, defs));
  assert.equal(output.reduce((sum, group) => sum + group.rows.length, 0), rowCount);
  assert.equal(actualCopies, rowCount, "optimized path copies only rows that enter the one-pass map");
  const legacyCopies = rowCount * groupCount;
  assert.equal(legacyCopies, 200000, "synthetic baseline performs one full row copy per group");
  assert.equal(actualCopies * groupCount, legacyCopies, "copy work falls by the group-count factor");
}

console.log("calculator performance checks passed");
