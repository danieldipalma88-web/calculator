import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const match = source.match(/const KADEN_NSW_SPLIT_PRODUCTS=(\[[\s\S]*?\]);\s*SPLIT_PRODUCTS\.push\(\.\.\.KADEN_NSW_SPLIT_PRODUCTS\);/);

assert.ok(match, "The NSW Kaden split catalogue was not found.");
const products = JSON.parse(match[1]);
const expectedModels = [
  "KSI-2.0",
  "KSI-2.5",
  "KSI-3.5",
  "KSI-5.0",
  "KSI-7.0",
  "KSI-7.6",
  "KSI-9.0",
];

assert.deepEqual(products.map((product) => product.model), expectedModels);
assert.equal(new Set(products.map((product) => product.model)).size, expectedModels.length);

for (const product of products) {
  assert.equal(product.brand, "Kaden");
  assert.equal(product.series, "KSI V3");
  assert.equal(product.unitPriceInc, 0, `${product.model} must have no unit price.`);
  assert.equal(product.priceIncGst, 0, `${product.model} must have no GST-inclusive unit price.`);
  assert.equal(product.rebate, 0, `${product.model} must not use a default rebate.`);
  assert.equal(product.nswOnly, true, `${product.model} must remain NSW-only.`);
}

assert.equal(products.find((product) => product.model === "KSI-7.6")?.capacityNum, 7.65);
assert.match(source, /'Kaden':'Chinese'/, "Kaden origin metadata must be present.");
assert.match(
  source,
  /\{brand:'Kaden',series:'KSI V3',details:\{wifiStatus:'included',wifiLabel:'Built-in Wi-Fi',warrantyYears:7,warrantyLabel:'7 yrs parts & labour'\}\}/,
  "Kaden Wi-Fi and warranty metadata must be present.",
);
assert.match(
  source,
  /return activeBusinessState\(\)==='NSW'\?list:list\.filter\(product=>product\.nswOnly!==true\);/,
  "NSW-only products must remain hidden from non-NSW default catalogues.",
);

console.log("Kaden catalogue verification passed: 7 current KSI V3 NSW models, prices unset, built-in Wi-Fi, 7-year parts and labour warranty.");
