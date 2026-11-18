import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildPublicRebateCatalogue } from "../lib/public-rebate-catalogue.ts";

const approved = [
  ...[["HAWH9KR", 2.5], ["HAWH12KR", 3.7], ["HAWH18KR", 5.1], ["HAWH24KR", 7.2], ["HAWH28KR", 8]]
    .map(([model, capacity]) => ({ brand: "Hisense", series: "X5", model, capacity, outdoor: `${model}-O`, indoor: `${model}-I` })),
  ...[
    ["Avanti", "DXC06ZSA-W", "DXK06ZSA-W", 2],
    ["Avanti", "DXC09ZSA-W", "DXK09ZSA-W", 2.5],
    ["Avanti", "DXC12ZSA-W", "DXK12ZSA-W", 3.5],
    ["Avanti", "DXC18ZSA-W", "DXK18ZSA-W", 5],
    ["Ciara", "DXC24ZTLA-WJ", "DXK24ZTLA-WFJ", 7.1],
  ].map(([series, outdoor, indoor, capacity]) => ({
    brand: "Mitsubishi Heavy Industries", series, model: `${outdoor} / ${indoor}`, capacity, outdoor, indoor,
  })),
];

// Pin the original HEAD so the regression still runs after the catalogue is committed.
const baseline = execFileSync("git", ["show", "d94c8bd292f93a78575b470278892575cc088c6c:index.html"], {
  cwd: new URL("../", import.meta.url), encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
});
const source = await readFile(new URL("../index.html", import.meta.url), "utf8");

function section(html, startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start + 1);
  assert.ok(start >= 0 && end > start, `Could not isolate ${startMarker}`);
  return html.slice(start, end);
}

const verifiedFixture = [
  { brand: "Hisense", model: "HAWH9KR", series: "X5", capacityNum: 2.5, phase: "Single", type: "split", nswOnly: true,
    catalogueAdditionId: "fixture-hawh9kr", unitPriceInc: 0, priceIncGst: 0, rebate: 0 },
  { brand: "Hisense", model: "TEST-VERIFIED-SPLIT", type: "split", nswOnly: true,
    catalogueAdditionId: "fixture-other-verified", unitPriceInc: 731, priceIncGst: 731, rebate: 0 },
];
const businessFixture = { brand: "Hisense", model: "TEST-BUSINESS-SPLIT", type: "split", unitPriceInc: 0, priceIncGst: 0, rebate: 0 };
const normalize = value => String(value).toUpperCase().replace(/[^A-Z0-9]/g, "");

function loadCatalogues(html, catalogue = "default", state = "NSW", additions = []) {
  const sandbox = {
    activeCatalogKey: () => catalogue,
    activeBusinessState: () => state,
    activeBusinessConfiguration: () => true,
    businessConfigurationCache: { products: [structuredClone(businessFixture)] },
    calculatorUserContext: () => ({ businessId: "fixture" }),
    normaliseBrandName: brand => brand,
    normalizeLookup: normalize,
    hasPositiveUnitPrice: price => Number.isFinite(Number(price)) && Number(price) > 0,
    window: { __verifiedCatalogueAdditions: structuredClone(additions) },
  };
  vm.runInNewContext(`
    ${section(html, "const SPLIT_PRODUCTS =", "let systemType='split'")}
    ${section(html, "function mergeBusinessProducts(type,list)", "function data()")}
    globalThis.raw={default:SPLIT_PRODUCTS,andos:ANDOS_SPLIT_PRODUCTS,ducted:DUCTED_PRODUCTS,andosDucted:ANDOS_DUCTED_PRODUCTS};
    globalThis.effective=productListFor('split');
  `, sandbox, { timeout: 8000 });
  return { raw: structuredClone(sandbox.raw), effective: structuredClone(sandbox.effective) };
}

function matchesApproved(row, { brand, model, outdoor, indoor }) {
  const key = normalize(row.model);
  return row.brand === brand && [model, outdoor + indoor, indoor + outdoor].some(value => normalize(value) === key);
}

