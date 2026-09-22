import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildWeeklySample,
  compareHistoricalReference,
  acceptsServerMetadataSource,
  createFrontendMultiSplitInputs,
  documentedGemsCandidates,
  executeCases,
  historicalReferencesComplete,
  makeSampleCases,
  makeVerifiedMultiSplitCases,
  parseSampleArgs,
  rotatingContractExpectation,
  validateExactGemsItem,
  validateLiveResult,
} from "./monitor-rebate-sample.mjs";
import { createFrontendCalculator } from "./monitor-nsw-postcodes-helpers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [fixture, catalogue] = await Promise.all([
  readFile(path.join(root, "scripts", "fixtures", "rebate-reference-cases.json"), "utf8").then(JSON.parse),
  readFile(path.join(root, "lib", "public-rebate-catalogue.generated.json"), "utf8").then(JSON.parse),
]);

const seed = "2026-W39";
const sample = buildWeeklySample(catalogue, fixture, seed);
assert.deepEqual(buildWeeklySample(catalogue, fixture, seed), sample, "the explicit seed must reproduce the exact weekly sample");
assert.equal(sample.length, 30, "the monitor must select 30 distinct brand/model/postcode combinations");
assert.equal(new Set(sample.map((item) => `${item.brand}|${item.model}|${item.postcode}`)).size, 30, "sample combinations must be distinct");
assert.equal(sample.filter((item) => item.systemType === "split").length, 15, "sample must balance split systems");
assert.equal(sample.filter((item) => item.systemType === "ducted").length, 15, "sample must balance ducted systems");
assert.ok(new Set(sample.map((item) => item.brand)).size >= 12, "sample must spread coverage across catalogue brands");
assert.ok(sample.some((item) => item.postcode === "2550"), "the fixed 2550 sample must remain present");
assert.ok(sample.some((item) => item.id === "dcceew-ducted-new-exclusion"), "new ducted DCCEEW exclusion must remain present");
const climateCounts = Object.fromEntries(Object.entries(fixture.sample.postcodesByClimate)
  .map(([climate]) => [climate, sample.filter((item) => item.plannedClimate === climate).length]));
assert.equal(Object.values(climateCounts).reduce((sum, value) => sum + value, 0), 26, "each rotating combination needs a planned climate input");
assert.ok(Math.max(...Object.values(climateCounts)) - Math.min(...Object.values(climateCounts)) <= 1,
  "the 26 rotating combinations must be balanced across the three planned climate inputs");
const capacityCounts = sample.filter((item) => item.capacityKw !== null).reduce((counts, item) => {
  const bucket = item.capacityKw < 4 ? "small" : item.capacityKw < 8 ? "medium" : "large";
  counts[bucket] += 1;
  return counts;
}, { small: 0, medium: 0, large: 0 });
assert.deepEqual(capacityCounts, { small: 6, medium: 10, large: 10 },
  "the sample must include all two available ducted small systems and balance the remaining capacity choices");
const splitCapacityCounts = sample.filter((item) => item.systemType === "split" && item.capacityKw !== null).reduce((counts, item) => {
  const bucket = item.capacityKw < 4 ? "small" : item.capacityKw < 8 ? "medium" : "large";
  counts[bucket] += 1;
  return counts;
}, { small: 0, medium: 0, large: 0 });
assert.deepEqual(splitCapacityCounts, { small: 4, medium: 4, large: 4 }, "rotating split systems must be capacity-balanced");

