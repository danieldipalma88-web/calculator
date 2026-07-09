import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexHtml = readFileSync(path.join(root, "index.html"), "utf8");

function extractConstArray(name) {
  const marker = `const ${name}=`;
  const start = indexHtml.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist in index.html`);
  const arrayStart = indexHtml.indexOf("[", start);
  const arrayEnd = indexHtml.indexOf("];", arrayStart);
  assert.ok(arrayStart > start && arrayEnd > arrayStart, `${name} must be an array literal`);
  return vm.runInNewContext(`(${indexHtml.slice(arrayStart, arrayEnd + 1)})`);
}

const eligibleClasses = extractConstArray("NSW_HVAC_ELIGIBLE_PRODUCT_CLASS_NUMBERS");
const requirements = extractConstArray("NSW_HVAC_EFFICIENCY_REQUIREMENTS");

function requirementForClass(productClass) {
  return requirements.find((req) => req.classes.includes(productClass));
}

function measured(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

function passesMetric(meta, primaryField, primaryMinimum, fallbackField, fallbackMinimum) {
  const primary = measured(meta[primaryField]);
  if (Number.isFinite(primary)) return primary >= primaryMinimum;
  const fallback = measured(meta[fallbackField]);
  return Number.isFinite(fallback) && fallback >= fallbackMinimum;
}

function evaluate(meta, climateZone = "mixed") {
  const productClass = Number(String(meta.productClass || "").match(/\d+/)?.[0]);
  const req = requirementForClass(productClass);
  if (!eligibleClasses.includes(productClass) || !req) return { essEligible: false, prcEligible: false };
  const coolingOk = passesMetric(meta, "tcspfMixed", req.tcspfMixed, "aeer", req.aeer);
  const heatField = climateZone === "cold" ? "hspfCold" : "hspfMixed";
  const heatMinimum = climateZone === "cold" ? req.hspfCold : req.hspfMixed;
  const heatingOk = passesMetric(meta, heatField, heatMinimum, "acop", req.acop);
  return { essEligible: coolingOk && heatingOk, prcEligible: coolingOk };
}

assert.deepEqual(Array.from(eligibleClasses), [5, 6, 7, 8, 9, 10, 11, 12, 18, 19, 20, 21]);
assert.equal(requirementForClass(9).tcspfMixed, 4.5, "Class 9 residential TCSPF_mixed minimum must stay at 4.5.");
assert.equal(requirementForClass(9).hspfMixed, 4.0, "Class 9 residential HSPF_mixed minimum must stay at 4.0.");
assert.equal(requirementForClass(9).hspfCold, 3.5, "Class 9 residential HSPF_cold minimum must stay at 3.5.");
assert.equal(requirementForClass(10).acop, 3.8, "Class 10/11/20 ACOP fallback minimum must stay at 3.8.");
assert.equal(requirementForClass(12).hspfMixed, 2.5, "Class 5/6/7/12/21 residential HSPF_mixed minimum must stay at 2.5.");
assert.equal(requirementForClass(12).acop, 3.5, "Class 5/6/7/12/21 ACOP fallback minimum must stay at 3.5.");

for (const model of [
  { name: "Toshiba RAS-18E2AVG-A/RAS-18E2KVG-A", productClass: "Class 9", tcspfMixed: 4.406, hspfMixed: 3.975, hspfCold: 3.578, aeer: 3.3258, acop: 3.6862 },
  { name: "Fujitsu General AOTG30KMTC/ASTG30KMTC", productClass: "Class 9", tcspfMixed: 4.334, hspfMixed: 3.856, hspfCold: 3.35, aeer: 3.4292, acop: 3.7874 },
  { name: "Fujitsu General AOTG34KMTC/ASTG34KMTC", productClass: "Class 9", tcspfMixed: 4.317, hspfMixed: 3.603, hspfCold: 3.155, aeer: 3.3574, acop: 3.5966 },
]) {
  const result = evaluate(model, "mixed");
  assert.equal(result.essEligible, false, `${model.name} must not create ESC value under the 1 July 2026 NSW HVAC rules.`);
  assert.equal(result.prcEligible, false, `${model.name} must not create PERC value under the 1 July 2026 NSW HVAC rules.`);
}

assert.equal(
  evaluate({ productClass: "Class 9", tcspfMixed: 4.5, hspfMixed: 4.0, hspfCold: 3.5, aeer: 3.6, acop: 3.8 }, "mixed").essEligible,
  true,
  "A Class 9 model on the mixed-zone threshold should remain eligible.",
);

assert.deepEqual(
  evaluate({ productClass: "Class 9", tcspfMixed: 4.5, hspfMixed: 3.9, hspfCold: 3.5, aeer: 3.6, acop: 3.8 }, "mixed"),
  { essEligible: false, prcEligible: true },
  "Cooling eligibility can still allow PERC when ESS heating eligibility fails.",
);

assert.match(indexHtml, /const escEffective=eligibility\.essEligible\?escNum:0;/, "ESC value must use the official NSW result gated by eligibility.");
assert.match(indexHtml, /const prcEffective=eligibility\.prcEligible\?prcNum:0;/, "PERC value must use the official NSW result gated by eligibility.");
assert.doesNotMatch(indexHtml, /const escRaw=/, "ESC must not be rebuilt from intermediate electricity savings fields.");
assert.doesNotMatch(indexHtml, /const prcRaw=/, "PERC must not be rebuilt from intermediate peak-demand fields.");

console.log("nsw hvac rebate rules ok");
