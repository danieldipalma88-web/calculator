import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexHtml = readFileSync(path.join(root, "index.html"), "utf8");
const approvalHtml = readFileSync(path.join(root, "public", "multi-head-calculation-approval.html"), "utf8");

function extractBalanced(source, start, openChar, closeChar) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === openChar) depth += 1;
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unable to extract balanced ${openChar}${closeChar} block.`);
}

function extractFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist.`);
  const bodyStart = source.indexOf("{", start);
  const body = extractBalanced(source, bodyStart, "{", "}");
  return source.slice(start, bodyStart) + body;
}

function extractAssignedLiteral(source, marker, openChar, closeChar) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${marker} must exist.`);
  const literalStart = source.indexOf(openChar, start + marker.length);
  return extractBalanced(source, literalStart, openChar, closeChar);
}

const helperSource = extractFunction(indexHtml, "multiSplitCertificateInputs");
const context = {
  toNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : NaN;
  },
};
vm.runInNewContext(`${helperSource}; this.calculateInputs = multiSplitCertificateInputs;`, context);
const calculateInputs = context.calculateInputs;

const outdoorMeta = { "Cooling Capacity": 7, "Heating Capacity": 8, "Input Power": 2.1 };
const item = (cooling, heating, qty = 1) => ({ row: { ratedCoolingCapacity: cooling, ratedHeatingCapacity: heating, model: "TEST" }, qty });

const underConnected = calculateInputs(outdoorMeta, [item(2, 2.8), item(2.5, 3.2)]);
assert.equal(underConnected.indoorCooling, 4.5);
assert.equal(underConnected.indoorHeating, 6);
assert.equal(underConnected.coolingCapacity, 4.5, "Under-connected cooling must use the indoor total.");
assert.equal(underConnected.heatingCapacity, 6, "Under-connected heating must use the indoor total.");
assert.equal(underConnected.coolingRatio, 4.5 / 7);
assert.ok(Math.abs(underConnected.inputPower - 1.35) < 1e-12, "PDRS input power must scale by the cooling connection ratio.");

const exactlyMatched = calculateInputs(outdoorMeta, [item(7, 8)]);
assert.equal(exactlyMatched.coolingCapacity, 7);
assert.equal(exactlyMatched.heatingCapacity, 8);
assert.equal(exactlyMatched.inputPower, 2.1);

const overConnected = calculateInputs(outdoorMeta, [item(5, 6), item(3.5, 4)]);
assert.equal(overConnected.coolingCapacity, 7, "Over-connected cooling must be capped at outdoor capacity.");
assert.equal(overConnected.heatingCapacity, 8, "Over-connected heating must be capped at outdoor capacity.");
assert.equal(overConnected.coolingRatio, 1);
assert.equal(overConnected.inputPower, 2.1, "Over-connected systems must not exceed full outdoor input power.");

assert.throws(
  () => calculateInputs(outdoorMeta, [{ row: { model: "UNRATED" }, qty: 1 }]),
  /Manufacturer-rated cooling and heating capacity is unavailable/,
  "Unrated indoor units must be rejected rather than estimated silently.",
);

const capacityMapSource = extractAssignedLiteral(indexHtml, "const MULTI_SPLIT_INDOOR_RATED_CAPACITIES=", "{", "}");
const capacityMap = vm.runInNewContext(`(${capacityMapSource})`);
const indoorArraySource = extractAssignedLiteral(indexHtml, "const MULTI_SPLIT_INDOORS=", "[", "]");
const indoors = vm.runInNewContext(`(${indoorArraySource})`, {
  multiIndoor(brand, series, capacityNum, model, unitPriceInc, pipe, dimensions, extra) {
    return Object.assign({ brand, series, capacityNum, model, unitPriceInc, pipe, dimensions }, extra || {});
  },
});
for (const indoor of indoors.filter((row) => row.family !== "daikin-cooling-only")) {
  const rated = capacityMap[indoor.model];
  assert.ok(rated, `${indoor.model} must have manufacturer-rated cooling and heating capacities.`);
  assert.ok(Number(rated[0]) > 0 && Number(rated[1]) > 0, `${indoor.model} capacities must both be positive.`);
}

assert.match(indexHtml, /coolingCapacity:capacityInputs\.coolingCapacity/);
assert.match(indexHtml, /heatingCapacity:capacityInputs\.heatingCapacity/);
assert.match(indexHtml, /inputPower:capacityInputs\.inputPower/);
assert.match(indexHtml, /const inputPower=outdoorInputPower\*coolingRatio;/);
assert.match(approvalHtml, /function multiSplitCertificateInputs\(meta,indoorItems\)/);
assert.match(approvalHtml, /Multi-split capacity rule/);
assert.match(approvalHtml, /inputPower:capacityInputs\.inputPower/);

console.log("multi-split capacity rules ok");
