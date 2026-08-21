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
assert.doesNotMatch(calculator, /.selected\.priceMissingProduct/);
assert.match(calculator, /.finalPriceStrip input\.pricePending:disabled\{/);
assert.match(functionSource("addToQuote"), /standardQuotePriceReadiness\(\)/);
assert.match(functionSource("addStandardSystemToQuoteNow"), /standardQuotePriceReadiness\(\)/);
assert.match(functionSource("multiSplitQuoteReadiness"), /multiSplitMissingPriceModels\(totals\)/);
assert.match(functionSource("markOptionWon"), /quoteRowsMissingPriceModels\(rows\)/);
assert.match(functionSource("completeOptionWon"), /quoteRowsMissingPriceModels\(targetRows\)/);
assert.match(functionSource("renderCurrentOptionPanel"), /priceIncompleteNotice/);
assert.match(functionSource("updateQuotePriceValidationUi"), /syncFinalPriceInputAvailability\('finalInc',standardMissing/);
assert.doesNotMatch(functionSource("updateQuotePriceValidationUi"), /priceMissingProduct/);
assert.match(functionSource("render"), /pricingReady=hasPositiveUnitPrice\(x\.unitInc\)/);
assert.match(functionSource("render"), /'Price required'/);
assert.match(functionSource("renderMultiSplitFinancials"), /pricingReady=multiSplitMissingPriceModels\(x\)\.length===0/);
assert.match(calculator, /const priceNotice=missingPriceModels\.length\?[\s\S]*optionCard\$\{isWon\?' wonOption':''\}\$\{missingPriceModels\.length\?' priceIncomplete':''\}/);
assert.match(functionSource("roleUsesPricedCatalogueOnly"), /role==='salesperson'\|\|role==='user'/);
assert.match(functionSource("productVisibleToCurrentUser"), /productHasConfiguredPrice\(p\)/);
assert.match(functionSource("brands"), /selectableProductOptions\(options\)/);
assert.match(functionSource("populateProducts"), /selectableProductOptions\(options\)/);
assert.match(functionSource("refreshBestValueIndicator"), /productVisibleToCurrentUser\(item\.p\)/);
assert.match(functionSource("multiSplitBrands"), /filter\(productVisibleToCurrentUser\)/);
assert.match(functionSource("populateMultiSplitOutdoors"), /productVisibleToCurrentUser\(item\.row\)/);
assert.match(functionSource("multiSplitCompatibleIndoorIndexes"), /productVisibleToCurrentUser\(item\.row\)/);
assert.match(functionSource("loadQuote"), /includeProductIndex:idx/);
assert.match(functionSource("loadMultiSplitQuote"), /includeOutdoorIndex:outdoorIdx/);
assert.match(calculator, /id="pricedCatalogueNotice" class="pricedCatalogueNotice hidden"/);
assert.match(calculator, /Priced catalogue only:<\/strong> Units without a saved price are hidden from this account\./);
assert.match(functionSource("applyOwnerVisibility"), /pricedCatalogueNotice[\s\S]*roleUsesPricedCatalogueOnly\(\)/);

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

const visibilityContext = {window: {CALCULATOR_USER: {role: "salesperson"}}};
vm.runInNewContext(
  [
    functionSource("calculatorUserContext"),
    functionSource("hasPositiveUnitPrice"),
    functionSource("roleUsesPricedCatalogueOnly"),
    functionSource("productHasConfiguredPrice"),
    functionSource("productVisibleToCurrentUser"),
    "result = { productVisibleToCurrentUser };",
  ].join("\n"),
  visibilityContext,
);

assert.equal(visibilityContext.result.productVisibleToCurrentUser({unitPriceInc: 0}), false, "Salespeople must not see zero-priced products.");
assert.equal(visibilityContext.result.productVisibleToCurrentUser({unitPriceInc: 1200}), true, "Salespeople must see priced products.");
visibilityContext.window.CALCULATOR_USER.role = "user";
assert.equal(visibilityContext.result.productVisibleToCurrentUser({priceIncGst: null}), false, "Legacy salesperson accounts must not see unpriced products.");
visibilityContext.window.CALCULATOR_USER.role = "business_owner";
assert.equal(visibilityContext.result.productVisibleToCurrentUser({unitPriceInc: 0}), true, "Business owners must retain the full pricing catalogue.");
visibilityContext.window.CALCULATOR_USER.role = "admin";
assert.equal(visibilityContext.result.productVisibleToCurrentUser({unitPriceInc: 0}), true, "Platform admins must retain the full pricing catalogue.");

console.log("Unit-price quote and won-job guards verified.");
