import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFrontendCalculator,
  createMemoizedFetch,
  expectedRequestBudget,
  fetchCurrentNswPostcodes,
  isInfrastructureError,
  loadPostcodeInventory,
  parseMonitorArgs,
  validateComparableCertificates,
} from "./monitor-nsw-postcodes-helpers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventory = await loadPostcodeInventory(path.join(root, "scripts", "fixtures", "nsw-postcodes.abs-2021.json"));
assert.equal(inventory.postcodes.length, 622, "ABS baseline plus ABS-listed shared NSW postcodes must contain 622 entries");
assert.ok(inventory.postcodes.includes("2550"));
assert.ok(inventory.postcodes.includes("4375"));
assert.deepEqual(parseMonitorArgs(["--postcodes=2550,2549,2000", "--concurrency=4"]), {
  postcodes: ["2550", "2549", "2000"], output: null, summary: null, concurrency: 4,
  timeoutMs: 12_000, budgetMs: 1_200_000, dryRun: false,
});
assert.throws(() => parseMonitorArgs(["--postcodes=255"]), /four-digit/);
assert.throws(() => parseMonitorArgs(["--postcodes="]), /four-digit/);
assert.deepEqual(expectedRequestBudget(3), {
  climateLookups: 3, certificateCalculations: 8, normalNswServiceRequests: 11, metadataLookups: 2,
  estimateScope: "Normal-path lower bound; excludes postcode recovery calls, retries, and distinct browser/server payloads. See measured network counts.",
});

assert.equal(isInfrastructureError(new Error("Unable to resolve climate zones for postcode 2550")), false,
  "A postcode mapping failure must not stop the remaining postcode sweep as a general outage");
assert.match(validateComparableCertificates({ esc: 0, prc: 0, rebate: 0 }, { esc: 0, prc: 0 }, true), /no rebate/);
assert.match(validateComparableCertificates({ esc: NaN, prc: 1, rebate: 1 }, { esc: 0, prc: 1 }, true), /non-finite/);
assert.match(validateComparableCertificates({ esc: 1, prc: 1, rebate: 2 }, { esc: 2, prc: 1 }, true), /mismatch/);

let memoCalls = 0;
const memo = createMemoizedFetch({
  fetchImpl: async () => {
    memoCalls += 1;
    return new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
  },
});
assert.deepEqual(await (await memo.fetch("https://example.test/value")).json(), { ok: true });
assert.deepEqual(await (await memo.fetch("https://example.test/value")).json(), { ok: true });
assert.equal(memoCalls, 1, "identical frontend/server upstream requests must share a response body");

let failedCalls = 0;
const failedMemo = createMemoizedFetch({ fetchImpl: async () => {
  failedCalls += 1;
  return new Response("no field of name 0", { status: 500 });
} });
const failedResponse = await failedMemo.fetch("https://example.test/postcode");
assert.equal(failedCalls, 2, "Transient status gets one bounded retry");
assert.equal(failedResponse.status, 500);
assert.equal(await failedResponse.text(), "no field of name 0", "The original response body must reach the production recovery path");

const current = await fetchCurrentNswPostcodes({
  fetchImpl: async () => new Response(JSON.stringify({
    exceededTransferLimit: false,
    features: inventory.postcodes.map((postcode) => ({ attributes: { postcode } })),
  })),
});
assert.deepEqual(current, inventory.postcodes);
await assert.rejects(fetchCurrentNswPostcodes({ fetchImpl: async () => new Response(JSON.stringify({
  exceededTransferLimit: true, features: [{ attributes: { postcode: 2550 } }],
})) }), /truncated/);

