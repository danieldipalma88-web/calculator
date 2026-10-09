import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildPublicRebateCatalogue } from "../lib/public-rebate-catalogue.ts";

const source = await readFile(new URL("../index.html", import.meta.url), "utf8");
const start = source.indexOf("const SPLIT_PRODUCTS =");
const end = source.indexOf("let systemType='split'", start);
const activeProducts = source.match(/function activeProducts\(list\)\{[^\n]+\}/)?.[0];
assert.ok(start >= 0 && end > start && activeProducts, "Could not isolate the active split catalogue.");

const sandbox = Object.create(null);
vm.runInNewContext(
  `${source.slice(start, end)}\n${activeProducts}\nglobalThis.products = SPLIT_PRODUCTS; globalThis.visible = activeProducts(SPLIT_PRODUCTS);`,
  sandbox,
  { timeout: 8000 },
);

const expected = new Map([
  ["RAC-VJ25PHAT/RAK-VJ25PHAT", [2.5, 765.60]],
  ["RAC-VJ35PHAT/RAK-VJ35PHAT", [3.5, 880.00]],
  ["RAC-VJ50PHAT/RAK-VJ50PHAT", [5.0, 1204.50]],
  ["RAC-VJ60PHAT/RAK-VJ60PHAT", [6.0, 1346.40]],
  ["RAC-VJ70PHAT/RAK-VJ70PHAT", [7.0, 1503.70]],
]);
const airHome600 = sandbox.products.filter((product) => product.brand === "Hitachi" && product.series === "AirHome 600");
assert.equal(airHome600.length, expected.size, "Expected exactly five airHome 600 systems, without duplicates.");
for (const [model, [capacity, price]] of expected) {
  const matches = sandbox.visible.filter((product) => product.brand === "Hitachi" && product.model === model);
  assert.equal(matches.length, 1, `${model} must be available exactly once in the split dropdown.`);
  const product = matches[0];
  assert.equal(product.series, "AirHome 600");
  assert.equal(product.capacityNum, capacity);
  assert.equal(product.unitPriceInc, price, "Restoring visibility must not change existing shared pricing.");
  assert.equal(product.warrantyYears, 6);
  assert.equal(product.wifiStatus, "included");
}
assert.equal(
  sandbox.visible.filter((product) => product.brand === "Hitachi" && product.series === "AirHome 400").length,
  5,
  "The five airHome 400 systems must remain available.",
);

const publicCatalogue = await buildPublicRebateCatalogue();
for (const [model, [capacity]] of expected) {
  const matches = publicCatalogue.products.filter((product) => product.systemType === "split" && product.brand === "Hitachi" && product.model === model);
  assert.equal(matches.length, 1, `${model} must also be available exactly once in the public estimator.`);
  assert.equal(matches[0].capacityKw, capacity);
  assert.equal(matches[0].series, "AirHome 600");
}

console.log("Hitachi airHome 600 visibility, model pairs, support details, prices and estimator checks passed.");
