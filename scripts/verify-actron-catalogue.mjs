import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const contractProducts = JSON.parse(
  readFileSync(new URL("../lib/dcceew-contract-products.json", import.meta.url), "utf8"),
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

console.log("Actron catalogue verification passed: 25.0kW three-phase model is available in all catalogues at $9,608.50 inc GST.");
