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

const expected = [
  ["Daikin", "Floor Standing", "RXM25YFVMA / FVXM25YVMA", 2.5],
  ["Daikin", "Floor Standing", "RXM35YFVMA / FVXM35YVMA", 3.5],
  ["Daikin", "Floor Standing", "RXM45YFVMA / FVXM45YVMA", 4.5],
  ["Daikin", "Floor Standing", "RXM50YFVMA / FVXM50YVMA", 5],
  ["Daikin", "Floor Standing", "RXM60YFVMA / FVXM60YVMA", 6],
  ["Daikin", "Floor Standing", "RXM71YFVMA / FVXM71YVMA", 6.7],
  ["Mitsubishi Heavy Industries", "Bronte", "DXC28ZRA-W / DXK28ZRA-WF1", 8],
];

const daikinFloor = sandbox.products.filter((product) => product.brand === "Daikin" && product.series === "Floor Standing");
const mhiBronte = sandbox.products.filter((product) => product.brand === "Mitsubishi Heavy Industries" && product.series === "Bronte");
const expectedExistingBronteModels = ["DXC24ZRA-W - DXK24ZRA-WF1", "SRC95ZRA-W / SRK95ZRA-WF1"];
const existingBronteModels = Array.from(mhiBronte, (product) => product.model).filter((model) => model !== "DXC28ZRA-W / DXK28ZRA-WF1").sort();
assert.equal(daikinFloor.length, 6, "Expected exactly six Daikin Floor Standing systems, without duplicates.");
assert.deepEqual(existingBronteModels, [...expectedExistingBronteModels].sort(), "Existing Bronte models must remain present.");
assert.equal(mhiBronte.filter((product) => product.model === "DXC28ZRA-W / DXK28ZRA-WF1").length, 1, "The requested Bronte model must exist exactly once.");

for (const [brand, series, model, capacity] of expected) {
  const matches = sandbox.visible.filter((product) => product.brand === brand && product.model === model);
  assert.equal(matches.length, 1, `${model} must be active exactly once in the split dropdown.`);
  const product = matches[0];
  assert.equal(product.series, series);
  assert.equal(product.capacityNum, capacity);
  assert.equal(product.unitPriceInc, 0, "These catalogue additions must not introduce pricing.");
  assert.equal(product.priceIncGst, 0);
  assert.equal(product.rebate, 0, "Rebates must come from the live calculation, not a static estimate.");
  assert.equal(product.nswOnly, true);
  assert.equal(product.phase, "Single");
  assert.equal(product.model.split(" / ")[0], model.split(" / ")[0], "Outdoor model must be listed first.");

  assert.equal(product.warrantyYears, 5);
  assert.equal(product.wifiStatus, "included");
}
assert.equal(mhiBronte.find((product) => product.model === expectedExistingBronteModels[0]).unitPriceInc, 1699.5);
assert.equal(mhiBronte.find((product) => product.model === expectedExistingBronteModels[1]).unitPriceInc, 2750);

const publicCatalogue = await buildPublicRebateCatalogue();
for (const [brand, series, model, capacity] of expected) {
  const matches = publicCatalogue.products.filter((product) =>
    product.systemType === "split" && product.brand === brand && product.model === model,
  );
  assert.equal(matches.length, 1, `${model} must appear exactly once in the public estimator.`);
  assert.equal(matches[0].series, series);
  assert.equal(matches[0].capacityKw, capacity);
  assert.equal(matches[0].phase, "Single");
}

console.log("Daikin Floor Standing and MHI Bronte active catalogue, support and public estimator checks passed.");