const cases = makeSampleCases(sample);
assert.equal(cases.length, 60, "each combination must test new and replacement paths");
assert.equal(new Set(cases.map((item) => item.id)).size, 60, "each new/replacement case needs a unique report identity");
assert.equal(cases.filter((item) => item.installType === "new").length, 30);
assert.equal(cases.filter((item) => item.installType === "replacement").length, 30);
assert.equal(cases.filter((item) => item.postcode === "2550").length, 2, "2550 must cover both new and replacement");
assert.ok(cases.filter((item) => item.fixed).every((item) => item.requirePositiveCertificates === true), "every permanent fixed control must require positive certificates");
assert.equal(cases.find((item) => item.id.includes("dcceew-ducted-new-exclusion") && item.installType === "new").expectedContract, false);
assert.equal(cases.find((item) => item.id.includes("dcceew-ducted-new-exclusion") && item.installType === "replacement").expectedContract, true);
const approvedPostcodes = catalogue.dcceewPostcodes;
const approvedSplit = { systemType: "split", dcceewEligible: true };
const approvedDucted = { systemType: "ducted", dcceewEligible: true };
assert.equal(rotatingContractExpectation(approvedSplit, "2145", "new", approvedPostcodes), true, "an approved rotating split/new case must use the contract ESC rate");
assert.equal(rotatingContractExpectation(approvedDucted, "2620", "replacement", approvedPostcodes), true, "an approved rotating ducted/replacement case must use the contract ESC rate");
assert.equal(rotatingContractExpectation(approvedDucted, "2620", "new", approvedPostcodes), false, "approved new ducted cases remain excluded from the contract rate");
assert.equal(rotatingContractExpectation(approvedSplit, "9999", "replacement", approvedPostcodes), false, "non-approved postcodes must not receive the contract rate");
assert.equal(rotatingContractExpectation({ systemType: "split", dcceewEligible: false }, "2145", "replacement", approvedPostcodes), false, "products absent from the exact contract catalogue must not receive the contract rate");
const multiSplitCases = makeVerifiedMultiSplitCases(fixture);
assert.equal(multiSplitCases.length, 2, "the verified physical multi-split combination must add new and replacement cases");
assert.deepEqual(multiSplitCases.map((item) => item.installType), ["new", "replacement"]);
assert.ok(multiSplitCases.every((item) => item.model === "MON2H05B1LA" && item.indoorHeads[0].model === "HINRPX25M" && item.indoorHeads[0].qty === 2));
assert.ok(multiSplitCases.every((item) => item.requirePositiveCertificates === true), "the verified multi-split control must require positive certificates");
const frontendMultiSplitInputs = createFrontendMultiSplitInputs(await readFile(path.join(root, "index.html"), "utf8"));
const multiInputs = frontendMultiSplitInputs({ "Cooling Capacity": 5.4, "Heating Capacity": 5.2, "Input Power": 1.8 }, multiSplitCases[0].indoorHeads);
assert.equal(multiInputs.coolingCapacity, 5.2, "the monitor must use the frontend helper's lesser-of-indoor/outdoor cooling rule");
assert.equal(multiInputs.heatingCapacity, 5.2, "the monitor must use the frontend helper's lesser-of-indoor/outdoor heating rule");
assert.ok(Math.abs(multiInputs.inputPower - (1.8 * 5.2 / 5.4)) < 1e-12, "the monitor must use frontend helper input-power scaling");

assert.deepEqual(parseSampleArgs(["--seed=repeatable", "--concurrency=2"]), {
  output: null, summary: null, seed: "repeatable", concurrency: 2, timeoutMs: 12_000, budgetMs: 480_000, dryRun: false,
});
assert.throws(() => parseSampleArgs(["--concurrency=5"]), /1 to 4/);

const rates = fixture.controlledPayoutRates;
let zeroClimateRequests = 0;
const zeroFrontend = await createFrontendCalculator({
  fetch: async () => {
    zeroClimateRequests += 1;
    return Response.json({ buildings: { building_1: {
      HVAC1_PDRSAug24_get_climate_zone_by_postcode: { "2021-01-01": "mixed" },
      HVAC1_PDRSAug24_BCA_climate_zone_by_postcode: { "2021-01-01": 6 },
    } } });
  },
});
const nonEligibleCertificates = await zeroFrontend.calculate({
  postcode: "2145",
  installType: "new",
  airConditionerType: "non_ducted_single_split_system",
  metadata: {
    "Product Type": "Non Ducted", "Product Class": "Class 8", "Cooling Capacity": 2.5, "Heating Capacity": 3,
    "Input Power": 0.5, "Rated AEER": 1, "Rated ACOP": 1, "Residential TCSPF_mixed": 1,
    "Residential HSPF_mixed": 1, "Residential HSPF_cold": 1, "Residential tcec_mixed": 1, "Residential thec_mixed": 1,
  },
});
assert.deepEqual({ esc: nonEligibleCertificates.esc, prc: nonEligibleCertificates.prc }, { esc: 0, prc: 0 },
  "deliberately non-eligible metadata must yield zero frontend certificates without an upstream certificate calculation");
