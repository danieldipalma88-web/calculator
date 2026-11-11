import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import engine from "../services/nsw-rebate-backup/api/calculate.mjs";
import { createFrontendCalculator } from "./monitor-nsw-postcodes-helpers.mjs";

register("./monitor-nsw-postcodes-loader.mjs", import.meta.url);
const { createGemsCalculationMetadata, GemsCalculationMetadataError, GEMS_INVENTORY_MAX_AGE_MS } =
  await import("../lib/gems-calculation-metadata.ts");
const { GEMS_VERIFIED_INVENTORY_SOURCE: source, GEMS_AIRCON_RESOURCE_IDS: resources } =
  await import("../lib/gems-model-search.ts");
const fixture = JSON.parse(await readFile(new URL("./fixtures/tcl-registration-estimates-20261112.json", import.meta.url), "utf8"));
const inventory = fixture.records.map(({ resource, record }) => ({ ...record, [source]: resource }));
const captureTime = Date.parse(fixture.capturedAt);
const models = [
  ["TAC-10CHSD/VEIH", ["AAC8585", "AAC8789"]],
  ["TAC-13CHSD/VEIH", ["AAC8581", "AAC8790"]],
];
const registrationOf = row => row["Registration Number"];
const expiryOf = row => Date.parse(row.ExpDate) + 86_400_000;
const optIn = { registrationEstimate: true };
const fixed = (rows = inventory, now = captureTime, brand = "tcl") => createGemsCalculationMetadata({
  now: () => now,
  fetchInventory: async brands => {
    assert.deepEqual(brands, [brand]);
    return rows;
  },
});
const conflict = { status: 409, code: "GEMS_MODEL_CONFLICT" };
const unavailableEstimate = error => error instanceof GemsCalculationMetadataError && [404, 409, 422].includes(error.status);

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).join("\n");
const ast = ts.createSourceFile("calculator.js", script, ts.ScriptTarget.Latest, true);
const names = new Set(["lowestRegistrationCertificates", "recordValue", "gemsRecordBrand", "gemsRecordModel", "modelMetaFromGemsRecord"]);
const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text));
assert.deepEqual(new Set(declarations.map(node => node.name.text)), names);
const { lowestRegistrationCertificates, modelMetaFromGemsRecord } = vm.runInNewContext(
  `${declarations.map(node => node.getText(ast)).join("\n")}\n({ lowestRegistrationCertificates, modelMetaFromGemsRecord });`,
);

test("Only explicit opt-in returns the exact two TCL registrations, using precise legacy metadata", async () => {
  assert.equal(fixture.source, "https://data.gov.au/data/api/3/action/datastore_search_sql");
  assert.ok(Number.isFinite(captureTime));
  assert.equal(inventory.length, 8);
  for (const [model, ids] of models) {
    const rows = inventory.filter(row => row.Model_No === model);
    assert.equal(rows.length, 4, model);
    for (const id of ids) {
      assert.deepEqual(rows.filter(row => registrationOf(row) === id).map(row => row[source]).sort(), [...resources].sort(), id);
    }
    const lookup = fixed();
    for (const fetchInventory of [async () => [], async () => { throw new Error('outage'); }]) {
      let reads = 0;
      const oldClient = createGemsCalculationMetadata({ fetchInventory: async () => { reads++; return fetchInventory(); } });
      await assert.rejects(oldClient('TCL', model), conflict);
      assert.equal(reads, 0, 'Old clients cannot fall back on an outage or incomplete inventory');
    }
    await assert.rejects(lookup("TCL", model), conflict);
    await assert.rejects(lookup("TCL", model, { registrationEstimate: false }), conflict);
    const result = await lookup("TCL", model, optIn);
    const { registrationEstimate: estimate, ...envelope } = result;
    assert.deepEqual(envelope, {
      schemaVersion: 1,
      brand: "TCL",
      model,
      meta: estimate.candidates[0].meta,
      source: "GEMS registry + NSW formula",
      verifiedAt: captureTime,
      expiresAt: captureTime + GEMS_INVENTORY_MAX_AGE_MS,
    });
    assert.equal(estimate.policy, "lower-total-v1");
    assert.deepEqual(estimate.candidates.map(({ registration }) => registration), ids);
    for (const { registration, meta } of estimate.candidates) {
      const precise = rows.find(row => registrationOf(row) === registration && row[source] === resources[1]);
      for (const [field, value] of Object.entries(modelMetaFromGemsRecord(precise))) {
        assert.equal(meta[field], value, `${model}/${registration}: ${field}`);
      }
    }
    assert.deepEqual(await fixed([...inventory].reverse())("TCL", model, optIn), result);

    const expiresAt = Math.min(...rows.map(expiryOf));
    assert.equal((await fixed(inventory, expiresAt - 1)("TCL", model, optIn)).expiresAt, expiresAt);
    await assert.rejects(fixed(inventory, expiresAt)("TCL", model, optIn), unavailableEstimate);
  }
});

