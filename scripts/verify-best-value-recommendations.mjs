import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

const rebateStart = html.indexOf("function recommendationEffectiveRebate");
const rebateEnd = html.indexOf("function recommendationRebateBasis", rebateStart);
assert.ok(rebateStart >= 0 && rebateEnd > rebateStart, "could not isolate recommendation rebate helper");

const rebateSandbox = {
  systemType: "split",
  manual: false,
  match: { rate: 30 },
  matchedPostcode: "",
  applyCalls: 0,
};
rebateSandbox.hasManualRebateOverride = () => rebateSandbox.manual;
rebateSandbox.getDcceewContractMatch = (_product, postcode) => {
  rebateSandbox.matchedPostcode = postcode;
  return rebateSandbox.match;
};
rebateSandbox.applyDcceewContractRebate = (match, result) => {
  rebateSandbox.applyCalls += 1;
  const standard = Number(result.escValue) + Number(result.prcValue);
  if (!match) return { ...result, rebate: standard, contractApplied: false, contractUplift: 0 };
  const rebate = Number(result.esc) * Number(match.rate) + Number(result.prcValue);
  return { ...result, rebate, contractApplied: true, contractUplift: rebate - standard };
};
vm.runInNewContext(
  `${html.slice(rebateStart, rebateEnd)}\nglobalThis.__recommendationRebate=recommendationEffectiveRebate;`,
  rebateSandbox,
);

const certificateResult = {
  esc: 8.61,
  prc: 45.82,
  escRate: 24,
  prcRate: 2.7,
  escValue: 206.64,
  prcValue: 123.714,
};
const contractResult = rebateSandbox.__recommendationRebate(
  { brand: "Fujitsu General", model: "AOTG09KMTC/ASTG09KMTC" },
  certificateResult,
  "2163",
);
assert.equal(Number(contractResult.rebate.toFixed(2)), 382.01, "recommendations must rank an eligible candidate using the $30 ESC contract rate");
assert.equal(contractResult.rebateSource, "contract", "contract recommendation must disclose its rebate basis");
assert.equal(rebateSandbox.matchedPostcode, "2163", "candidate contract matching must use the selected postcode");

rebateSandbox.manual = true;
const applyCallsBeforeManual = rebateSandbox.applyCalls;
const manualResult = rebateSandbox.__recommendationRebate(
  { brand: "Example", model: "MANUAL", rebate: 444.4 },
  certificateResult,
  "2163",
);
assert.equal(manualResult.rebate, 444.4, "manual candidate rebate must be respected by recommendations");
assert.equal(manualResult.rebateSource, "manual", "manual recommendation must disclose its rebate basis");
assert.equal(rebateSandbox.applyCalls, applyCallsBeforeManual, "manual rebate must not be replaced by contract or live rebate math");

rebateSandbox.manual = false;
rebateSandbox.match = null;
const standardResult = rebateSandbox.__recommendationRebate(
  { brand: "Example", model: "STANDARD" },
  certificateResult,
  "2002",
);
assert.equal(Number(standardResult.rebate.toFixed(2)), 330.35, "standard recommendation rebate changed unexpectedly");
assert.equal(standardResult.rebateSource, "standard", "standard recommendation must disclose its rebate basis");

const scopeStart = html.indexOf("function recommendationPhaseValue");
const scopeEnd = html.indexOf("function recommendationScopeLabel", scopeStart);
assert.ok(scopeStart >= 0 && scopeEnd > scopeStart, "could not isolate recommendation scope helpers");
const scopeSandbox = {
  cap: (product) => Number(product.capacityNum),
  kwCategoryValue: (value) => Math.floor((Number(value) + 1e-9) * 2) / 2,
};
vm.runInNewContext(
  `${html.slice(scopeStart, scopeEnd)}\nglobalThis.__matches=recommendationCandidateMatchesScope;`,
  scopeSandbox,
);
const selectedDucted = { capacityNum: 14, phase: "Single" };
assert.equal(scopeSandbox.__matches(selectedDucted, { capacityNum: 14.1, phase: "Single" }, 14, "ducted"), true, "same-phase ducted candidate should be comparable");
assert.equal(scopeSandbox.__matches(selectedDucted, { capacityNum: 14, phase: "Three" }, 14, "ducted"), false, "three-phase ducted candidate must not replace a single-phase recommendation");
assert.equal(scopeSandbox.__matches({ capacityNum: 7.1 }, { capacityNum: 7, phase: "Three" }, 7, "split"), true, "split recommendations should not apply a phase filter");

assert.match(html, /calculateRecommendationCandidate\(item,postcode\)/, "candidate comparison does not use the effective rebate pipeline");
assert.match(html, /hasManualRebateOverride\(systemType,p\)\?null:await estimateLiveEssRebate/, "manual candidates still make unnecessary live rebate requests");
assert.match(html, /activeBusinessName\(\).*activeBusinessState\(\).*candidateSignature/s, "recommendation cache is not scoped to business and current prices");
assert.match(html, /invalidateBestValueRecommendations\(true\);\s*syncCurrentProductAfterPriceChange/, "price edits do not invalidate recommendation results");
assert.match(html, /populateProducts\(\{skipProductChange:true\}\);\s*\$\('product'\)\.value=String\(idx\);\s*onProductChange\(\);/, "recommended unit loading still calculates an intermediate brand default");
assert.match(html, /setSystem\(s\.systemType\|\|'split',\{skipProductChange:true\}\)/, "saved quote loading still starts an intermediate product calculation");
assert.match(html, /setInstall\(s\.installType\|\|'new',\{skipRefresh:true\}\);\s*onProductChange\(\{skipAsyncRefresh:true\}\);/, "saved quote state is not applied atomically before recalculation");
assert.match(html, /DCCEEW \$30 ESC rate/, "recommendation card does not disclose the contract rebate basis");

const refreshStart = html.indexOf("async function refreshBestValueIndicator");
const refreshEnd = html.indexOf("function hasManualRebateOverride", refreshStart);
const refreshSource = html.slice(refreshStart, refreshEnd);
assert.ok(refreshSource.indexOf("const requestId=++essBestValueRuntime.requestSeq") < refreshSource.indexOf("const cached=essBestValueRuntime.cache"), "cached refreshes do not cancel older recommendation requests");

console.log("best value recommendation checks ok");
