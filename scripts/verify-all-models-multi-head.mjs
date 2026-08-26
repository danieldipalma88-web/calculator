import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "index.html"), "utf8");
const route = readFileSync(
  path.join(root, "app", "api", "gems-model-search", "route.ts"),
  "utf8",
);

assert.match(html, /id="allModelsSingleModeBtn"[^>]+setAllModelsMode\('single'\)/);
assert.match(html, /id="allModelsMultiModeBtn"[^>]+setAllModelsMode\('multi'\)/);
assert.match(html, /id="allModelsMultiBrand"/);
assert.match(html, /id="allModelsMultiOutdoor"/);
assert.match(html, /id="allModelsMultiRows"/);
assert.match(html, /id="allModelsMultiCompatibility"/);

assert.match(
  html,
  /function allModelsMultiAvailableIndoorIndexes\(outdoor\)[\s\S]*ALL_MODELS_MULTI_INDOORS[\s\S]*\.filter\(item=>outdoor&&brandsEquivalent\(item\.row\.brand,outdoor\.brand\)\)/,
  "The rebate-only lookup must expose only verified indoor heads for the selected outdoor brand.",
);
assert.match(html, /"Samsung Electronics":"Samsung"/);
assert.match(html, /"Emerald Energy":"Emerald"/);
assert.match(html, /No verified current indoor heads are loaded for/);
assert.match(html, /will not substitute heads from another brand/);
for (const model of ["AS20PBDHRA", "AS26PBDHRA", "AS35PBDHRA", "AS53PDDHRA", "AS71QEFHRA"]) {
  assert.match(html, new RegExp(`multiIndoor\\('Haier',[^\\n]+${model}`), `${model} must be available in the rebate-only Haier indoor register.`);
}
const pricedIndoorCatalogue = html.slice(
  html.indexOf("const MULTI_SPLIT_INDOORS="),
  html.indexOf("const ALL_MODELS_MULTI_EXTRA_INDOORS="),
);
assert.doesNotMatch(pricedIndoorCatalogue, /multiIndoor\('Haier'/, "Unpriced Haier heads must not leak into the normal quote catalogue.");
assert.match(html, /const ALL_MODELS_MULTI_INDOORS=\[\.\.\.MULTI_SPLIT_INDOORS,\.\.\.ALL_MODELS_MULTI_EXTRA_INDOORS\]/);

const combinedIndoorCatalogue = html.slice(
  html.indexOf("const MULTI_SPLIT_INDOORS="),
  html.indexOf("const ALL_MODELS_MULTI_INDOORS="),
);
const indoorRows = [...combinedIndoorCatalogue.matchAll(/multiIndoor\('([^']+)'\s*,\s*'([^']+)'\s*,\s*([0-9.]+)\s*,\s*'([^']+)'/g)]
  .map(([, brand, series, capacity, model]) => ({ brand, series, capacity: Number(capacity), model }));
assert.ok(indoorRows.length >= 250, `Expected at least 250 verified indoor heads, found ${indoorRows.length}.`);
const brandCounts = indoorRows.reduce((counts, row) => {
  counts[row.brand] = (counts[row.brand] || 0) + 1;
  return counts;
}, {});
for (const [brand, minimum] of Object.entries({
  "Actron Air": 13,
  Carrier: 13,
  Daikin: 19,
  Emerald: 3,
  "Fujitsu General": 7,
  Gree: 20,
  Haier: 19,
  Hisense: 9,
  Kaden: 13,
  LG: 5,
  Midea: 8,
  "Mitsubishi Electric": 40,
  "Mitsubishi Heavy Industries": 15,
  Panasonic: 20,
  Rinnai: 13,
  Samsung: 7,
  TCL: 12,
  Teco: 10,
})) {
  assert.ok((brandCounts[brand] || 0) >= minimum, `${brand} must retain at least ${minimum} verified indoor heads.`);
}
const indoorKeys = indoorRows.map(row => `${row.brand}|${row.model}`.toLowerCase());
assert.equal(new Set(indoorKeys).size, indoorKeys.length, "The indoor register must not contain duplicate brand/model pairs.");

const extraIndoorCatalogue = html.slice(
  html.indexOf("const ALL_MODELS_MULTI_EXTRA_INDOORS="),
  html.indexOf("const ALL_MODELS_MULTI_INDOORS="),
);
for (const line of extraIndoorCatalogue.split(/\r?\n/).filter(line => line.includes("multiIndoor("))) {
  assert.match(line, /ratedCoolingCapacity:[0-9.]+/, "Every rebate-only indoor head must have a verified rated cooling capacity.");
  assert.match(line, /ratedHeatingCapacity:[0-9.]+/, "Every rebate-only indoor head must have a verified rated heating capacity.");
}
assert.match(html, /id="allModelsMultiHeadSearch\$\{index\}"[^>]+type="search"/);
assert.match(html, /placeholder="Search model code, brand or size"/);
assert.match(html, /function filterAllModelsMultiHeadOptions\(index,value\)/);
assert.match(html, /function allModelsMultiMatchingIndoorIndexes\(outdoor,query\)/);
assert.match(html, /function allModelsMultiSelectedIndoorIndex\(selection\)/);
assert.match(html, /else\{\s*selection\.indoorIndex=null;\s*resetAllModelsResult\(/);
assert.match(
  html,
  /available\.includes\(previousIndex\)\?previousIndex:available\[0\]/,
  "Adding another head must reuse the previously selected indoor model.",
);
assert.match(html, /Compatibility is not verified/);
assert.match(html, /A rebate result does not confirm equipment compatibility/);
assert.match(html, /Manufacturer check/);
assert.match(html, /ALL_MODELS_MULTI_TECHNICAL_HEAD_CAP/);
assert.match(html, /totals\.headCount>=effectiveLimit/);
assert.match(html, /hasKnownHeadLimit&&totals\.headCount>headLimit/);
assert.match(html, /The rebate calculation will use the outdoor unit limit/);
assert.match(html, /The rebate calculation will use the connected indoor capacity/);
assert.match(html, /\/api\/gems-model-search\?mode=multi-brands/);
assert.match(html, /mode=multi-outdoors&brand=/);
assert.match(route, /mode === "multi-brands"/);
assert.match(route, /mode === "multi-outdoors"/);
assert.match(route, /fetchGemsMultiSplitRecords/);

assert.match(html, /if\(allModelsMode==='multi'\) return calculateAllModelsMultiRebate\(\)/);
assert.match(html, /const capacityInputs=multiSplitCertificateInputs\(resolved\.meta,totals\.indoorItems\)/);
assert.match(html, /airConditionerType:'non_ducted_multi_split_system'/);
assert.match(html, /coolingCapacity:capacityInputs\.coolingCapacity/);
assert.match(html, /heatingCapacity:capacityInputs\.heatingCapacity/);
assert.match(html, /inputPower:capacityInputs\.inputPower/);
assert.match(
  html,
  /getDcceewContractMatch\(\{brand:outdoor\.brand,model:outdoor\.rebateModel\|\|outdoor\.model\},postcode\)/,
);
assert.match(html, /renderAllModelsCalculationError\(error\)/);
assert.match(html, /Rebate set to \$0\.00 because the calculation could not be completed/);

const allModelsSection = html.slice(
  html.indexOf('<div class="allModelsCard"'),
  html.indexOf('<div class="currentOptionPanel card"'),
);
assert.doesNotMatch(allModelsSection, /onclick="addToQuote\(/);
assert.doesNotMatch(allModelsSection, /unitPriceInc|finalInc|Add to Quote/);
assert.match(html, /\.allModelsMultiRow\{grid-template-columns:1fr;/);
assert.match(html, /\.allModelsMultiSummary\{grid-template-columns:1fr\}/);

console.log("All Models multi-head lookup verification passed.");
