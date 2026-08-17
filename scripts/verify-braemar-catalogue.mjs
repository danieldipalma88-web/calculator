import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../index.html", import.meta.url), "utf8");

const splitModels = [
  ["ACHV25D1S / ASHV25D1S", "2.70"],
  ["ACHV35D1S / ASHV35D1S", "3.52"],
  ["ACHV50D1S / ASHV50D1S", "5.20"],
  ["ACHV70D1S / ASHV70D1S", "7.10"],
  ["ACHV80D1S / ASHV80D1S", "8.20"],
  ["TCHV02T1S / TSHV02T1S", "2.64"],
  ["TCHV03T1S / TSHV03T1S", "3.53"],
  ["TCHV05T1S / TSHV05T1S", "5.30"],
  ["TCHV07T1S / TSHV07T1S", "7.20"],
  ["TCHV08T1S / TSHV08T1S", "8.20"],
];
const ductedModels = [
  ["KCHA070D1B / KDHA070D1S", "7.1"],
  ["KCHA100D1B / KDHA100D1S", "10.0"],
  ["KCHA125D1B / KDHA125D1S", "12.5"],
  ["KCHA140D1B / KDHA140D1S", "14.0"],
  ["KCHA160D1B / KDHA160D1S", "16.0"],
];

function objectForModel(model) {
  const escapedModel = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.match(new RegExp(`\\{"brand":"Braemar"[^\\n]+"model":"${escapedModel}"[^\\n]+\\}`))?.[0];
}

for (const [model, capacityNum] of [...splitModels, ...ductedModels]) {
  const entry = objectForModel(model);
  assert.ok(entry, `Missing Braemar model: ${model}`);
  assert.match(entry, new RegExp(`"capacityNum":${capacityNum.replace(".", "\\.")}`));
  assert.match(entry, /"unitPriceInc":0\.0/);
  assert.match(entry, /"(?:priceIncGst|rebate)":0\.0/);
}

assert.equal((source.match(/"brand":"Braemar"/g) || []).length, 15, "Expected 15 Braemar entries");
assert.match(source, /\{brand:'Braemar',series:'Austral-air'/);
assert.match(source, /\{brand:'Braemar',series:'Innov-aire'/);
assert.match(source, /\{brand:'Braemar',series:'Braemar Ducted'/);
assert.match(source, /'Braemar':'Australian'/);

console.log("Braemar catalogue verification passed: 10 split, 5 ducted, prices unset.");
