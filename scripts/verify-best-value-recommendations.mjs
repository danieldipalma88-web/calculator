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
rebateSandbox.isNewDuctedDcceewExclusion = (context) => context?.systemType === "ducted" && context?.installType === "new";
rebateSandbox.getDcceewContractMatch = (_product, postcode, context) => {
  rebateSandbox.matchedPostcode = postcode;
  return rebateSandbox.isNewDuctedDcceewExclusion(context) ? null : rebateSandbox.match;
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
  { systemType: "split", installType: "new" },
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
  { systemType: "split", installType: "new" },
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
  { systemType: "split", installType: "new" },
);
assert.equal(Number(standardResult.rebate.toFixed(2)), 330.35, "standard recommendation rebate changed unexpectedly");
assert.equal(standardResult.rebateSource, "standard", "standard recommendation must disclose its rebate basis");

rebateSandbox.match = { rate: 30 };
const newDuctedResult = rebateSandbox.__recommendationRebate(
  { brand: "Daikin", model: "RZAS71C2V1 / FDYA71AV19" },
  certificateResult,
  "2000",
  { systemType: "ducted", installType: "new" },
);
assert.equal(Number(newDuctedResult.rebate.toFixed(2)), 330.35, "new ducted recommendations must use the standard rate");
assert.equal(newDuctedResult.contractApplied, false, "new ducted recommendations must not display a contract uplift");
assert.equal(newDuctedResult.contractExcluded, true, "new ducted recommendations must expose the exclusion context");
const ductedReplacementResult = rebateSandbox.__recommendationRebate(
  { brand: "Daikin", model: "RZAS71C2V1 / FDYA71AV19" },
  certificateResult,
  "2000",
  { systemType: "ducted", installType: "replacement" },
);
assert.equal(ductedReplacementResult.contractApplied, true, "ducted replacement recommendations must retain the contract rate");

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

assert.match(html, /calculateRecommendationCandidate\(item,postcode,calculationContext,climatePromise\)/, "candidate comparison does not use a shared climate lookup");
assert.match(html, /hasManualRebateOverride\(context\.systemType,p\)\?null:await estimateLiveEssRebate/, "manual candidates still make unnecessary live rebate requests");
assert.match(html, /activeBusinessName\(\).*activeBusinessState\(\).*candidateSignature/s, "recommendation cache is not scoped to business and current prices");
assert.match(html, /invalidateBestValueRecommendations\(true\);\s*syncCurrentProductAfterPriceChange/, "price edits do not invalidate recommendation results");
assert.match(html, /populateProducts\(\{skipProductChange:true\}\);\s*\$\('product'\)\.value=String\(idx\);\s*onProductChange\(\);/, "recommended unit loading still calculates an intermediate brand default");
assert.match(html, /setSystem\(s\.systemType\|\|'split',\{skipProductChange:true\}\)/, "saved quote loading still starts an intermediate product calculation");
assert.match(html, /setInstall\(s\.installType\|\|'new',\{skipRefresh:true\}\);\s*onProductChange\(\{skipAsyncRefresh:true\}\);/, "saved quote state is not applied atomically before recalculation");
assert.match(html, /DCCEEW \$30 ESC rate/, "recommendation card does not disclose the contract rebate basis");
assert.match(html, /recommendationFootnote\(categoryLabel,postcode,failedCount,entry\.calculationContext\)/, "recommendations do not preserve the explicit calculation context in their footnote");
assert.match(html, /New ducted installations are excluded from the DCCEEW contract rate\./, "recommendations do not explain the new ducted exclusion");

const refreshStart = html.indexOf("async function refreshBestValueIndicator");
const refreshEnd = html.indexOf("function hasManualRebateOverride", refreshStart);
const refreshSource = html.slice(refreshStart, refreshEnd);
assert.ok(refreshSource.indexOf("const requestId=++essBestValueRuntime.requestSeq") < refreshSource.indexOf("const cached=essBestValueRuntime.cache"), "cached refreshes do not cancel older recommendation requests");
const cacheKeyStart = html.indexOf("function bestValueCacheKey");
const cacheKeyEnd = html.indexOf("function unitDisplayName", cacheKeyStart);
const cacheKeySandbox = {
  normalizeLookup: (value) => String(value).toLowerCase(),
  activeBusinessName: () => "Example Air", activeBusinessState: () => "NSW",
  activeCatalogKey: () => "example", systemType: "split", installType: "new",
  dcceewRecommendationSignature: () => "contract-v1",
};
vm.runInNewContext(`${html.slice(cacheKeyStart, cacheKeyEnd)}\nglobalThis.key=bestValueCacheKey;`, cacheKeySandbox);
assert.notEqual(
  cacheKeySandbox.key(2.5, "2575", "auto", 23.501, 2.7, "", "models"),
  cacheKeySandbox.key(2.5, "2575", "auto", 23.504, 2.7, "", "models"),
  "distinct payout rates must never share a comparison result",
);

