import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import vm from "node:vm";
import { postcodeDataIssue } from "../lib/nsw-postcode-data-issue.ts";
import handler from "../services/nsw-rebate-backup/api/calculate.mjs";
import { createFrontendCalculator } from "./monitor-nsw-postcodes-helpers.mjs";
import { loadExactGemsMetadata } from "./monitor-rebate-sample.mjs";
register("./monitor-nsw-postcodes-loader.mjs", import.meta.url);
const production = await import("../lib/nsw-hvac-rebate.ts");
const gems = await import("../lib/gems-model-search.ts");
const fixture = JSON.parse(await readFile(new URL("./fixtures/gems-gap-regressions-20261106.json", import.meta.url), "utf8"));
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const extract = (name, next) => html.slice(html.indexOf(`function ${name}(`), html.indexOf(`function ${next}(`));
const context = vm.createContext({ toNumber: Number });
vm.runInContext(extract("modelMetaScore", "scoreGemsRecord"), context);
const complete = gems.mapGemsModelSearchItem(fixture.models[0].record).metadata;
assert.equal(context.isUsableModelMeta(complete), true);
for (const missing of [null, undefined, "", " ", "N/A"]) {
  assert.equal(context.isUsableModelMeta({ ...complete, "Cooling Capacity": missing }), false, "Missing ratings are not zero");
}
vm.runInContext(extract("postcodeDataIssue", "resolvePostcodeZones").replace(/async\s*$/, ""), context);
const gaps = ["2611", "2618", "2619", "2678", "2898", "3691", "4375", "4377", "4380", "4383", "4385"];
for (const postcode of [...gaps, "2145", "2550"]) assert.equal(context.postcodeDataIssue(postcode), postcodeDataIssue(postcode));
const selection = vm.createContext({
  Set, String,
  normalizeLookup: value => String(value).toUpperCase().replace(/[^A-Z0-9]/g, ""),
  rebateLookupBrandCandidates: brand => [brand],
  rebateLookupModelSearchCandidates: () => ["AUW-85U4RK1/AUD-85UX4RTH1"],
  gemsRecordBrand: row => row.Brand,
  gemsRecordModel: row => row.Model_No,
  scoreGemsRecord: () => 250,
});
vm.runInContext(extract("selectBestGemsRecord", "fetchGemsRecordsForQuery").replace(/async\s*$/, ""), selection);
const hisense = fixture.models.find(item => item.brand === "Hisense").record;
assert.ok(selection.selectBestGemsRecord([hisense], "Hisense", "package", { exactModelOnly: true }));
for (const change of [{ Brand: "Other" }, { SubmitStatus: "Pending" }, { "Availability Status": "Unavailable" }, { Sold_in: "New Zealand" }, { Sold_in: null }]) {
  assert.equal(selection.selectBestGemsRecord([{ ...hisense, ...change }], "Hisense", "package", { exactModelOnly: true }), null, "Aliases must not bypass registration or brand evidence");
}