test("Missing, untrusted, expired, incomplete or conflicting registration evidence fails closed", async () => {
  for (const [model, ids] of models) {
    const rows = inventory.filter(row => row.Model_No === model);
    for (const id of ids) {
      await assert.rejects(fixed(rows.filter(row => registrationOf(row) !== id))("TCL", model, optIn), unavailableEstimate,
        `${id}: missing registration`);
    }
    for (const row of rows) {
      const label = `${model}/${registrationOf(row)}/${row[source]}`;
      const remaining = rows.filter(other => other !== row);
      await assert.rejects(fixed(remaining)("TCL", model, optIn), unavailableEstimate, `${label}: missing export`);
      const identityOnly = Object.fromEntries(Object.entries(row).filter(([key]) =>
        ['Brand','Model_No','Registration Number','ExpDate','Configuration1','Configuration2','SubmitStatus','Availability Status','Sold_in'].includes(key)));
      identityOnly[source] = row[source];
      await assert.rejects(fixed([...remaining, identityOnly])('TCL', model, optIn), unavailableEstimate, `${label}: identity without rating evidence`);
      for (const [reason, patch] of [
        ["missing registration number", { "Registration Number": undefined }],
        ["missing resource provenance", { [source]: undefined }],
        ["unknown resource provenance", { [source]: "untrusted-export" }],
        ["missing expiry", { ExpDate: undefined }],
        ["expired export", { ExpDate: "2000-01-01" }],
        ["rejected export", { SubmitStatus: "Pending" }],
        ["invalid rating", { "Rated ACOP": "1e999" }],
      ]) {
        await assert.rejects(fixed([...remaining, { ...row, ...patch }])("TCL", model, optIn), unavailableEstimate, `${label}: ${reason}`);
      }
      await assert.rejects(fixed([...remaining, { ...row, "Residential tcec_mixed": "9999" }])("TCL", model, optIn),
        conflict, `${label}: exports disagree for the same registration`);
    }
    const precise = rows.find(row => row[source] === resources[1]);
    const missingRating = { ...precise };
    delete missingRating["Residential HSPF_cold"];
    await assert.rejects(fixed(rows.map(row => row === precise ? missingRating : row))("TCL", model, optIn), unavailableEstimate,
      `${model}: incomplete calculation metadata`);
    await assert.rejects(fixed([...rows, { ...precise, "Registration Number": "AAC999999" }])("TCL", model, optIn), conflict,
      `${model}: extra active registration, even if its ratings match`);
  }
});

test("An estimate cannot remain valid past the earlier expiry of a required export", async () => {
  const [model, [registration]] = models[0];
  const rows = inventory.map(row => row[source] === resources[0] && registrationOf(row) === registration
    ? { ...row, ExpDate: "2026-11-12" } : row);
  const expiresAt = Date.parse("2026-11-13T00:00:00Z");
  await assert.rejects(fixed(rows, expiresAt)("TCL", model, optIn), unavailableEstimate);
  assert.equal((await fixed(rows, expiresAt - 1000)("TCL", model, optIn)).expiresAt, expiresAt);
});

test("Opt-in does not relax conflicts for nearby models or other brands", async () => {
  const model = "TAC-13CHSD/VEIH";
  const rows = inventory.filter(row => row.Model_No === model);
  const neighbor = "TAC-13CHSD/VFIH";
  await assert.rejects(fixed(rows.map(row => ({ ...row, Model_No: neighbor })))("TCL", neighbor, optIn), conflict);
  await assert.rejects(fixed(rows.map(row => ({ ...row, Brand: "Other" })), captureTime, "other")("Other", model, optIn), conflict);
});

const total = ({ esc, prc }, escRate, prcRate) => esc * escRate + prc * prcRate;
const pair = ({ registration, esc, prc, officialEsc, officialPrc, calculationSource }) =>
  [registration, esc, prc, officialEsc, officialPrc, calculationSource];