const candidates = Array.from({ length: 35 }, (_, i) => ({ brand: "Example", model: `UNIT-${i}`, capacityNum: 2.5 }));
let resolveClimate;
const climateLookup = new Promise((resolve) => { resolveClimate = resolve; });
let climateCalls = 0;
let candidateCalls = 0;
let rendered = [];
let escRate = 23.5;
const recommendationSandbox = {
  essBestValueRuntime: { requestSeq: 0, cache: {}, pending: {}, lastEntry: null },
  systemType: "split", installType: "new",
  setSectionLoading() {}, rebatesEnabled: () => true,
  product: () => candidates[0], getEssPostcode: () => "2575",
  getEssEscRate: () => escRate, getEssPrcRate: () => 2.7,
  kwCategoryValue: () => 2.5, kwCategoryLabel: () => "2.5kW",
  cap: () => 2.5, recommendationScopeLabel: () => "2.5kW",
  getEssZoneSelection: () => "cold", recommendationPhaseValue: () => "",
  data: () => candidates, productVisibleToCurrentUser: () => true,
  recommendationCandidateMatchesScope: () => true,
  normalizeLookup: (value) => String(value).toLowerCase(),
  recommendationCandidateSignature: () => "35-models",
  bestValueCacheKey: (_category, _postcode, _zone, rate) => `key-${rate}`,
  setBestValueMeta() {}, setBestNetCostMeta() {},
  hasManualRebateOverride: () => false,
  resolvePostcodeZones: () => { climateCalls += 1; return climateLookup; },
  calculateRecommendationCandidate: async (item, _postcode, context, sharedClimate) => {
    candidateCalls += 1;
    const climate = await sharedClimate;
    assert.equal(climate.postcode, "2575");
    assert.equal(climate.climateZone, "cold");
    const rebate = context.escRate * 10 + item.i;
    return { ok: true, brand: item.p.brand, model: item.p.model, unitCost: 500 + item.i * 10,
      rebate, netCost: 500 + item.i * 10 - rebate };
  },
  renderBestRecommendationCards: (entry) => { rendered.push(entry); },
  unitDisplayName: (row) => row.model,
};
vm.runInNewContext(`${refreshSource}\nglobalThis.refreshRecommendation=refreshBestValueIndicator;`, recommendationSandbox);
const firstRefresh = recommendationSandbox.refreshRecommendation();
const secondRefresh = recommendationSandbox.refreshRecommendation();
assert.equal(climateCalls, 1, "overlapping comparisons should share one postcode lookup");
assert.equal(candidateCalls, 35, "overlapping comparisons should calculate each candidate once");
resolveClimate({ zone: "mixed", bcaZone: "BCA_Climate_Zone_7" });
await Promise.all([firstRefresh, secondRefresh]);
assert.equal(rendered.length, 1, "only the latest comparison should render");
assert.equal(rendered[0].best.model, "UNIT-34", "highest live rebate must still win");
assert.equal(rendered[0].bestNetCost.model, "UNIT-0", "lowest net unit cost must still win");
await recommendationSandbox.refreshRecommendation();
assert.equal(candidateCalls, 35, "a completed comparison should use its cached result");
escRate = 24;
await recommendationSandbox.refreshRecommendation();
assert.equal(candidateCalls, 70, "a changed payout rate must recalculate all candidates");
let releaseMetadata;
const metadataDelay = new Promise((resolve) => { releaseMetadata = resolve; });
recommendationSandbox.resolvePostcodeZones = () => Promise.reject(new Error("postcode temporarily unavailable"));
recommendationSandbox.calculateRecommendationCandidate = async (_item, _postcode, _context, sharedClimate) => {
  await metadataDelay;
  await sharedClimate;
};
escRate = 25;
const failedRefresh = recommendationSandbox.refreshRecommendation();
await new Promise((resolve) => setImmediate(resolve));
releaseMetadata();
await failedRefresh;
assert.equal(rendered.length, 3, "a failed postcode lookup must not render an incomplete best result");

