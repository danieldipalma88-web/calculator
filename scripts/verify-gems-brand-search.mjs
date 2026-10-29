import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import * as gems from "../lib/gems-model-search.ts";
import { buildPublicRebateCatalogue } from "../lib/public-rebate-catalogue.ts";

const routeSource = await readFile(new URL("../app/api/gems-model-search/route.ts", import.meta.url), "utf8");
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(routeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  exports: module.exports,
  require: (name) => {
    if (name === "next/server") return { NextResponse: { json: (payload, init) => Response.json(payload, init) } };
    assert.equal(name, "../../../lib/gems-model-search");
    return gems;
  },
  Map, Set,
});
const { GET } = module.exports;
const queryRoute = async (query) => {
  const response = await GET({ nextUrl: new URL(`https://calculator.example/api/gems-model-search?${query}`) });
  return { status: response.status, cacheControl: response.headers.get("cache-control"), ...await response.json() };
};
const variant = (model, overrides = {}) => ({
  Brand: "Rinnai", Model_No: model, SubmitStatus: "Approved", "Availability Status": "Available", Sold_in: "Australia",
  "C-Total Cool Rated": "14.0", "H-Total Heat Rated": "17.0", ...overrides,
});
const current = "DONSR15B1TA/DINLR15B1SA";
const legacy = "DONSR15B1/DINLR15B1";
const records = [
  variant(legacy, { Brand: "RINNAI", "H-Total Heat Rated": "14.5" }),
  variant(legacy), variant(current), variant("DONSR15B1LA/DINLR15B1SA"),
  variant("DONSR15B1-REJECTED", { SubmitStatus: "Pending" }),
  variant("DONSR15B1-UNAVAILABLE", { "Availability Status": "Unavailable" }),
  variant("DONSR15B1-NZ-ONLY", { Sold_in: "New Zealand" }),
  variant(legacy, { Brand: "Other" }),
];
const originalFetch = globalThis.fetch;
const requests = [];
let unavailable = false;
let cachedRecords = records;
let freshRecords = records;
let freshUnavailable = false;
globalThis.fetch = async (url, options) => {
  requests.push({ url: new URL(url), options });
  if (unavailable) throw new Error("GEMS fixture unavailable");
  if (options.next.revalidate === 0 && freshUnavailable) throw new Error("Fresh GEMS fixture unavailable");
  return Response.json({ success: true, result: { records: options.next.revalidate === 0 ? freshRecords : cachedRecords } });
};
try {
  for (const query of [legacy, "donsr15b1 - dinlr15b1", "DINLR15B1", "DONSR15B1"]) {
    const result = await queryRoute(`brand=Rinnai&q=${encodeURIComponent(query)}`);
    assert.equal(result.status, 200);
    const exact = result.models.find((item) => item.model === legacy);
    assert.ok(exact, `Exact uppercase-brand pair must be searchable using ${query}.`);
    assert.equal(exact.brand, "RINNAI");
    assert.equal(exact.capacityKw, 14);
    assert.equal(result.models.filter((item) => item.model === legacy).length, 1);
    assert.ok(result.models.every((item) => item.brand.toUpperCase() === "RINNAI"));
    assert.ok(result.models.every((item) => !/REJECTED|UNAVAILABLE|NZ-ONLY/.test(item.model)));
  }
  for (const brand of ["RINNAI", "rinnai"]) {
    assert.ok((await queryRoute(`brand=${brand}&q=${encodeURIComponent(legacy)}`)).models.some((item) => item.model === legacy));
  }
  const partial = await queryRoute("brand=Rinnai&q=DONSR15B1");
  assert.equal(partial.models.length, 3, "Different outdoor suffixes must stay distinct.");
  const brands = await queryRoute("mode=brands");
  assert.equal(brands.brands.filter((brand) => brand.toLowerCase() === "rinnai").length, 1);
  assert.ok(brands.brands.includes("Rinnai"));
  assert.equal((await queryRoute("brand=Rinnai&q=MISSING")).models.length, 0);
  assert.equal((await queryRoute("brand=Rinnai&q=x")).status, 400);
  assert.equal((await queryRoute("q=DONSR15B1")).status, 400);
  const inventories = requests.filter((item) => item.url.pathname.endsWith("datastore_search_sql"));
  assert.ok(inventories.length >= 6);
  assert.ok(inventories.every((item) => /LOWER\("Brand"\) = LOWER\('/.test(item.url.searchParams.get("sql"))));
  assert.ok(inventories.every((item) => item.url.searchParams.get("sql").includes('"SubmitStatus" = \'Approved\'') && item.url.searchParams.get("sql").includes('"Availability Status" = \'Available\'')));
  assert.ok(inventories.every((item) => [0, 3_600].includes(item.options.next.revalidate)));
  assert.equal(inventories.filter((item) => item.options.next.revalidate === 0).length, 1, "Only a missing search should recheck fresh data.");
  await gems.fetchGemsDatastoreRecords({ brand: "Rinnai' OR 1=1 --", fields: ["Brand"], limit: 5, revalidateSeconds: 3_600 });
  assert.ok(requests.at(-1).url.searchParams.get("sql").includes("LOWER('Rinnai'' OR 1=1 --')"), "Brand SQL literals must be escaped.");
  await gems.fetchGemsDatastoreRecords({ query: legacy, limit: 25, revalidateSeconds: 3_600 });
  assert.ok(requests.at(-1).url.pathname.endsWith("datastore_search"));
  assert.equal(requests.at(-1).url.searchParams.get("q"), legacy, "Metadata queries must preserve their existing paired identifiers.");

  const alira = ["20", "25", "35", "46", "50", "60", "71"].map((size) => variant(`RXM${size}AVMA / FTXM${size}AVMA`, { Brand: "DAIKIN" }));
  cachedRecords = freshRecords = alira;
  for (const model of alira) {
    const [outdoor, indoor] = model.Model_No.split(" / ");
    for (const query of [model.Model_No, `${indoor} / ${outdoor}`, `${indoor} ${outdoor}`, outdoor, indoor, model.Model_No.toLowerCase()]) {
      const before = requests.length;
      const result = await queryRoute(`brand=Daikin&q=${encodeURIComponent(query)}`);
      assert.equal(result.status, 200);
      assert.equal(result.cacheControl, "no-store");
      assert.equal(result.models.length, 1);
      assert.equal(result.models[0].model, model.Model_No, `Keep canonical register pairing for ${query}`);
      assert.equal(requests.length - before, 1, "Successful cached searches need no fresh fetch.");
    }
  }
  assert.equal((await queryRoute("brand=Daikin&q=RXM35AVMA%20%2F%20FTXM50AVMA")).models.length, 0, "Never combine indoor and outdoor models from separate registrations.");
  cachedRecords = [];
  const refreshed = await queryRoute("brand=Daikin&q=RXM35AVMA%20%2F%20FTXM35AVMA");
  assert.equal(refreshed.models[0].model, "RXM35AVMA / FTXM35AVMA", "An empty cached inventory must not hide a freshly registered model.");
  assert.equal(requests.at(-1).options.next.revalidate, 0);
  assert.equal(refreshed.cacheControl, "no-store");
  freshRecords = [variant("RXM35AVMA / FTXM35AVMA", { Brand: "DAIKIN", SubmitStatus: "Pending" })];
  const excluded = await queryRoute("brand=Daikin&q=RXM35AVMA");
  assert.equal(excluded.models.length, 0, "Fresh rechecks must retain registration eligibility filters.");
  assert.equal(excluded.cacheControl, "no-store", "Negative responses must not stay cached at the edge.");
  freshUnavailable = true;
  const failedRefresh = await queryRoute("brand=Daikin&q=RXM35AVMA");
  assert.equal(failedRefresh.status, 503, "A failed fresh recheck is an outage, not proof of no matching model.");
  assert.ok(failedRefresh.error);
  assert.equal(failedRefresh.cacheControl, "no-store");
  unavailable = true;
  assert.equal((await queryRoute("brand=Rinnai&q=DONSR15B1")).status, 503);
} finally {
  globalThis.fetch = originalFetch;
}

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const start = html.indexOf("const SPLIT_PRODUCTS =");
const end = html.indexOf("let systemType='split'");
const sandbox = Object.create(null);
vm.runInNewContext(`${html.slice(start, end)};globalThis.ducted=DUCTED_PRODUCTS;`, sandbox);
const product = sandbox.ducted.filter((item) => item.brand === "Rinnai" && item.model === legacy);
assert.equal(product.length, 1);
assert.equal(product[0].capacityNum, 14);
assert.equal(product[0].phase, "Single");
assert.equal(product[0].unitPriceInc, 0);
assert.equal(product[0].priceIncGst, 0);
assert.equal(product[0].rebate, 0);
assert.equal(product[0].warrantyYears, 7);
assert.equal(product[0].wifiStatus, "included");
assert.equal(product[0].nswOnly, true);
assert.equal(sandbox.ducted.find((item) => item.model === current).unitPriceInc, 2968.81, "Existing variant price must remain unchanged.");
const catalogue = await buildPublicRebateCatalogue();
assert.equal(catalogue.products.filter((item) => item.model === legacy && item.systemType === "ducted").length, 1);
console.log("Case-insensitive GEMS search, exact Rinnai pair, distinct variants, brand deduplication, eligibility filters, SQL escaping, cache settings and catalogue/support/price checks passed.");
