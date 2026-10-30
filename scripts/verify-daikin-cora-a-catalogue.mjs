import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildPublicRebateCatalogue } from "../lib/public-rebate-catalogue.ts";

const expected = [
  ["RXV20AVMA / FTXV20AVMA", 2.0],
  ["RXV25AVMA / FTXV25AVMA", 2.5],
  ["RXV35AVMA / FTXV35AVMA", 3.5],
  ["RXV46AVMA / FTXV46AVMA", 4.6],
  ["RXV50AVMA / FTXV50AVMA", 5.0],
  ["RXV60AVMA / FTXV60AVMA", 6.0],
  ["RXV71AVMA / FTXV71AVMA", 7.1],
];
const series = "Cora - A Series";
const source = await readFile(new URL("../index.html", import.meta.url), "utf8");

function loadCatalogues(html) {
  const start = html.indexOf("const SPLIT_PRODUCTS =");
  const end = html.indexOf("let systemType='split'");
  assert.ok(start >= 0 && end > start, "Catalogue source boundaries exist");
  const sandbox = Object.create(null);
  vm.runInNewContext(`${html.slice(start, end)}\nglobalThis.catalogues={split:SPLIT_PRODUCTS,andos:ANDOS_SPLIT_PRODUCTS,ducted:DUCTED_PRODUCTS,andosDucted:ANDOS_DUCTED_PRODUCTS};`, sandbox, { timeout: 8000 });
  return sandbox.catalogues;
}

const catalogues = loadCatalogues(source);
for (const [index, model] of [
  [188, "RXM25AVMA / FTXM25AVMA"],
  [189, "RXM46AVMA / FTXM46AVMA"],
  [190, "RXV50AVMA / FTXV50AVMA"],
  [191, "DXC21ZRA-W / DXK21ZRA-WF1"],
  [192, "DXC33ZRA-W / DXK33ZRA-WF1"],
  [193, "AOTH18KNTA/ASTH18KNTA"],
  [194, "HAWH18KR"],
  [195, "38QAF020N8/42QAF020N8"],
  [196, "RXM20AVMA / FTXM20AVMA"],
  [197, "RXM35AVMA / FTXM35AVMA"],
  [198, "RXM50AVMA / FTXM50AVMA"],
  [199, "RXM60AVMA / FTXM60AVMA"],
  [200, "RXM71AVMA / FTXM71AVMA"],
]) assert.equal(catalogues.split[index]?.model, model, `Preserve split|${index} for existing price overrides`);
assert.equal(catalogues.split.length, 207, "Append six new Cora capacities around the retained 5 kW row");
for (const [model] of expected.filter(([model]) => model !== "RXV50AVMA / FTXV50AVMA")) {
  assert.ok(catalogues.split.findIndex(row => row.model === model) >= 201, `${model} must be appended`);
}

const listStart = source.indexOf("function baseProductListFor(type)");
const listEnd = source.indexOf("function productListFor(type)", listStart);
assert.ok(listStart >= 0 && listEnd > listStart);
const visibility = {
  SPLIT_PRODUCTS: catalogues.split,
  DUCTED_PRODUCTS: catalogues.ducted,
  ANDOS_SPLIT_PRODUCTS: catalogues.andos,
  ANDOS_DUCTED_PRODUCTS: catalogues.andosDucted,
};
vm.runInNewContext(`${source.slice(listStart, listEnd)}\nglobalThis.base=baseProductListFor;`, visibility);
for (const catalogue of ["default", "andos"]) {
  visibility.activeCatalogKey = () => catalogue;
  for (const state of ["NSW", "QLD"]) {
    visibility.activeBusinessState = () => state;
    const rows = visibility.base("split").filter(row => row.brand === "Daikin" && row.series === series);
    assert.equal(rows.length, state === "NSW" ? 7 : 0, `${catalogue}/${state}: NSW-only visibility`);
    if (state !== "NSW") {
      for (const type of ["split", "ducted"]) assert.ok(visibility.base(type).every(row => row.nswOnly !== true));
    }
  }
}

const normalize = value => String(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
for (const catalogueName of ["split", "andos"]) {
  const catalogue = catalogues[catalogueName];
  const rows = catalogue.filter(row => row.brand === "Daikin" && row.series === series && !row.deprecated);
  assert.equal(rows.length, 7, `${catalogueName}: exactly seven Cora A models`);
  for (const [model, capacity] of expected) {
    const matches = catalogue.filter(row => !row.deprecated && normalize(row.model) === normalize(model));
    assert.equal(matches.length, 1, `${catalogueName}: no duplicate ${model}`);
    const product = matches[0];
    assert.equal(product.model, model);
    assert.equal(product.capacityNum, capacity);
    assert.equal(product.capacity, `${capacity.toFixed(1)}kW`);
    assert.equal(product.series, series);
    assert.equal(product.phase, "Single");
    assert.equal(product.nswOnly, true);
    const price = capacity === 2.5 ? 850 : capacity === 5 ? 1420 : 0;
    assert.equal(product.unitPriceInc, price);
    assert.equal(product.priceIncGst, price);
    assert.equal(product.rebate, 0, "No static rebate");
    assert.equal(product.wifiStatus, "optional");
    assert.equal(product.wifiLabel, "Wi-Fi optional adaptor");
    assert.equal(product.warrantyYears, 5);
    assert.equal(product.warrantyLabel, "5 yrs parts & labour");
    assert.equal(product.originLabel, "Japanese");
  }
}
for (const [model] of expected) {
  const standard = catalogues.split.find(row => row.model === model);
  const andos = catalogues.andos.find(row => row.model === model);
  assert.notEqual(standard, andos, "Default and Andos catalogues must not share mutable rows");
  assert.equal(catalogues.ducted.some(row => row.model === model), false);
  assert.equal(catalogues.andosDucted.some(row => row.model === model), false);
}

const publicCatalogue = await buildPublicRebateCatalogue();
assert.equal(publicCatalogue.products.length, 467);
assert.deepEqual(publicCatalogue.counts, { split: 257, ducted: 210, total: 467 });
const publicModels = publicCatalogue.products.filter(row => row.brand === "Daikin" && row.series === series);
assert.equal(publicModels.length, 7, "Estimator includes all seven Cora A models");
for (const [model, capacity] of expected) {
  const product = publicModels.find(row => row.model === model);
  assert.ok(product, `${model} missing from estimator`);
  assert.equal(product.systemType, "split");
  assert.equal(product.capacityKw, capacity);
  assert.equal(product.phase, "Single");
  for (const part of model.split(" / ")) assert.ok(product.searchTerms.includes(part), `${part} searchable`);
}
console.log("Daikin Cora A: original split rows preserved; all seven models, NSW visibility, pricing/support metadata, independent Andos clones and 467-row estimator passed.");
