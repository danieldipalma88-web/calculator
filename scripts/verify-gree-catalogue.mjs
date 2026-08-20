import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const match = source.match(/const GREE_NSW_SPLIT_PRODUCTS=(\[[\s\S]*?\]);\s*SPLIT_PRODUCTS\.push\(\.\.\.GREE_NSW_SPLIT_PRODUCTS\);/);

assert.ok(match, "The NSW Gree split catalogue was not found.");
const products = JSON.parse(match[1]);

assert.equal(products.length, 26, "Expected 26 unique Gree outdoor/indoor pairings.");
assert.equal(new Set(products.map((product) => product.model)).size, products.length, "Gree pairings must not be duplicated.");

const expectedSeriesCounts = new Map([
  ["Alto", 7],
  ["Pular", 7],
  ["Bora-X", 4],
  ["Hyper+ AI", 7],
  ["Bora-X / Hyper+ AI", 1],
]);

for (const [series, count] of expectedSeriesCounts) {
  assert.equal(products.filter((product) => product.series === series).length, count, `${series} model count changed.`);
}

for (const product of products) {
  assert.equal(product.brand, "Gree");
  assert.equal(product.unitPriceInc, 0, `${product.model} must have no unit price.`);
  assert.equal(product.priceIncGst, 0, `${product.model} must have no GST-inclusive unit price.`);
  assert.equal(product.nswOnly, true, `${product.model} must remain NSW-only.`);
  assert.match(product.model, /\/O \/ .+\/I$/, `${product.model} must use outdoor / indoor rebate-search order.`);
}

assert.ok(
  products.some((product) => product.model === "GWH09AACXB-K6DNA1B/O / GWH09AACXB-K6DNA1B/I"),
  "The selected 2.5kW Bora-X pairing is missing.",
);
assert.ok(
  products.some((product) => product.model === "GWH32QFXH-K6DNB2A/O / GWH32QFXH-K6DNB2A/I" && product.series === "Bora-X / Hyper+ AI"),
  "The shared 9.4kW Bora-X / Hyper+ AI pairing must be stored once.",
);

for (const series of expectedSeriesCounts.keys()) {
  const escaped = series.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const supportRule = source.match(new RegExp(`\\{brand:'Gree',series:'${escaped}',details:\\{[^\\n]+\\}\\}`))?.[0];
  assert.ok(supportRule, `Missing product-support details for ${series}.`);
  assert.match(supportRule, /wifiStatus:'included'/);
  assert.match(supportRule, /warrantyYears:6/);
  assert.match(supportRule, /warrantyLabel:'6 yrs parts & labour'/);
}

assert.match(source, /'Gree':'Chinese'/, "Gree origin metadata must be present.");
assert.match(
  source,
  /return activeBusinessState\(\)==='NSW'\?list:list\.filter\(product=>product\.nswOnly!==true\);/,
  "NSW-only products must remain hidden from non-NSW default catalogues.",
);

console.log("Gree catalogue verification passed: 26 unique NSW models, prices unset, Wi-Fi included, 6-year parts and labour warranty.");
