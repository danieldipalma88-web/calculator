import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const calculator = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

function functionSource(name) {
  const start = calculator.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing ${name}`);
  let depth = 0;
  let opened = false;
  for (let index = start; index < calculator.length; index += 1) {
    if (calculator[index] === "{") {
      depth += 1;
      opened = true;
    } else if (calculator[index] === "}") {
      depth -= 1;
      if (opened && depth === 0) return calculator.slice(start, index + 1);
    }
  }
  throw new Error(`Could not parse ${name}`);
}

assert.match(calculator, /id="unitPriceCostField" class="priceRequiredField"/);
assert.match(calculator, /id="multiUnitPriceCostField" class="priceRequiredField"/);
assert.match(calculator, /.priceRequiredField\.priceMissing input\{/);
assert.match(functionSource("addToQuote"), /standardQuotePriceReadiness\(\)/);
assert.match(functionSource("addStandardSystemToQuoteNow"), /standardQuotePriceReadiness\(\)/);
assert.match(functionSource("multiSplitQuoteReadiness"), /multiSplitMissingPriceModels\(totals\)/);
assert.match(functionSource("markOptionWon"), /quoteRowsMissingPriceModels\(rows\)/);
assert.match(functionSource("completeOptionWon"), /quoteRowsMissingPriceModels\(targetRows\)/);
assert.match(functionSource("renderCurrentOptionPanel"), /priceIncompleteNotice/);
assert.match(calculator, /const priceNotice=missingPriceModels\.length\?[\s\S]*optionCard\$\{isWon\?' wonOption':''\}\$\{missingPriceModels\.length\?' priceIncomplete':''\}/);

const context = {};
vm.runInNewContext(
  [
    functionSource("hasPositiveUnitPrice"),
    functionSource("uniquePriceModels"),
    functionSource("isMultiHeadQuoteType"),
    functionSource("quoteRowMissingPriceModels"),
    "result = { quoteRowMissingPriceModels };",
  ].join("\n"),
  context,
);

assert.deepEqual(
  [...context.result.quoteRowMissingPriceModels({ type: "Split", model: "ZERO-MODEL", unitInc: 0 })],
  ["ZERO-MODEL"],
  "A zero-priced standard unit must be identified.",
);
assert.deepEqual(
  [...context.result.quoteRowMissingPriceModels({ type: "Split", model: "PAID-MODEL", unitInc: 1200 })],
  [],
  "A positive standard unit price must pass.",
);
assert.deepEqual(
  [...context.result.quoteRowMissingPriceModels({
    type: "Multi-head Split",
    model: "OUTDOOR + HEADS",
    unitInc: 2500,
    state: {
      systemType: "multi_split",
      outdoorModel: "OUTDOOR",
      outdoorUnitPriceInc: 2000,
      indoorHeads: [
        { model: "HEAD-25", qty: 1, unitPriceInc: 500 },
        { model: "HEAD-35", qty: 1, unitPriceInc: 0 },
      ],
    },
  })],
  ["HEAD-35"],
  "A missing multi-head component price must be named exactly.",
);

console.log("Unit-price quote and won-job guards verified.");