assert.equal(zeroClimateRequests, 1);
const zero = { esc: 0, prc: 0, rebate: 0, escRate: rates.esc, prcRate: rates.prc, contractApplied: false };
assert.equal(validateLiveResult({ server: zero, frontend: zero, expectedContract: false, rates }), null, "a deliberate non-eligible zero result must be accepted only when payout is zero");
assert.match(validateLiveResult({ server: zero, frontend: { ...zero, eligibility: { essEligible: false, prcEligible: false } }, expectedContract: false, rates, requirePositiveCertificates: true }), /eligible GEMS metadata returned zero/, "a known eligible fixture must fail even if eligibility regresses false");
assert.match(validateLiveResult({ server: zero, frontend: { ...zero, eligibility: { essEligible: true, prcEligible: true } }, expectedContract: false, rates }), /eligible GEMS metadata returned zero/, "eligible metadata must not silently pass with zero certificates");
assert.match(validateLiveResult({ server: { ...zero, rebate: 1 }, frontend: zero, expectedContract: false, rates }), /payout mismatch/, "a non-eligible result must not carry a payout");
assert.match(validateLiveResult({ server: { ...zero, esc: Number.NaN }, frontend: zero, expectedContract: false, rates }), /non-finite/, "malformed certificate values must fail");
assert.match(validateLiveResult({ server: { ...zero, esc: 2, rebate: 2 * rates.esc }, frontend: { ...zero, esc: 1 }, expectedContract: false, rates }), /certificate mismatch/, "frontend/server certificate drift must fail");
assert.match(validateLiveResult({ server: { ...zero, esc: 1, rebate: 0 }, frontend: { ...zero, esc: 1 }, expectedContract: false, rates }), /payout mismatch/, "incorrect controlled payout arithmetic must fail");
assert.match(validateExactGemsItem({ brand: "TCL", model: "TAC-10CHSD/VEIH", completeEnergyData: false }, { brand: "TCL", model: "TAC-10CHSD/VEIH" }), /missing complete/, "incomplete GEMS metadata must be rejected");
assert.match(validateExactGemsItem({ brand: "TCL", model: "other", completeEnergyData: true }, { brand: "TCL", model: "TAC-10CHSD/VEIH" }), /exact/, "silent GEMS model substitution must be rejected");
const panasonic = catalogue.products.find((product) => product.id === "split-panasonic-hz-series-8-fe5dbcfb98");
const hisense = catalogue.products.find((product) => product.id === "split-hisense-eros-r32-x3-series-wall-mounted-8-d9a0980f86");
assert.ok(documentedGemsCandidates(panasonic).some((entry) => entry.model === "CS-HZ80YKR/CU-HZ80YKR" && entry.source === "catalogue-model-alias"), "documented paired-model aliases must be queryable");
assert.ok(documentedGemsCandidates(hisense).some((entry) => entry.model === "HAWJ28KR" && entry.source === "catalogue-search-term"), "documented catalogue search terms must retain their provenance");
assert.equal(documentedGemsCandidates(hisense).some((entry) => entry.model === "unrelated-model"), false, "undocumented GEMS substitutions must remain impossible");
assert.equal(acceptsServerMetadataSource({ brand: "Actron Air" }, "Verified GEMS metadata + NSW formula"), true, "the committed Actron verified-GEMS source is permitted");
assert.equal(acceptsServerMetadataSource({ brand: "TCL" }, "Verified GEMS metadata + NSW formula"), false, "a verified fallback source is not broadly permitted");
assert.equal(acceptsServerMetadataSource({ brand: "TCL" }, "NSW estimator metadata + NSW formula"), false, "NSW-estimator fallback remains incomplete");

const reference = fixture.historicalElectricFutureEvidence[0];
assert.equal(compareHistoricalReference(reference, { esc: 8.614, prc: 86.654 }), null, "the historical comparison uses the stored rounded tolerance");
assert.match(compareHistoricalReference(reference, { esc: 8.61, prc: 86.66 }), /historical certificate difference/, "reference drift must be reported without changing stored expectations");
assert.equal(historicalReferencesComplete([{ status: "matched" }, { status: "matched" }]), true);
assert.equal(historicalReferencesComplete([{ status: "matched" }, { status: "not-tested" }]), false, "a missing historical reference must fail the monitor completion gate");

let attempts = 0;
const retryResults = await executeCases([{ id: "retry" }], async (task, attempt) => {
  attempts += 1;
  if (!attempt) throw new Error("network timed out");
  return { id: task.id, status: "passed", message: "" };
}, { concurrency: 1, deadline: Date.now() + 1_000 });
assert.equal(attempts, 2, "a transient case failure gets exactly one bounded retry");
assert.equal(retryResults[0].status, "passed");
const incomplete = await executeCases([{ id: "late" }], async () => ({ id: "late", status: "passed", message: "" }), { concurrency: 1, deadline: Date.now() - 1 });
assert.equal(incomplete[0].status, "untested", "a budget-expired case must be incomplete rather than passed");

console.log("weekly rebate sample verification passed");
