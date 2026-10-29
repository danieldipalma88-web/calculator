import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildPublicRebateCatalogue } from "../lib/public-rebate-catalogue.ts";

// Daikin FTXM-A specification table and AU GEMS lookup verified 29 October 2026:
// https://www.daikin.co.nz/pages/alira-x-commercial
// https://calculator.rebateportal.com.au/api/gems-model-search?brand=Daikin&q=AVMA
const expected = [
  ["RXM20AVMA / FTXM20AVMA", 2.2],
  ["RXM25AVMA / FTXM25AVMA", 2.5],
  ["RXM35AVMA / FTXM35AVMA", 3.5],
  ["RXM46AVMA / FTXM46AVMA", 4.6],
  ["RXM50AVMA / FTXM50AVMA", 5.0],
  ["RXM60AVMA / FTXM60AVMA", 6.0],
  ["RXM71AVMA / FTXM71AVMA", 7.1],
];
const series = "Alira X - A Series";
const source = await readFile(new URL("../index.html", import.meta.url), "utf8");
const start = source.indexOf("const SPLIT_PRODUCTS =");
const end = source.indexOf("let systemType='split'");
assert.ok(start >= 0 && end > start);
const sandbox = Object.create(null);
vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.catalogues={split:SPLIT_PRODUCTS,andos:ANDOS_SPLIT_PRODUCTS,ducted:DUCTED_PRODUCTS,andosDucted:ANDOS_DUCTED_PRODUCTS};`, sandbox, { timeout: 8000 });
// Managed prices can still use legacy split|index identities.
const retainedIndexes = [
  [188, "RXM25AVMA / FTXM25AVMA"],
  [189, "RXM46AVMA / FTXM46AVMA"],
  [190, "RXV50AVMA / FTXV50AVMA"],
  [191, "DXC21ZRA-W / DXK21ZRA-WF1"],
  [192, "DXC33ZRA-W / DXK33ZRA-WF1"],
  [193, "AOTH18KNTA/ASTH18KNTA"],
  [194, "HAWH18KR"],
  [195, "38QAF020N8/42QAF020N8"],
];
for (const [index, model] of retainedIndexes) assert.equal(sandbox.catalogues.split[index].model, model, `Preserve split|${index} for existing price overrides`);
for (const [model] of expected.filter(([model]) => !retainedIndexes.some(([, existing]) => existing === model))) {
  assert.ok(sandbox.catalogues.split.findIndex(row => row.model === model) >= 196, `${model} must be appended`);
}
const listStart = source.indexOf("function baseProductListFor(type)");
const listEnd = source.indexOf("function productListFor(type)", listStart);
assert.ok(listStart >= 0 && listEnd > listStart);
const visibility = {
  SPLIT_PRODUCTS: sandbox.catalogues.split,
  DUCTED_PRODUCTS: sandbox.catalogues.ducted,
  ANDOS_SPLIT_PRODUCTS: sandbox.catalogues.andos,
  ANDOS_DUCTED_PRODUCTS: sandbox.catalogues.andosDucted,
};
vm.runInNewContext(`${source.slice(listStart, listEnd)}\nglobalThis.base=baseProductListFor;`, visibility);
for (const catalogue of ["default", "andos"]) {
  visibility.activeCatalogKey = () => catalogue;
  for (const state of ["NSW", "QLD"]) {
    visibility.activeBusinessState = () => state;
    const rows = visibility.base("split").filter(row => row.brand === "Daikin" && row.series === series);
    assert.equal(rows.length, state === "NSW" ? 7 : 0, `${catalogue}/${state}: actual NSW-only visibility`);
    if (state !== "NSW") {
      for (const type of ["split", "ducted"]) assert.ok(visibility.base(type).every(row => row.nswOnly !== true));
    }
  }
}
const normalize = value => String(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
for (const catalogueName of ["split", "andos"]) {
  const catalogue = sandbox.catalogues[catalogueName];
  const rows = catalogue.filter(row => row.brand === "Daikin" && row.series === series && !row.deprecated);
  assert.equal(rows.length, 7, `${catalogueName}: exactly seven AVMA models`);
  for (const [model, capacity] of expected) {
    const matches = catalogue.filter(row => !row.deprecated && normalize(row.model) === normalize(model));
    assert.equal(matches.length, 1, `${catalogueName}: no duplicate ${model}`);
    const product = matches[0];
    assert.equal(product.model, model, "Use exact GEMS outdoor / indoor spelling");
    assert.equal(product.capacityNum, capacity);
    assert.equal(product.capacity, `${capacity.toFixed(1)}kW`);
    assert.equal(product.series, series);
    assert.equal(product.phase, "Single");
    assert.equal(product.nswOnly, true);
    assert.equal(product.unitPriceInc, 0);
    assert.equal(product.priceIncGst, 0);
    assert.equal(product.rebate, 0, "Do not store a static rebate");
    assert.equal(product.wifiStatus, "included");
    assert.equal(product.wifiLabel, "Built-in Wi-Fi");
    assert.equal(product.warrantyYears, 5);
    assert.equal(product.warrantyLabel, "5 yrs parts & labour");
    assert.equal(product.originLabel, "Japanese");
  }
}
for (const [model] of expected) {
  const standard = sandbox.catalogues.split.find(row => row.model === model);
  const andos = sandbox.catalogues.andos.find(row => row.model === model);
  assert.notEqual(standard, andos, "Business catalogues must not share mutable product objects");
  assert.equal(sandbox.catalogues.ducted.some(row => row.model === model), false);
}
const legacy = sandbox.catalogues.split.filter(row => row.brand === "Daikin" && row.series === "Alira" && !row.deprecated);
assert.equal(legacy.length, 9, "Retain the older Alira range, including its two XL models, separately");
assert.ok(legacy.every(row => row.unitPriceInc > 0 && !/AVMA/.test(row.model)), "Do not reset or replace older priced models");
for (const [model, price] of [
  ["RXM20YVMA / FTXM20YVMA", 830],
  ["RXM25YVMA / FTXM25YVMA", 880],
  ["RXM35YVMA / FTXM35YVMA", 1070],
  ["RXM46WVMA / FTXM46WVMA", 1380],
  ["RXM50WVMA / FTXM50WVMA", 1460],
  ["RXM60WVMA / FTXM60WVMA", 1635],
  ["RXM71WVMA / FTXM71WVMA", 1825],
  ["RXM85WVMA / FTXM85WVMA", 2355],
  ["RXM95WVMA / FTXM95WVMA", 2770],
]) assert.equal(legacy.find(row => row.model === model)?.unitPriceInc, price, `${model} legacy price unchanged`);
const publicCatalogue = await buildPublicRebateCatalogue();
const publicModels = publicCatalogue.products.filter(row => row.brand === "Daikin" && row.series === series);
assert.equal(publicModels.length, 7, "Estimator must have all seven models without partner duplicates");
for (const [model, capacity] of expected) {
  const product = publicModels.find(row => row.model === model);
  assert.ok(product, `${model} missing from estimator`);
  assert.equal(product.systemType, "split");
  assert.equal(product.capacityKw, capacity);
  assert.equal(product.phase, "Single");
  for (const part of model.split(" / ")) assert.ok(product.searchTerms.includes(part), `${part} searchable`);
}
console.log("Alira X AVMA: all seven exact model pairs, capacities, separate legacy prices, zero new prices, Wi-Fi/warranty and estimator coverage passed.");
