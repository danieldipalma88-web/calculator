import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../index.html", import.meta.url), "utf8");
const zenaMatch = source.match(/const DAIKIN_ZENA_SPLIT_PRODUCTS=(\[[\s\S]*?\]);/);
assert.ok(zenaMatch, "Daikin Zena catalogue is missing.");

const zenaProducts = JSON.parse(zenaMatch[1]);
const expectedPrices = new Map([
  ["RXJ25TVMA / FTXJ25TVMAW", 1103.41],
  ["RXJ35TVMA / FTXJ35TVMAW", 1311.96],
  ["RXJ50TVMA / FTXJ50TVMAW", 1754.70],
  ["RXJ60TVMA / FTXJ60TVMAW", 1951.28],
  ["RXJ25TVMA / FTXJ25TVMAK", 1103.41],
  ["RXJ35TVMA / FTXJ35TVMAK", 1311.96],
  ["RXJ50TVMA / FTXJ50TVMAK", 1754.70],
  ["RXJ60TVMA / FTXJ60TVMAK", 1951.28],
]);

assert.equal(zenaProducts.length, expectedPrices.size, "Expected all eight white and black Zena systems.");
for (const product of zenaProducts) {
  assert.equal(product.brand, "Daikin");
  assert.equal(product.series, "Zena");
  assert.equal(product.unitPriceInc, expectedPrices.get(product.model), `Unexpected global Zena price for ${product.model}.`);
  assert.equal(product.priceIncGst, product.unitPriceInc);
  assert.equal(product.nswOnly, undefined, `${product.model} must be available to every state catalogue.`);
}

assert.match(source, /SPLIT_PRODUCTS\.push\(\.\.\.DAIKIN_ZENA_SPLIT_PRODUCTS\.map\(product=>\(\{\.\.\.product\}\)\)\);/);
assert.match(source, /ANDOS_SPLIT_PRODUCTS\.push\(\.\.\.DAIKIN_ZENA_SPLIT_PRODUCTS\.map\(product=>\(\{\.\.\.product\}\)\)\);/);
assert.match(source, /\{brand:'Daikin',series:'Zena',details:\{wifiStatus:'included',wifiLabel:'Built-in Wi-Fi',warrantyYears:5,warrantyLabel:'5 yrs parts & labour'\}\}/);

const sharedDuctedSection = source.slice(
  source.indexOf("const DUCTED_PRODUCTS = ["),
  source.indexOf("function andosUnitPriceInc"),
);
assert.match(
  sharedDuctedSection,
  /"model":"RZYQ10TY1 \/ FDYQ250LCV1","priceIncGst":0\.0[\s\S]*?"capacityNum":24\.0,"unitPriceInc":0\.0/,
  "The rebate-compatible 24.0kW premium model must exist unpriced in the shared catalogue.",
);
assert.doesNotMatch(sharedDuctedSection, /FDYAN(?:50|60|71|85|100|125|140|160)/, "Standard FDYAN inverter models must stay out of the shared catalogue.");

console.log("Daikin Zena catalogue checks passed.");
