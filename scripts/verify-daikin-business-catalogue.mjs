import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../index.html", import.meta.url), "utf8");

const sharedCatalogueSection = source.slice(
  source.indexOf('SPLIT_PRODUCTS.push(\n  {"brand":"Daikin"'),
  source.indexOf("const DAIKIN_SPLIT_PRICE_UPDATES"),
);
const globalDaikinUpdateSection = source.slice(
  source.indexOf("const DAIKIN_SPLIT_PRICE_UPDATES"),
  source.indexOf("const DAIKIN_S_AND_H_SPLIT_PRICE_OVERRIDES"),
);
const scopedDaikinUpdateSection = source.slice(
  source.indexOf("const DAIKIN_S_AND_H_SPLIT_PRICE_OVERRIDES"),
  source.indexOf("const HITACHI_AIRHOME_400_SPLIT_UPDATES"),
);

const nswProducts = [
  ["RXF25WVMA / FTXF25WVMA", 775],
  ["RXF35WVMA / FTXF35WVMA", 940],
  ["RXF50WVMA / FTXF50WVMA", 1286],
  ["RXF60WVMA / FTXF60WVMA", 1440],
  ["RXF71WVMA / FTXF71WVMA", 1610],
  ["RKM85WVMA / FTKM85WVMA", 2445],
  ["RKM95WVMA / FTKM95WVMA", 2875],
];

for (const [model, price] of nswProducts) {
  assert.match(sharedCatalogueSection, new RegExp(`"model":"${model.replaceAll("/", "\\/")}"`));
  assert.match(sharedCatalogueSection, new RegExp(`"unitPriceInc":${price}\\.00`));
  assert.match(sharedCatalogueSection, new RegExp(`"model":"${model.replaceAll("/", "\\/")}"[\\s\\S]*?"nswOnly":true`));
}

const sAndHPrices = [
  ["RXV25WVMA / FTXV25WVMA", 845],
  ["RXV35WVMA / FTXV35WVMA", 1020],
  ["RXV50WVMA / FTXV50WVMA", 1400],
  ["RXV60WVMA / FTXV60WVMA", 1565],
  ["RXV71WVMA / FTXV71WVMA", 1745],
  ["RXV80WVMA / FTXV80WVMA", 2146],
  ["RXV90WVMA / FTXV90WVMA", 2522],
  ["RXM25YVMA / FTXM25YVMA", 900],
  ["RXM35YVMA / FTXM35YVMA", 1120],
  ["RXM46WVMA / FTXM46WVMA", 1380],
  ["RXM50WVMA / FTXM50WVMA", 1530],
  ["RXM60WVMA / FTXM60WVMA", 1680],
  ["RXM71WVMA / FTXM71WVMA", 1910],
];

assert.match(scopedDaikinUpdateSection, /businessName!=='s&h air con' && businessName!=='s&h air conditioning'/);
assert.match(scopedDaikinUpdateSection, /entry\.locked=true/);
for (const [model, price] of sAndHPrices) {
  assert.match(scopedDaikinUpdateSection, new RegExp(`model:"${model.replaceAll("/", "\\/")}",unitPriceInc:${price}\\.00`));
}

assert.doesNotMatch(globalDaikinUpdateSection, /businessName|s&h air con|entry\.locked=true/);
assert.match(
  source,
  /const list=type==='ducted'\?DUCTED_PRODUCTS:SPLIT_PRODUCTS;\s*return activeBusinessState\(\)==='NSW'\?list:list\.filter\(product=>product\.nswOnly!==true\);/,
  "NSW-only products must be hidden from non-NSW default catalogues.",
);
assert.match(source, /loadManagedPrices\(\);\s*applyBusinessDaikinSplitPriceOverrides\(\);/);
assert.doesNotMatch(scopedDaikinUpdateSection, /DUCTED_PRODUCTS|ANDOS_DUCTED_PRODUCTS/);

console.log("Daikin business catalogue checks passed.");