const zoneStart = html.indexOf("async function resolvePostcodeZones");
const zoneEnd = html.indexOf("async function getClimateContext", zoneStart);
assert.ok(zoneStart >= 0 && zoneEnd > zoneStart, "could not isolate postcode lookup");
let resolvePostcodeRequest;
let postcodeCalls = 0;
const postcodeResponse = new Promise((resolve) => { resolvePostcodeRequest = resolve; });
const zoneSandbox = {
  essCache: { zoneByPostcode: {} }, ESS_CALCULATE_API: "https://example.test/calculate", ESS_CALC_DATE: "2021-01-01",
  fetchJson: () => { postcodeCalls += 1; return postcodeResponse; },
  normalizeEssClimateZone: (zone) => zone,
  fallbackEssClimateZoneFromPostcode: () => "",
  electricFutureBcaClimateZoneOverride: () => null,
};
vm.runInNewContext(`${html.slice(zoneStart, zoneEnd)}\nglobalThis.resolveZones=resolvePostcodeZones;`, zoneSandbox);
const zoneFirst = zoneSandbox.resolveZones("2575");
const zoneSecond = zoneSandbox.resolveZones("2575");
assert.equal(postcodeCalls, 1, "concurrent rebate calculations should share the postcode request");
resolvePostcodeRequest({ buildings: { building_1: {
  HVAC1_PDRSAug24_get_climate_zone_by_postcode: { "2021-01-01": "mixed" },
  HVAC1_PDRSAug24_BCA_climate_zone_by_postcode: { "2021-01-01": 7 },
} } });
const [zoneOne, zoneTwo] = await Promise.all([zoneFirst, zoneSecond]);
assert.equal(zoneOne.bcaZone, "BCA_Climate_Zone_7");
assert.equal(zoneTwo.zone, "mixed");
await zoneSandbox.resolveZones("2575");
assert.equal(postcodeCalls, 1, "resolved postcode should remain cached");
zoneSandbox.fetchJson = () => { postcodeCalls += 1; return Promise.reject(new Error("temporary failure")); };
await assert.rejects(zoneSandbox.resolveZones("2576"), /temporary failure/);
zoneSandbox.fetchJson = () => { postcodeCalls += 1; return Promise.resolve({ buildings: { building_1: {
  HVAC1_PDRSAug24_get_climate_zone_by_postcode: { "2021-01-01": "mixed" },
  HVAC1_PDRSAug24_BCA_climate_zone_by_postcode: { "2021-01-01": 7 },
} } }); };
await zoneSandbox.resolveZones("2576");
assert.equal(postcodeCalls, 3, "failed postcode lookups must be retried");

const gemsStart = html.indexOf("async function fetchGemsModelMetadata");
const gemsEnd = html.indexOf("async function fetchNswEstimatorMetadataDirect", gemsStart);
assert.ok(gemsStart >= 0 && gemsEnd > gemsStart, "could not isolate GEMS metadata lookup");
let resolveGemsRequest;
let gemsCalls = 0;
const gemsResponse = new Promise((resolve) => { resolveGemsRequest = resolve; });
const gemsSandbox = {
  essCache: { gemsByLookup: {} },
  normalizeLookup: (value) => String(value).toLowerCase(),
  normaliseModelName: (value) => value,
  rebateLookupModelSearchCandidates: (value) => [value],
  rebateLookupBrandCandidates: (value) => [value],
  fetchGemsRecordsForQuery: () => { gemsCalls += 1; return gemsResponse; },
  selectBestGemsRecord: (records) => records[0],
  modelMetaFromGemsRecord: (record) => record,
  isUsableModelMeta: () => true,
};
vm.runInNewContext(`${html.slice(gemsStart, gemsEnd)}\nglobalThis.resolveGems=fetchGemsModelMetadata;`, gemsSandbox);
const gemsFirst = gemsSandbox.resolveGems("Example", "UNIT-1");
const gemsSecond = gemsSandbox.resolveGems("Example", "UNIT-1");
assert.equal(gemsCalls, 1, "selected model and comparison should share an in-flight GEMS lookup");
resolveGemsRequest([{ brand: "Example", model: "UNIT-1" }]);
const [gemsOne, gemsTwo] = await Promise.all([gemsFirst, gemsSecond]);
assert.equal(gemsOne.meta.model, "UNIT-1");
assert.equal(gemsTwo.meta.model, "UNIT-1");
await gemsSandbox.resolveGems("Example", "UNIT-1");
assert.equal(gemsCalls, 1, "resolved GEMS metadata should remain cached");

console.log("best value recommendation checks ok");
