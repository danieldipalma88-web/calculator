import assert from "node:assert/strict";
import { GEMS_AIRCON_RESOURCE_IDS, fetchGemsDatastoreRecords, fetchGemsMultiSplitRecords, isEligibleAustralianGemsRecord, mapGemsModelSearchItem } from "../lib/gems-model-search.ts";

const originalFetch = globalThis.fetch;
const secondary = {
  Brand: "FUJITSU GENERAL", Model_No: "AOTG09KMTC/ASTG09KMTC", SubmitStatus: "Approved",
  "Availability Status": "Available", Sold_in: "Australia,New Zealand", "Product Class": "Class 8", "Registration Number": "AAC8714",
  "C-Total Cool Rated": "2.5", "H-Total Heat Rated": "3.2", "C-Power_Inp_Rated": "0.53",
  "Rated AEER": "4.701", "Rated ACOP": "4.8352", "Residential TCSPF_mixed": "6.755",
  "Residential HSPF_mixed": "4.975", "Residential HSPF_cold": "4.548",
  "Residential tcec_hot": "452", "Residential tcec_mixed": "155", "Residential tcec_cold": "97",
  "Residential thec_hot": "51", "Residential thec_mixed": "351", "Residential thec_cold": "920",
};
let primaryRows = [];
let secondaryRows = [secondary];
let primaryFailure = false;
let secondaryFailure = false;
const called = [];
globalThis.fetch = async (url) => {
  const parsed = new URL(url);
  const primary = parsed.searchParams.get("resource_id") === GEMS_AIRCON_RESOURCE_IDS[0]
    || (parsed.searchParams.get("sql") || "").includes(GEMS_AIRCON_RESOURCE_IDS[0]);
  called.push(primary ? "primary" : "secondary");
  if (primary ? primaryFailure : secondaryFailure) throw new Error("Fixture network failure");
  return Response.json({ success: true, result: { records: primary ? primaryRows : secondaryRows } });
};
try {
  const options = { query: secondary.Model_No, revalidateSeconds: 0 };
  assert.equal((await fetchGemsDatastoreRecords(options))[0].Model_No, secondary.Model_No);
  assert.deepEqual(called, ["primary", "secondary"], "An empty primary must not hide the second registry.");
  primaryRows = [{ ...secondary, Model_No: "DIFFERENT-MODEL" }];
  assert.equal((await fetchGemsDatastoreRecords(options)).length, 2, "A nonempty primary must not hide secondary-only models.");
  primaryRows = [{ ...secondary, Sold_in: null, "Availability Status": null, "C-Total Cool Rated": "" }];
  const rows = await fetchGemsDatastoreRecords(options);
  assert.equal(rows.filter(isEligibleAustralianGemsRecord).length, 1, "Do not infer missing Australian availability.");
  assert.equal(mapGemsModelSearchItem(primaryRows[0]).completeEnergyData, false, "Missing ratings must not silently become zero.");
  assert.equal(mapGemsModelSearchItem(secondary).completeEnergyData, true);
  primaryRows = [{ ...secondary, "C-Total Cool Rated": "" }];
  assert.equal(mapGemsModelSearchItem((await fetchGemsDatastoreRecords(options))[0]).capacityKw, 2.5, "A complete secondary must precede an eligible but incomplete primary.");
  primaryRows = [{ ...secondary, _id: 4601 }];
  secondaryRows = [{ ...secondary, _id: 3193 }];
  assert.equal((await fetchGemsDatastoreRecords(options)).length, 1, "Identical stable registrations are not two distinct candidates.");
  primaryRows = Array.from({ length: 10000 }, () => ({ ...secondary, _id: 4601 }));
  assert.ok((await fetchGemsDatastoreRecords({ ...options, limit: 10000 })).length >= 10000, "Deduplication must not hide a capped inventory from verification.");
  primaryRows = [{ ...secondary, _id: 4601 }];
  secondaryRows = [{ ...secondary, _id: 3193, "Rated AEER": "4.8" }];
  assert.equal((await fetchGemsDatastoreRecords(options)).length, 2, "Conflicting evidence must remain visible to verification.");
  primaryFailure = true;
  await assert.rejects(fetchGemsDatastoreRecords(options), /Fixture network failure/, "Verification must not approve incomplete dataset coverage.");
  const multiOptions = { fields: ["Brand", "Model_No"], revalidateSeconds: 0 };
  await assert.rejects(fetchGemsMultiSplitRecords(multiOptions), /Fixture network failure/);
  secondaryRows = [];
  await assert.rejects(fetchGemsDatastoreRecords(options), /Fixture network failure/, "Partial failures must not be misreported as no models.");
  secondaryFailure = true;
  await assert.rejects(fetchGemsMultiSplitRecords(multiOptions), /Fixture network failure/);
  primaryFailure = secondaryFailure = false;
  primaryRows = [];
  assert.deepEqual(await fetchGemsDatastoreRecords(options), []);
} finally { globalThis.fetch = originalFetch; }
console.log("Both GEMS datasets, secondary-only models, approval filters, missing ratings and partial failures verified.");