const catalogue = JSON.parse(await readFile(path.join(root, "lib", "public-rebate-catalogue.generated.json"), "utf8"));
const fallback = catalogue.fallbackMetadata.find((row) => row.brand === "TCL" && row.model === "TAC-10CHSD/VEIH");
assert.ok(fallback, "split monitor fixture must remain available in the committed catalogue");
const metadata = {
  "Product Type": fallback.type,
  "Product Class": fallback.productClass,
  "Cooling Capacity": fallback.cooling,
  "Heating Capacity": fallback.heating,
  "Input Power": fallback.input,
  "Rated AEER": fallback.aeer,
  "Rated ACOP": fallback.acop,
  "Residential TCSPF_mixed": fallback.tcspfMixed,
  "Residential HSPF_mixed": fallback.hspfMixed,
  "Residential HSPF_cold": fallback.hspfCold,
  "Residential tcec_mixed": fallback.tcecMixed,
  "Residential thec_mixed": fallback.thecMixed,
  "Residential tcec_cold": fallback.tcecCold,
  "Residential thec_cold": fallback.thecCold,
};
const frontend = await createFrontendCalculator({
  fetch: async (_url, options) => {
    const building = JSON.parse(options.body).buildings.building_1;
    const postcodeOnly = "HVAC1_PDRSAug24_get_climate_zone_by_postcode" in building;
    const response = postcodeOnly
      ? { buildings: { building_1: {
        HVAC1_PDRSAug24_get_climate_zone_by_postcode: { "2021-01-01": "mixed" },
        HVAC1_PDRSAug24_BCA_climate_zone_by_postcode: { "2021-01-01": 6 },
      } } }
      : { buildings: { building_1: {
        HVAC1_PDRSAug24_electricity_savings: { "2021-01-01": 10 },
        HVAC1_PDRSAug24_PDRS__regional_network_factor: { "2021-01-01": 1 },
        HVAC1_PDRSAug24_peak_demand_reduction_capacity: { "2021-01-01": 4 },
        HVAC1_PDRSAug24_get_network_loss_factor_by_postcode: { "2021-01-01": 1.05 },
      } } };
    return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
  },
});
const frontendResult = await frontend.calculate({
  postcode: "2550", metadata, installType: "replacement", airConditionerType: "non_ducted_single_split_system",
});
assert.ok(Math.abs(frontendResult.esc - 10.6) < 0.000001);
assert.equal(frontendResult.prc, 42);

let coldInitialRequests = 0;
let coldRecoveryRequests = 0;
const coldNetwork = createMemoizedFetch({ fetchImpl: async (_url, options) => {
  const building = JSON.parse(options.body).buildings.building_1;
  const fields = Object.keys(building);
  if (fields.includes("HVAC1_PDRSAug24_get_climate_zone_by_postcode")) {
    return Response.json({ buildings: { building_1: {
      HVAC1_PDRSAug24_get_climate_zone_by_postcode: { "2021-01-01": "" },
      HVAC1_PDRSAug24_BCA_climate_zone_by_postcode: { "2021-01-01": 6 },
    } } });
  }
  if (fields.includes("HVAC1_PDRSAug24_ESC_calculation")) {
    coldInitialRequests += 1;
    return new Response("no field of name 0", { status: 500 });
  }
  coldRecoveryRequests += 1;
  return Response.json({ buildings: { building_1: {
    HVAC1_PDRSAug24_electricity_savings: { "2021-01-01": 10 },
    HVAC1_PDRSAug24_PDRS__regional_network_factor: { "2021-01-01": 1 },
    HVAC1_PDRSAug24_peak_demand_reduction_capacity: { "2021-01-01": 4 },
    HVAC1_PDRSAug24_get_network_loss_factor_by_postcode: { "2021-01-01": 1.05 },
  } } });
} });
const coldFrontend = await createFrontendCalculator({ fetch: coldNetwork.fetch });
const coldResult = await coldFrontend.calculate({
  postcode: "2550", metadata, installType: "replacement", airConditionerType: "non_ducted_single_split_system",
});
assert.equal(coldInitialRequests, 2);
assert.equal(coldRecoveryRequests, 2, "2550 must recover through both proxy ESC and actual-postcode factors");
assert.ok(Math.abs(coldResult.esc - 10.6) < 0.000001);
assert.equal(coldResult.prc, 42);

console.log("postcode monitor verification passed");
