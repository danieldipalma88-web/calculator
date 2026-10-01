import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const raw = fs.readFileSync(new URL("../app/calculator/raw/route.ts", import.meta.url), "utf8");
const api = fs.readFileSync(new URL("../app/api/calculator-data/route.ts", import.meta.url), "utf8");
const matcher = html.slice(html.indexOf("let dcceewPostcodeSet=null;"), html.indexOf("function dcceewSignedMoney"));
const recommendationSignature = html.slice(html.indexOf("function dcceewRecommendationSignature()"), html.indexOf("function bestValueCacheKey("));
const oldData = { rate: 30, postcodes: [2208], productKeys: ["DAIKIN|RXV50WVMAFTXV50WVMA"] };
const currentData = { ...oldData, postcodes: [2311] };
const fields = new Map([
  ["rebate", { value: "1146.81" }],
  ["allModelsRebateTotal", { textContent: "-" }],
  ["allModelsCalculateBtn", { getAttribute: () => "false" }],
  ["multiSplitRebatePanel", { getAttribute: () => "false" }],
]);
const draft = { unitPrice: 1335, labour: 500, finalPrice: 14000.05, quotes: [{ id: "saved", rebate: 1146.81 }] };
const draftBefore = JSON.stringify(draft);
const calls = [];
const sandbox = {
  window: { DCCEEW_CONTRACT_DATA: oldData },
  state: "NSW", postcode: "2208", systemType: "split", installType: "replacement",
  activeCalculatorView: "standard", multiSplitHasCalculated: false, multiSplitTrialRequestSeq: 1,
  essCache: { requestSeq: 1 }, essRuntime: { lastEsc: 21.429, lastPrc: 0 },
  $: (id) => fields.get(id),
  rebatesEnabled: () => true,
  activeBusinessState: () => sandbox.state,
  getEssPostcode: () => sandbox.postcode,
  product: () => ({ brand: "Daikin", model: "RXV50WVMA / FTXV50WVMA" }),
  hasManualRebateOverride: () => false,
  invalidateBestValueRecommendations: () => calls.push("invalidate"),
  setLiveRebateLoading: () => calls.push("clear-standard-loading"),
  setSectionLoading: () => calls.push("clear-multi-loading"),
  setDcceewContractDisplay: (match) => calls.push(match ? "gold" : "standard"),
  updateCertificateBreakdownFromRuntime: () => sandbox.__match() ? 1146.81 : 1026.80,
  setRebateCalcMeta: () => {}, render: () => calls.push("render"),
  resetMultiSplitRebateMetrics: () => calls.push("reset-multi"),
  resetAllModelsResult: () => calls.push("reset-all"),
  refreshLiveRebateForCurrentProduct: () => calls.push("refresh-standard"),
  refreshBestValueIndicator: () => calls.push("refresh-best"),
  calculateAllModelsRebate: () => calls.push("refresh-all"),
  calculateMultiSplitTrialRebate: () => calls.push("refresh-multi"),
};
vm.runInNewContext(`${matcher}\n${recommendationSignature}\nglobalThis.__match=getDcceewContractMatch; globalThis.__signature=dcceewRecommendationSignature;`, sandbox);
const apply = sandbox.window.applyAuthoritativeDcceewContractData;
assert.ok(sandbox.__match(), "fixture must reproduce a cached old 2208 match");
const oldSignature = sandbox.__signature();
assert.equal(apply(currentData), true);
assert.equal(sandbox.__match(), null, "2208 must lose its cached gold match without reload");
assert.equal(fields.get("rebate").value, "1026.80", "current rebate must revert to standard rate");
assert.ok(calls.includes("standard") && calls.includes("refresh-best"));
assert.ok(!calls.includes("refresh-standard"), "existing certificate counts must reprice immediately without another lookup");
assert.notEqual(sandbox.__signature(), oldSignature, "equal-size list changes must invalidate recommendation keys");
assert.equal(JSON.stringify(draft), draftBefore, "draft prices and saved quotes must not change");
assert.equal(sandbox.essCache.requestSeq, 2, "old in-flight single result must be invalidated");
assert.equal(sandbox.multiSplitTrialRequestSeq, 2, "old in-flight multi result must be invalidated");
calls.length = 0;
assert.equal(apply(currentData), false);
assert.equal(calls.length, 0, "unchanged sync must do no recalculation");
for (const invalid of [null, {}, { ...currentData, rate: "30" }, { ...currentData, rate: Infinity }, { ...currentData, postcodes: [2311, 2311] }, { ...currentData, postcodes: [NaN] }, { ...currentData, productKeys: ["<script>"] }]) {
  assert.equal(apply(invalid), false, "malformed data must not replace verified rules");
}
assert.equal(sandbox.window.DCCEEW_CONTRACT_DATA.postcodes[0], 2311);
sandbox.postcode = "2311";
assert.ok(sandbox.__match(), "approved regional postcode must still match");
assert.equal(sandbox.__match(undefined, undefined, { systemType: "ducted", installType: "new" }), null);
assert.equal(apply({ ...currentData, productKeys: ["DAIKIN|OTHERMODEL"] }), true);
assert.equal(sandbox.__match(), null, "equal-size product replacement must clear cached keys");
assert.equal(apply(currentData), true);
sandbox.state = "QLD";
assert.equal(sandbox.__match(), null, "updates must retain NSW-only restriction");
sandbox.state = "NSW";