test("Selection is rate-sensitive, retains one whole pair and validates both unrounded results", () => {
  const first = { registration: "A", esc: 1.23456, prc: 9.87654, officialEsc: 1, officialPrc: 9 };
  const second = { registration: "B", esc: 4.56789, prc: 2.34567, officialEsc: 4, officialPrc: 2 };
  const results = Object.freeze([Object.freeze(second), Object.freeze(first)]);
  assert.deepEqual(pair(lowestRegistrationCertificates(results, 23, 2.6)), pair(first));
  assert.deepEqual(pair(lowestRegistrationCertificates(results, 2.6, 23)), pair(second));

  const zero = { registration: "ZERO", esc: 0, prc: 0, officialEsc: 0, officialPrc: 0 };
  assert.deepEqual(pair(lowestRegistrationCertificates([first, zero], 23, 2.6)), pair(zero));
  const higher = { ...first, esc: 1.00019, prc: 0 };
  const lower = { ...second, esc: 1.00011, prc: 0 };
  assert.equal(total(higher, 23, 2.6).toFixed(2), total(lower, 23, 2.6).toFixed(2), "Both display as the same cents");
  assert.deepEqual(pair(lowestRegistrationCertificates([higher, lower], 23, 2.6)), pair(lower));

  for (const invalid of [
    [], [first], [first, second, zero],
    ...[undefined, NaN, Infinity, -1, Number.MAX_VALUE].map(esc => [first, { ...second, esc }]),
    [first, { ...second, prc: Infinity }],
  ]) assert.throws(() => lowestRegistrationCertificates(invalid, 23, 2.6), /both registered rebate options/i);
  for (const rates of [[NaN, 2.6], [23, Infinity], [23, -1]]) {
    assert.throws(() => lowestRegistrationCertificates(results, ...rates), /both registered rebate options/i);
  }
});

test("Local NSW backup engine compares both registrations across postcode, install and rate cases", async t => {
  let primaryAttempts = 0;
  const frontend = await createFrontendCalculator({ indexHtml: html, fetch: async (url, init) => {
    const { hostname } = new URL(url);
    if (hostname === "of-sfg-rac-prd.energy.nsw.gov.au") {
      primaryAttempts++;
      throw new TypeError("Simulated primary outage");
    }
    assert.equal(hostname, "rebate-portal-nsw-backup.vercel.app", "No external network is permitted");
    return engine.fetch(new Request(url, init));
  } });
  const postcodes = ["2145", "2213", "2550", "2575", "2756"];
  const installs = ["new", "replacement"];
  const rates = [[23, 2.6], [23, 0], [0, 2.6]];
  let calculations = 0;
  for (const [model, ids] of models) {
    const { registrationEstimate: { candidates } } = await fixed()("TCL", model, optIn);
    const outcomes = rates.map(() => ({ [ids[0]]: 0, [ids[1]]: 0, tie: 0 }));
    let sample;
    for (const postcode of postcodes) {
      for (const installType of installs) {
        const input = { postcode, installType, airConditionerType: "non_ducted_single_split_system" };
        const results = [];
        for (const { registration, meta } of candidates) {
          const result = await frontend.calculate({ ...input, metadata: meta });
          assert.equal(result.calculationSource, "Verified NSW backup (ae8d778)", `${model}/${postcode}/${installType}/${registration}`);
          assert.ok([result.esc, result.prc].every(n => Number.isFinite(n) && n >= 0));
          results.push({ ...result, registration });
          calculations++;
        }
        for (const [index, [escRate, prcRate]] of rates.entries()) {
          const selected = lowestRegistrationCertificates(results, escRate, prcRate);
          const totals = results.map(row => total(row, escRate, prcRate));
          const context = `${model}/${postcode}/${installType} @ ${escRate}/${prcRate}`;
          assert.equal(total(selected, escRate, prcRate), Math.min(...totals), context);
          const winningRow = results.find(row => row.registration === selected.registration);
          assert.ok(winningRow, context);
          assert.deepEqual(pair(selected), pair(winningRow), context);
          assert.equal(selected.registrationEstimate.policy, "lower-total-v1", context);
          assert.equal(selected.registrationEstimate.selectedRegistration, selected.registration, context);
          outcomes[index][totals[0] === totals[1] ? "tie" : selected.registration]++;
          if (!sample && index === 0 && totals[0] !== totals[1]) {
            sample = `${postcode}/${installType}: ${results.map(({ registration, esc, prc }, i) =>
              `${registration} ${esc.toFixed(4)} ESC + ${prc.toFixed(4)} PRC = $${totals[i].toFixed(2)}`).join(" vs ")}`;
          }
        }
      }
    }
    assert.ok(sample, `${model}: require at least one real payout difference at $23 ESC / $2.60 PRC`);
    t.diagnostic(`${model} (10 install cases): ${outcomes.map((counts, i) =>
      `$${rates[i][0]}/$${rates[i][1]} -> ${ids.map(id => `${id}:${counts[id]}`).join(", ")}; ties:${counts.tie}`).join(" | ")}. ${sample}.`);
  }
  assert.equal(calculations, 40);
  assert.ok(primaryAttempts > 0);
});
