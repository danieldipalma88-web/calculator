import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildPublicRebateCatalogue } from "../lib/public-rebate-catalogue.ts";

const source = await readFile(new URL("../index.html", import.meta.url), "utf8");
const fixture = JSON.parse(await readFile(new URL("./fixtures/temperzone-templite-gems.json", import.meta.url), "utf8"));
const start = source.indexOf("const SPLIT_PRODUCTS =");
const end = source.indexOf("let systemType='split'");
assert.ok(start >= 0 && end > start);
const sandbox = Object.create(null);
vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.catalogues={split:SPLIT_PRODUCTS,ducted:DUCTED_PRODUCTS,andos:ANDOS_DUCTED_PRODUCTS};`, sandbox, { timeout: 8000 });
const normalize = value => String(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
const expectedCapacities = [8.5, 10, 13, 14.5, 16];
assert.deepEqual(fixture.models.map(row => Number(row["Cooling Capacity"])), expectedCapacities);

for (const catalogueName of ["ducted", "andos"]) {
  const products = sandbox.catalogues[catalogueName].filter(row => row.brand === "Temperzone" && !row.deprecated);
  assert.equal(products.length, 5, `${catalogueName}: five Temperzone models`);
  for (const registered of fixture.models) {
    assert.equal(registered.SubmitStatus, "Approved");
    assert.equal(registered["Availability Status"], "Available");
    assert.match(registered.Sold_in, /Australia/);
    const matches = products.filter(row => normalize(row.model) === normalize(registered.model));
    assert.equal(matches.length, 1, `${catalogueName}: exact pairing ${registered.model}`);
    const product = matches[0];
    assert.equal(product.model, registered.model, "Keep the exact registered spelling and outdoor/indoor order");
    assert.equal(product.capacityNum, Number(registered["Cooling Capacity"]));
    assert.equal(product.size, product.capacityNum);
    assert.equal(product.phase, "Single");
    assert.equal(product.series, "Templite R32");
    assert.equal(product.refrigerant, "R32");
    assert.equal(product.unitPriceInc, 0);
    assert.equal(product.priceIncGst, 0);
    assert.equal(product.rebate, 0, "Rebates must be calculated, not stored as defaults");
    assert.equal(product.nswOnly, true);
    assert.equal(product.warrantyYears, 5);
    assert.equal(product.warrantyLabel, "5 yrs parts & labour (conditions apply)");
    assert.equal(product.wifiStatus, "unknown", "Do not claim unverified built-in or optional Wi-Fi");
    assert.equal(product.wifiLabel, "Wi-Fi unconfirmed");
    assert.equal(product.originLabel, "New Zealand", "Company origin, not the manufacturing country");
    assert.equal(product.controllerModel, "TZT 04");
    assert.equal(product.controllerIncluded, true);
    assert.equal(product.controllerCableMetres, 8);
    assert.doesNotMatch(product.model, /TZT/);
  }
}
assert.equal(sandbox.catalogues.split.filter(row => row.brand === "Temperzone").length, 0, "Ducted systems must not be added to wall splits");
const publicCatalogue = await buildPublicRebateCatalogue();
const publicModels = publicCatalogue.products.filter(row => row.brand === "Temperzone");
assert.equal(publicModels.length, 5, "The estimator must get the same five systems, not duplicate partner rows");
for (const registered of fixture.models) {
  const product = publicModels.find(row => row.model === registered.model);
  assert.ok(product, registered.model);
  assert.equal(product.systemType, "ducted");
  assert.equal(product.capacityKw, Number(registered["Cooling Capacity"]));
  assert.equal(product.phase, "Single");
  assert.notEqual(product.dcceewEligible, true, "Do not add models to the contract-approved list");
  for (const part of registered.model.split("/").map(value => value.trim())) assert.ok(product.searchTerms.includes(part), `${part} is searchable`);
}
console.log("Temperzone: exact AU GEMS pairs, capacities, zero prices, controls, support and shared estimator catalogue passed.");