function assertPreservedPrefix(before, after, label, project = row => row) {
  assert.ok(after.length >= before.length, `${label}: no existing rows may be removed`);
  before.forEach((row, index) => {
    assert.deepEqual(project(after[index]), project(row), `${label}|${index}: preserve ${row.model}`);
  });
}

function assertApprovedRow(rows, product, label) {
  const name = `${label}: ${product.model}`;
  const matches = rows.filter(row => matchesApproved(row, product));
  assert.equal(matches.length, 1, `${name} must appear exactly once`);
  const [row] = matches;
  assert.ok(!row.deprecated && !row.accessory, `${name} must be an active split system`);
  assert.equal(normalize(row.model), normalize(product.model), `${name} uses the canonical model`);
  assert.equal(row.series, product.series, `${name} series`);
  assert.equal(row.capacityNum, product.capacity, `${name} cooling capacity`);
  assert.equal(row.phase, "Single", `${name} phase`);
  assert.equal(row.nswOnly, true, `${name} NSW visibility`);
  assert.equal(row.rebate, 0, `${name} must not carry a static rebate`);
  return row;
}

const before = loadCatalogues(baseline).raw;
const after = loadCatalogues(source).raw;
for (const [name, rows] of Object.entries(before)) assertPreservedPrefix(rows, after[name], name);

for (const catalogue of ["default", "andos"]) {
  const qld = loadCatalogues(source, catalogue, "QLD", verifiedFixture).effective;
  for (const product of approved) {
    const row = assertApprovedRow(after[catalogue], product, `${catalogue}/static NSW`);
    if (after[catalogue].indexOf(row) >= before[catalogue].length) {
      assert.equal(row.lateCatalogueEntry, true, `${catalogue}: ${product.model} must follow existing runtime rows`);
      assert.equal(row.unitPriceInc, 0, `${catalogue}: ${product.model} is unpriced`);
      assert.equal(row.priceIncGst, 0, `${catalogue}: ${product.model} is unpriced including GST`);
    }
    assert.ok(!qld.some(item => matchesApproved(item, product)), `${catalogue}/QLD must not show ${product.model}`);
  }

  for (const additions of [[], verifiedFixture]) {
    const label = `${catalogue}/NSW${additions.length ? "/with verified rows" : ""}`;
    const oldEffective = loadCatalogues(baseline, catalogue, "NSW", additions).effective;
    const effective = loadCatalogues(source, catalogue, "NSW", additions).effective;
    // The generic late merge may decorate a verified row; preserve the actual position, identity and prices.
    assertPreservedPrefix(oldEffective, effective, label, ({ brand, model, unitPriceInc, priceIncGst, catalogueAdditionId }) =>
      ({ brand, model, unitPriceInc, priceIncGst, catalogueAdditionId }));
    for (const product of approved) assertApprovedRow(effective, product, label);
  }
}

const publicCatalogue = await buildPublicRebateCatalogue();
for (const product of approved) {
  const matches = publicCatalogue.products.filter(row => matchesApproved(row, product));
  assert.equal(matches.length, 1, `Estimator: ${product.model} must appear exactly once`);
  const [row] = matches;
  assert.equal(normalize(row.model), normalize(product.model), `Estimator: ${product.model} canonical model`);
  assert.equal(row.systemType, "split", `Estimator: ${product.model} system type`);
  assert.equal(row.capacityKw, product.capacity, `Estimator: ${product.model} cooling capacity`);
  for (const alias of [product.outdoor, product.indoor]) {
    assert.ok(row.searchTerms.some(term => normalize(term) === normalize(alias)), `Estimator: ${alias} must find ${product.model}`);
  }
}

console.log("Hisense X5 and MHI Avanti/Ciara: baseline indices and prices, NSW visibility, verified dedupe, zero static rebates and estimator aliases passed.");