for (const view of ["multiSplit", "allModels"]) {
  sandbox.activeCalculatorView = view;
  sandbox.multiSplitHasCalculated = view === "multiSplit";
  fields.get("allModelsRebateTotal").textContent = view === "allModels" ? "$1,026.80" : "-";
  calls.length = 0;
  assert.equal(apply(oldData), true);
  assert.ok(calls.includes(view === "multiSplit" ? "refresh-multi" : "refresh-all"), `${view} must automatically recalculate`);
  apply(currentData);
}
sandbox.multiSplitHasCalculated = false;
sandbox.activeCalculatorView = "multiSplit";
fields.get("multiSplitRebatePanel").getAttribute = () => "true";
calls.length = 0;
apply(oldData);
assert.ok(calls.includes("refresh-multi"), "first multi calculation must restart if rules change in flight");
assert.equal(apply({ rate: 30, postcodes: [], productKeys: [] }), true, "an empty approved list must safely disable all matches");
assert.equal(sandbox.__match(), null);

// Execute the actual sync bridge, including its fetch options and in-flight guard.
const refreshStart = raw.indexOf("  function refreshAuthoritativeCertificateValues(){");
const refreshEnd = raw.indexOf("  function stripCertificateRatesFromStoredEssValue", refreshStart);
let response = { dcceewContract: currentData, data: { certificate: "rates" } };
const bridgeCalls = [];
const bridge = {
  certificateRefreshInFlight: false, calculatorSyncUrl: "/api/calculator-data",
  window: { applyAuthoritativeDcceewContractData: (data) => bridgeCalls.push(["contract", data]) },
  fetch: async (url, options) => {
    assert.equal(url, "/api/calculator-data");
    assert.equal(options.cache, "no-store");
    return { ok: true, json: async () => response };
  },
  authoritativeCertificateValue: (data) => data ? { key: "certificate", value: data.certificate } : null,
  setCloudValue: (...args) => bridgeCalls.push(args),
};
vm.runInNewContext(`${raw.slice(refreshStart, refreshEnd)}\nglobalThis.refresh=refreshAuthoritativeCertificateValues;`, bridge);
bridge.refresh();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(bridgeCalls[0][0], "contract", "sync must apply contract rules before updating spot prices");
assert.equal(bridgeCalls[1][1], "rates", "existing spot-price refresh must be preserved");
assert.equal(bridge.certificateRefreshInFlight, false);
response = { data: { certificate: "unchanged" } };
bridge.refresh();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(bridgeCalls.at(-1)[1], "unchanged", "bridge must remain backward compatible");
bridge.window.applyAuthoritativeRebateSettings = (...args) => bridgeCalls.push(["settings", ...args]);
response = { dcceewContract: currentData, data: { certificate: "new-rates" } };
bridge.refresh();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(bridgeCalls.at(-2)[0], "settings", "new clients must apply both settings atomically");
assert.equal(bridgeCalls.at(-2)[2], "new-rates");

