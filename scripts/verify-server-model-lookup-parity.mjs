import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import engine from "../services/nsw-rebate-backup/api/calculate.mjs";
import { createFrontendCalculator } from "./monitor-nsw-postcodes-helpers.mjs";

register("./monitor-nsw-postcodes-loader.mjs", import.meta.url);
const { createGemsCalculationMetadata } = await import("../lib/gems-calculation-metadata.ts");
const { GEMS_VERIFIED_INVENTORY_SOURCE, GEMS_AIRCON_RESOURCE_IDS } = await import("../lib/gems-model-search.ts");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const fixture = JSON.parse(await readFile(new URL("./fixtures/gems-gap-regressions-20261106.json", import.meta.url), "utf8"));
const tcl = JSON.parse(await readFile(new URL("./fixtures/tcl-gems-rounding-20261112.json", import.meta.url), "utf8"));
const tclRecords = tcl.records.map(({ resource, record }) => ({ ...record, [GEMS_VERIFIED_INVENTORY_SOURCE]: resource }));
const models = [...fixture.models, {
  brand: "TCL", model: tcl.model,
  record: tclRecords.find(record => record[GEMS_VERIFIED_INVENTORY_SOURCE] === GEMS_AIRCON_RESOURCE_IDS[1]),
}];
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).join("\n");
const ast = ts.createSourceFile("calculator.js", script, ts.ScriptTarget.Latest, true);
const names = new Set(["recordValue", "gemsRecordBrand", "gemsRecordModel", "modelMetaFromGemsRecord"]);
const mapping = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map(node => node.getText(ast));
assert.equal(mapping.length, names.size);
const legacy = vm.createContext({});
vm.runInContext(mapping.join("\n"), legacy);
const now = Date.parse(fixture.capturedAt ?? "2026-11-06T00:00:00Z");
const lookup = createGemsCalculationMetadata({
  now: () => now,
  fetchInventory: async brands => [...fixture.models.map(item => item.record), ...tclRecords]
    .filter(record => brands.includes(record.Brand.toLowerCase())),
});
let externalAttempts = 0;
const frontend = await createFrontendCalculator({ indexHtml: html, fetch: async (url, init) => {
  if (String(url).includes("of-sfg-rac-prd.energy.nsw.gov.au")) { externalAttempts++; throw new TypeError("Simulated expired upstream certificate"); }
  assert.equal(new URL(url).hostname, "rebate-portal-nsw-backup.vercel.app", "No external network is permitted");
  return engine.fetch(new Request(url, init));
} });
let cases = 0;
for (const item of models) {
  const result = await lookup(item.brand, item.model);
  const before = legacy.modelMetaFromGemsRecord(item.record);
  for (const [field, value] of Object.entries(before)) assert.equal(result.meta[field], value, `${item.model}: ${field} must be unchanged`);
  const system = /^non/i.test(item.record.Configuration1) ? "non_ducted_single_split_system" : "ducted_single_split_system";
  for (const postcode of ["2145", "2213", "2550", "2575", "2756"]) {
    for (const installType of ["new", "replacement"]) {
      const input = { postcode, installType, airConditionerType: system };
      const oldResult = await frontend.calculate({ ...input, metadata: before });
      const newResult = await frontend.calculate({ ...input, metadata: result.meta });
      assert.equal(newResult.esc, oldResult.esc, `${item.model}/${postcode}/${installType}: ESC`);
      assert.equal(newResult.prc, oldResult.prc, `${item.model}/${postcode}/${installType}: PRC`);
      assert.ok(Number.isFinite(newResult.esc) && Number.isFinite(newResult.prc));
      assert.equal(newResult.esc * 23 + newResult.prc * 2.6, oldResult.esc * 23 + oldResult.prc * 2.6);
      cases++;
    }
  }
}
assert.equal(cases, 60);
assert.ok(externalAttempts > 0, "Primary outage must exercise the verified backup engine");
console.log(`${cases} model/postcode/install cases preserve metadata, ESC/PRC counts and payout arithmetic during a primary outage. No network or quote/price writes.`);