const originalFetch = globalThis.fetch;
let record;
let backupOutage = false;
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes("of-sfg-rac-prd.energy.nsw.gov.au")) throw new TypeError("fetch failed");
  if (String(url) === "https://rebate-portal-nsw-backup.vercel.app/api/calculate") {
    if (backupOutage) return Response.json({ error: "Unsupported or incomplete calculation request", code: "NSW_POSTCODE_DATA_UNAVAILABLE" }, { status: 503, headers: { "X-NSW-Calculation-Source": "OpenFisca-ae8d778-HVAC1_PDRSAug24" } });
    return handler.fetch(new Request(url, init));
  }
  if (new URL(url).hostname === "data.gov.au") {
    const query = new URL(url).searchParams.get("q");
    return Response.json({ success: true, result: { records: query === record.Model_No ? [record] : [] } });
  }
  throw new Error(`Unexpected fetch ${url}`);
};
try {
  const frontend = await createFrontendCalculator({ indexHtml: html, fetch: globalThis.fetch });
  assert.equal(fixture.models.length, 5);
  for (const item of fixture.models) {
    record = item.record;
    assert.ok(/^https:\/\/data.gov.au\//.test(item.sourceUrl));
    assert.ok(record["Registration Number"]);
    assert.equal(gems.isEligibleAustralianGemsRecord(record), true);
    const mapped = gems.mapGemsModelSearchItem(record);
    assert.equal(mapped.completeEnergyData, true);
    const selected = await loadExactGemsMetadata(gems, { ...item, model: item.model.replace(/\//g, " / ") });
    assert.equal(selected.matchedModel, record.Model_No);
    for (const installType of ["new", "replacement"]) {
      const systemType = /^non/i.test(record.Configuration1) ? "split" : "ducted";
      const input = { brand: item.brand, model: item.model.replace(/\//g, " / "), postcode: "2145", installType, systemType, escRate: 23, prcRate: 2.6 };
      const server = await production.calculateCurrentNswRebate(input);
      const browser = await frontend.calculate({ ...input, metadata: mapped.metadata, airConditionerType: systemType === "split" ? "non_ducted_single_split_system" : "ducted_single_split_system" });
      assert.equal(server.esc, browser.esc);
      assert.equal(server.prc, browser.prc);
      assert.ok(server.esc + server.prc > 0, `Verified record must calculate for ${item.model}/${installType}`);
    }
  }
  const finalRecord = record;
  record = fixture.models[0].record;
  const invalidIdentityInput = { brand: "Other Brand", model: record.Model_No, postcode: "2145", installType: "new", systemType: "split", escRate: 23, prcRate: 2.6 };
  await assert.rejects(production.calculateCurrentNswRebate(invalidIdentityInput), /Model not found/, "An exact model string cannot bypass the expected brand");
  record = { ...record, Model_No: "TCHV03T1S" };
  await assert.rejects(production.calculateCurrentNswRebate({ ...invalidIdentityInput, brand: "Braemar", model: "TCHV03T1S / DIFFERENT-INDOOR-TEST" }), /Model not found/, "A component-only registration cannot verify a paired system");
  await assert.rejects(production.calculateCurrentNswRebate({ ...invalidIdentityInput, model: "FDCA71VNX-W / FDU71VH" }), /Model not found/, "Catalogue and saved metadata must not cross brand boundaries");
  record = finalRecord;
  for (const postcode of gaps) {
    await assert.rejects(frontend.calculate({ postcode, metadata: complete, installType: "new" }), error => error.message === postcodeDataIssue(postcode));
    await assert.rejects(production.calculateCurrentNswRebate({ brand: fixture.models.at(-1).brand, model: fixture.models.at(-1).model, postcode, installType: "new", systemType: "ducted", escRate: 23, prcRate: 2.6 }), error => error.message === postcodeDataIssue(postcode));
  }
  const gapInput = { brand: fixture.models.at(-1).brand, model: fixture.models.at(-1).model, postcode: "2611", installType: "new", systemType: "ducted", escRate: 23, prcRate: 2.6 };
  const concurrent = await Promise.allSettled([
    frontend.calculate({ postcode: "2611", metadata: complete, installType: "new" }),
    frontend.calculate({ postcode: "2611", metadata: complete, installType: "new" }),
    production.calculateCurrentNswRebate(gapInput), production.calculateCurrentNswRebate(gapInput),
  ]);
  assert.ok(concurrent.every(result => result.status === "rejected" && result.reason.message === postcodeDataIssue("2611")), "Concurrent callers share the same translated rejection");
  backupOutage = true;
  for (const call of [() => frontend.calculate({ postcode: "2611", metadata: complete, installType: "new" }), () => production.calculateCurrentNswRebate(gapInput)]) {
    await assert.rejects(call(), error => error.message.startsWith("HTTP 503"), "A service outage must never become a postcode diagnosis");
  }
} finally { globalThis.fetch = originalFetch; }
console.log("Five exact registered pairs calculate on browser/server in new and replacement modes; 11 unresolved postcode gaps stay unavailable with matching actionable explanations; missing ratings never become zero.");
