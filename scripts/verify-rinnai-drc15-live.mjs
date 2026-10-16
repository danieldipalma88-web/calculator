import assert from "node:assert/strict";
import { register } from "node:module";
import { createFrontendCalculator } from "./monitor-nsw-postcodes-helpers.mjs";

register("./monitor-nsw-postcodes-loader.mjs", import.meta.url);
const { fetchGemsDatastoreRecords, mapGemsModelSearchItem, isEligibleAustralianGemsRecord } = await import("../lib/gems-model-search.ts");
const { calculateCurrentNswRebate } = await import("../lib/nsw-hvac-rebate.ts");
const records = await fetchGemsDatastoreRecords({ brand: "Rinnai", limit: 10_000, revalidateSeconds: 3_600 });
const matched = records.filter(isEligibleAustralianGemsRecord).map(mapGemsModelSearchItem).find((item) => item?.model === "DONSR15B1/DINLR15B1");
assert.ok(matched, "The exact pair must be returned by a case-insensitive GEMS brand inventory.");
assert.equal(matched.brand, "RINNAI");
assert.equal(matched.completeEnergyData, true);
const response = await fetch("https://estimator-sfg-rac-prd.energy.nsw.gov.au/commercial_hvac/metadata", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ brand: "Rinnai", model: "DONSR15B1-DINLR15B1" }), signal: AbortSignal.timeout(12_000),
});
assert.equal(response.status, 200);
const metadata = await response.json();
assert.equal(metadata.model, "DONSR15B1-DINLR15B1");
assert.equal(Number(metadata["Cooling Capacity"]), 14);
assert.equal(Number(metadata["Heating Capacity"]), 14.5);
const frontend = await createFrontendCalculator({ fetch: globalThis.fetch });
for (const postcode of ["2000", "2179"]) {
  for (const installType of ["new", "replacement"]) {
    const client = await frontend.calculate({ postcode, metadata: matched.metadata, installType, airConditionerType: "ducted_single_split_system" });
    const server = await calculateCurrentNswRebate({ brand: "Rinnai", model: "DONSR15B1/DINLR15B1", postcode, installType, systemType: "ducted", escRate: 24.7, prcRate: 3.1 });
    assert.ok(client.esc > 0 && client.prc > 0);
    assert.ok(Math.abs(client.esc - server.esc) < 0.000001, "ESC must agree between browser and server.");
    assert.ok(Math.abs(client.prc - server.prc) < 0.000001, "PRC must agree between browser and server.");
    if (postcode === "2000" && installType === "replacement") {
      assert.equal(Number(client.esc.toFixed(2)), 52.92, "ESC must match the supplied Electric Future example.");
      assert.equal(Number(client.prc.toFixed(2)), 237.22, "PRC must match the supplied Electric Future example.");
    }
    console.log(JSON.stringify({ postcode, installType, esc: client.esc, prc: client.prc, comparisonRebate: server.rebate, lookupSource: server.lookupSource }));
  }
}
console.log("Exact Rinnai case-insensitive GEMS lookup, NSW metadata confirmation, browser/server parity and supplied Electric Future certificate comparison passed.");
