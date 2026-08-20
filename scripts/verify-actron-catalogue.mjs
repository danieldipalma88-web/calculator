import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const contractProducts = JSON.parse(
  readFileSync(new URL("../lib/dcceew-contract-products.json", import.meta.url), "utf8"),
);

const expectedNewModels = [
  ["AIRES", 13, "Three", "CRS13AT / EVA13AS"],
  ["AIRES", 15, "Three", "CRS15AT / EVA15AS"],
  ["AIRES", 17, "Three", "CRS17AT / EVA17AS"],
  ["Advance B", 13, "Single", "CRV13BS / EVV13BS"],
  ["Advance B", 13, "Three", "CRV13BT / EVV13BS"],
  ["Advance B", 15, "Single", "CRV15BS / EVV15BS"],
  ["Advance B", 15, "Three", "CRV15BT / EVV15BS"],
  ["Advance B", 17, "Single", "CRV17BS / EVV17BS"],
  ["Advance B", 17, "Three", "CRV17BT / EVV17BS"],
  ["Advance B", 19, "Three", "CRV19BT / EVV19BS"],
  ["Advance B", 22, "Three", "CRV22BT / EVV22BS"],
];

for (const [series, size, phase, modelNumber] of expectedNewModels) {
  const escaped = modelNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = source.match(new RegExp(`\\{"brand":"Actron"[^\\n]+"model":"${escaped}"[^\\n]+\\}`, "g")) || [];
  assert.equal(matches.length, 1, `${modelNumber} must appear exactly once in the shared catalogue.`);
  assert.match(matches[0], new RegExp(`"series":"${series}"`));
  assert.match(matches[0], new RegExp(`"size":${size}\\.0`));
  assert.match(matches[0], new RegExp(`"phase":"${phase}"`));
  assert.match(matches[0], /"priceIncGst":0\.0/);
  assert.match(matches[0], /"unitPriceInc":0\.0/);
}

assert.ok(
  !source.includes('andosDuctedInc("Actron", "AIRES"'),
  "NSW shared catalogue additions must not alter Andos Air's separate Queensland catalogue.",
);

const model = "CRV25BT / EVV25BS";
const escapedModel = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sharedEntry = source.match(
  new RegExp(`\\{"brand":"Actron"[^\\n]+"model":"${escapedModel}"[^\\n]+\\}`),
)?.[0];

assert.ok(sharedEntry, `Missing shared Actron model: ${model}`);
assert.match(sharedEntry, /"series":"Advance B"/);
assert.match(sharedEntry, /"size":25\.0/);
assert.match(sharedEntry, /"phase":"Three"/);
assert.match(sharedEntry, /"priceIncGst":9608\.50/);
assert.match(sharedEntry, /"rebate":0\.0/);
assert.match(sharedEntry, /"capacity":"25\.0kW"/);
assert.match(sharedEntry, /"capacityNum":25\.0/);
assert.match(sharedEntry, /"unitPriceInc":9608\.50/);
assert.match(
  source,
  /\{type:'ducted',model:'CRV25BT \/ EVV25BS',oldUnitPriceInc:0,newUnitPriceInc:9608\.50\}/,
  "Saved zero-dollar entries must migrate to the current Actron price.",
);

assert.match(
  source,
  /andosDuctedInc\("Actron", "Advance B", 25\.0, "Three", "CRV25BT \/ EVV25BS", 9608\.50\)/,
  "Andos Air must receive the model when the requested scope is all calculators.",
);
assert.match(
  source,
  /\{brand:'Actron',details:\{wifiStatus:'optional',wifiLabel:'Wi-Fi optional controller',warrantyYears:5,warrantyLabel:'5 yrs warranty',originLabel:'Australian'\}\}/,
);

assert.ok(
  contractProducts.includes("ACTRONAIR|CRV25BTEVV25BS"),
  "The Actron pairing must remain recognised by the DCCEEW contract register.",
);

console.log("Actron catalogue verification passed: 11 new NSW models are price-gated and the existing 25.0kW model remains available at $9,608.50 inc GST.");
