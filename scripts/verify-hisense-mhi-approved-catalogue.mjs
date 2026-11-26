import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildPublicRebateCatalogue } from "../lib/public-rebate-catalogue.ts";

const approved = [
  ...[["HAWK25KR", 2.5], ["HAWK35KR", 3.5], ["HAWK50KR", 5.4], ["HAWK71KR", 7.1], ["HAWK80KR", 8]]
    .map(([model, capacity]) => ({ brand: "Hisense", series: "X4", model, capacity, outdoor: `${model}-O`, indoor: `${model}-I` })),
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
const baseline = execFileSync("git", ["show", "65f79fce9ae43e12799c7d929b62813eca3516e6:index.html"], {
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
  { brand: "Hisense", model: "HAWK25KR", series: "X4", capacityNum: 2.5, phase: "Single", type: "split", nswOnly: true,
    catalogueAdditionId: "fixture-hawk25kr", unitPriceInc: 731, priceIncGst: 731, rebate: 0 },
  { brand: "Hisense", model: "HAWH9KR", series: "X5", capacityNum: 2.5, phase: "Single", type: "split", nswOnly: true,
    catalogueAdditionId: "fixture-hawh9kr", unitPriceInc: 0, priceIncGst: 0, rebate: 0 },
  { brand: "Hisense", model: "TEST-VERIFIED-SPLIT", type: "split", nswOnly: true,
    catalogueAdditionId: "fixture-other-verified", unitPriceInc: 731, priceIncGst: 731, rebate: 0 },
];
const businessFixture = { brand: "Hisense", model: "TEST-BUSINESS-SPLIT", type: "split", unitPriceInc: 0, priceIncGst: 0, rebate: 0 };
const normalize = value => String(value).toUpperCase().replace(/[^A-Z0-9]/g, "");

function loadCatalogues(html, catalogue = "default", state = "NSW", additions = [], businessProducts = [businessFixture], type = "split") {
  const sandbox = {
    activeCatalogKey: () => catalogue,
    activeBusinessState: () => state,
    activeBusinessConfiguration: () => true,
    businessConfigurationCache: { products: structuredClone(businessProducts) },
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
    globalThis.effective=productListFor(${JSON.stringify(type)});
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
const beforeDucted = execFileSync("git", ["show", "c006a9ae0ef949f3ed7a15fed6047290d86e1f40:index.html"], {
  cwd: new URL("../", import.meta.url), encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
});
const ductedModels = ["FDCA125VSX-W / FDUA125VH", "FDCA125VSX-W / FDU125VH"];
for (const catalogue of ["default", "andos"]) {
  for (const state of ["NSW", "QLD"]) {
    for (const duplicate of [null, "business", "verified"]) {
      const fixture = model => ({ type: "ducted", brand: "Mitsubishi Heavy Industries", model, phase: "Three", unitPriceInc: 1234, priceIncGst: 1234 });
      const business = [fixture("BUSINESS-EXAMPLE")], verified = [fixture("VERIFIED-EXAMPLE")];
      if (duplicate) (duplicate === "business" ? business : verified).push(fixture(ductedModels[0]));
      const args = [catalogue, state, verified, business, "ducted"];
      const original = loadCatalogues(beforeDucted, ...args).effective;
      const updated = loadCatalogues(source, ...args).effective;
      assertPreservedPrefix(original, updated, [catalogue, state, duplicate].join("/"));
      const added = updated.slice(original.length);
      const expected = state !== "NSW" ? [] : ductedModels.filter((_, i) => !duplicate || i !== 0);
      assert.deepEqual(added.map(p => p.model), expected);
      for (const row of added) {
        assert.equal(row.phase, "Three"); assert.equal(row.capacityNum, 12.5);
        assert.equal(row.nswOnly, true); assert.equal(row.priceIncGst, 0); assert.equal(row.unitPriceInc, 0);
      }
    }
  }
}
for (const model of ductedModels) {
  assert.equal(publicCatalogue.products.filter(p => p.model === model && p.systemType === "ducted" && p.capacityKw === 12.5).length, 1);
}
for (const catalogue of ["default", "andos"]) {
  for (const product of approved.filter(p => p.series === "X4")) {
    const pairs = [" / ", " - ", ", ", " "].flatMap(separator => [
      `${product.outdoor}${separator}${product.indoor}`, `${product.indoor}${separator}${product.outdoor}`,
    ]);
    for (const model of pairs) {
      const pair = { brand: "Hisense", model, type: "split", series: "X4", phase: "Single", capacityNum: product.capacity,
        nswOnly: true, unitPriceInc: 731, priceIncGst: 731, rebate: 0 };
      for (const location of ["business", "verified"]) {
        const additions = location === "verified" ? [pair] : [];
        const businessProducts = location === "business" ? [businessFixture, pair] : [businessFixture];
        const beforePairs = loadCatalogues(baseline, catalogue, "NSW", additions, businessProducts).effective;
        const afterPairs = loadCatalogues(source, catalogue, "NSW", additions, businessProducts).effective;
        assertPreservedPrefix(beforePairs, afterPairs, `${catalogue}/${location}/${model}`);
        const matches = afterPairs.filter(row => matchesApproved(row, product));
        assert.equal(matches.length, 1, "An existing complete pair must not gain a duplicate canonical row");
        assert.equal(matches[0].model, model, "Keep the original pair identity and saved price key");
        assert.equal(matches[0].unitPriceInc, 731, "Keep the existing pair price");
      }
      const aliasSandbox = {};
      vm.runInNewContext(section(source, "const REBATE_LOOKUP_MODEL_ALIASES=", "function multiOutdoor(") +
        `globalThis.aliases=REBATE_LOOKUP_MODEL_ALIASES;`, aliasSandbox);
      assert.ok(aliasSandbox.aliases[normalize(model)].includes(product.model), "Existing pair resolves to canonical rebate system");
    }
  }
}
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

console.log("Hisense X4/X5 and MHI Avanti/Ciara: baseline indices and prices, NSW visibility, verified dedupe, zero static rebates and estimator aliases passed.");