// Run the real handlers, reset and asynchronous All Models calculation together.
const attributes = new Map();
const button = {
  textContent: "Calculate rebate", disabled: false,
  getAttribute: (name) => attributes.get(name),
  setAttribute: (name, value) => attributes.set(name, value),
  removeAttribute: (name) => attributes.delete(name),
};
fields.set("allModelsCalculateBtn", button);
fields.set("allModelsPostcode", { value: "2208" });
const pending = [];
const displayed = [];
Object.assign(sandbox, {
  allModelsCalculationRequestSeq: 0, allModelsMode: "single", allModelsInstallType: "replacement",
  allModelsSelected: { brand: "Daikin", model: "RXV50WVMA / FTXV50WVMA", completeEnergyData: true, metadata: {} },
  certValues: { escRate: 24.4, prcRate: 2.9 },
  normalizeCertValues: value => value, certValuesSignature: JSON.stringify,
  persistCertValues: () => {}, applyLockedCertValuesToMain: () => {},
  updateAllModelsRates: () => {}, updateAllModelsCalculateState: () => { button.disabled = false; },
  isUsableModelMeta: () => true, allModelsAirConditionerType: () => "non_ducted_single_split_system",
  allModelsCalculationContext: () => ({ systemType: "split", installType: "replacement" }),
  getClimateContext: async postcode => ({ postcode, climateZone: "mixed", bcaZone: "BCA_Climate_Zone_5" }),
  calculateCertificatesForModel: () => new Promise(resolve => pending.push(resolve)),
  withTimeout: promise => promise, LIVE_REBATE_TIMEOUT_MS: 20000,
  getEssEscRate: () => sandbox.certValues.escRate, getEssPrcRate: () => sandbox.certValues.prcRate,
  renderAllModelsCalculation: (result, effective, match) => {
    displayed.push({ result, effective, match });
    fields.get("allModelsRebateTotal").textContent = effective.rebate.toFixed(2);
  },
  renderAllModelsCalculationError: error => assert.fail(error.message),
});
const certificateHandler = html.slice(html.indexOf("window.applyAuthoritativeCertificateValues=function"), html.indexOf("function applyLockedCertValuesToMain"));
const resetHandler = html.slice(html.indexOf("function resetAllModelsResult("), html.indexOf("function selectedAllModelsMultiOutdoor("));
const calculation = html.slice(html.indexOf("async function calculateAllModelsRebate("), html.indexOf("function initAllModelsLookup("));
const pricing = html.slice(html.indexOf("function applyDcceewContractRebate("), html.indexOf("function setCertificateBreakdown("));
vm.runInNewContext(`${certificateHandler}\n${resetHandler}\n${pricing}\n${calculation}`, sandbox);
sandbox.activeCalculatorView = "allModels";
sandbox.window.DCCEEW_CONTRACT_DATA = oldData;
const first = sandbox.calculateAllModelsRebate();
await new Promise(resolve => setImmediate(resolve));
assert.equal(pending.length, 1);
assert.equal(button.getAttribute("aria-busy"), "true");
sandbox.window.applyAuthoritativeRebateSettings(currentData, JSON.stringify({ escRate: 23.4, prcRate: 3 }));
await new Promise(resolve => setImmediate(resolve));
assert.equal(pending.length, 2, "combined settings must start exactly one replacement calculation");
pending[0]({ esc: 10, prc: 100 });
await first;
assert.equal(displayed.length, 0, "old in-flight uplift must never repaint");
pending[1]({ esc: 10, prc: 100 });
await new Promise(resolve => setImmediate(resolve));
assert.equal(displayed.length, 1);
assert.equal(displayed[0].match, null);
assert.equal(displayed[0].effective.rebate, 534);
assert.equal(button.getAttribute("aria-busy"), undefined);
assert.equal(button.textContent, "Calculate rebate");
assert.equal(button.disabled, false);
const hiddenCalculation = sandbox.calculateAllModelsRebate();
await new Promise(resolve => setImmediate(resolve));
sandbox.activeCalculatorView = "standard";
sandbox.window.applyAuthoritativeDcceewContractData(oldData);
assert.equal(button.getAttribute("aria-busy"), undefined, "hidden cancellation must clear busy state");
assert.equal(button.textContent, "Calculate rebate");
pending[2]({ esc: 10, prc: 100 });
await hiddenCalculation;
assert.equal(displayed.length, 1, "hidden cancelled result must not repaint");
assert.match(api, /dcceewContract:\s*\{\s*rate: DCCEEW_CONTRACT_RATE,\s*postcodes: DCCEEW_ELIGIBLE_POSTCODES,\s*productKeys: DCCEEW_ELIGIBLE_PRODUCT_KEYS/);
assert.match(raw, /setInterval\(refreshAuthoritativeCertificateValues, certificateRefreshIntervalMs\)/);
assert.match(raw, /addEventListener\('focus', refreshAuthoritativeCertificateValues\)/);
assert.match(raw, /visibilityState === 'visible'\) refreshAuthoritativeCertificateValues/);
assert.doesNotMatch(matcher, /location\.reload|localStorage|persistQuotes|persistOptionDefs/, "refresh must not reload, persist rules as user overrides or rewrite quotes");
console.log("DCCEEW live refresh passed: removal, addition, equal-size changes, in-flight invalidation, all views, draft preservation and sync bridge");
