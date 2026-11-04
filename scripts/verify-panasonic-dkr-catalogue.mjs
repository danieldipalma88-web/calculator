import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { buildPublicRebateCatalogue } from "../lib/public-rebate-catalogue.ts";

// [model size, rated capacity, Z default/Andos ex-GST, RZ default/Andos ex-GST].
const sizes = [
  [25, 2.5, 914.10, 895, 796.40, 775],
  [35, 3.5, 1107.70, 1095, 962.50, 950],
  [42, 4.2, 1310.10, 1300, 1138.50, 1100],
  [50, 5.0, 1512.50, 1500, 1315.60, 1300],
  [60, 6.0, 1698.40, 1630, 1477.30, 1445],
  [71, 7.1, 1900.80, 1820, 1652.20, 1595],
  [80, 8.0, 2443.10, 2182, 2125.20, 2110],
  [95, 9.5, 2871.00, 2745, 2497.00, 2464],
];
const expected = sizes.flatMap(([size, capacity, z, andosZ, rz, andosRz]) =>
  [["Z", z, andosZ], ["RZ", rz, andosRz]].map(([series, price, andosExGst]) => ({
    model: `CU-${series}${size}DKR / CS-${series}${size}DKR${size < 80 ? "W" : ""}`,
    capacity, series: `${series} Series - DKR`, price, andos: Math.round(andosExGst * 110) / 100,
  })));
const models = new Set(expected.map(x => x.model));

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const source = html.slice(html.indexOf("const SPLIT_PRODUCTS ="), html.indexOf("let systemType='split'"));
const baseList = html.slice(html.indexOf("function baseProductListFor(type)"), html.indexOf("const verifiedCatalogueProductCache"));
const context = {};
vm.runInNewContext(source + baseList + "\nglobalThis.catalogues={default:SPLIT_PRODUCTS,andos:ANDOS_SPLIT_PRODUCTS};globalThis.base=baseProductListFor;", context);
for (const [key, catalogue] of Object.entries(context.catalogues)) {
  assert.equal(catalogue.filter(x => models.has(x.model)).length, 16);
  assert.ok(catalogue.slice(-16).every(x => models.has(x.model)), "Existing price and quote indices must not shift");
  for (const p of expected) {
    const entry = catalogue.find(x => x.model === p.model);
    const price = key === "andos" ? p.andos : p.price;
    assert.equal(entry.brand, "Panasonic");
    assert.equal(entry.capacityNum, p.capacity);
    assert.equal(entry.series, p.series);
    assert.equal(entry.unitPriceInc, price, p.model);
    assert.equal(entry.priceIncGst, price, p.model);
    assert.equal(entry.rebate, 0);
    assert.equal(entry.phase, "Single");
    assert.equal(entry.wifiStatus, "unknown");
    assert.equal(entry.warrantyYears, null);
  }
  context.activeCatalogKey = () => key;
  context.activeBusinessState = () => "NSW";
  assert.equal(context.base("split").filter(x => models.has(x.model)).length, 16);
  context.activeBusinessState = () => "QLD";
  assert.equal(context.base("split").filter(x => models.has(x.model)).length, 0);
}

const publicCatalogue = await buildPublicRebateCatalogue();
assert.deepEqual(publicCatalogue.counts, { split: 273, ducted: 210, total: 483 });
assert.ok(!publicCatalogue.products.some(x => /^CU-R?Z20DKR\b/.test(x.model)));
for (const {model,capacity} of expected) {
  const entries = publicCatalogue.products.filter(x => x.model === model);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].capacityKw, capacity);
  for (const part of model.split(" / ")) assert.ok(entries[0].searchTerms.includes(part));
  assert.ok(!("priceIncGst" in entries[0]), "No pricing in the public catalogue");
}
const privateProduct = { brand:"LG", model:"PRIVATE OUT / PRIVATE IN", unitPriceInc:1234 };
const dkr = expected[0];
const priorVerified = { brand:"Panasonic", model:dkr.model, type:"split", catalogueAdditionId:"existing-verified-id", unitPriceInc:777 };
const unpricedVerified = { brand:"Panasonic", model:expected[2].model, type:"split", catalogueAdditionId:"unpriced-verified-id", unitPriceInc:0 };
const unpricedPrivate = { brand:"Panasonic", model:expected[3].model, unitPriceInc:0, businessProductId:"private-id" };
const runtime = {
  baseProductListFor: context.base,
  mergeBusinessProducts: (_type, list) => [...list, privateProduct, unpricedPrivate],
  activeCatalogKey: () => "default", activeBusinessState: () => "NSW",
  calculatorUserContext: () => ({businessId:"fixture"}),
  normaliseBrandName: x => x, normaliseModelName: x => x,
  normalizeLookup: x => String(x).toUpperCase().replace(/[^A-Z0-9]/g, ""),
  brandsEquivalent: (a,b) => a===b,
  hasPositiveUnitPrice: x => Number.isFinite(Number(x))&&Number(x)>0,
  window:{__verifiedCatalogueAdditions:[priorVerified,unpricedVerified]},
};
context.activeCatalogKey = runtime.activeCatalogKey;
context.activeBusinessState = runtime.activeBusinessState;
const runtimeSource = html.slice(html.indexOf("const verifiedCatalogueProductCache"),html.indexOf("function data()"));
const restoreSource = html.slice(html.indexOf("function parseManagedIndexFromKey"),html.indexOf("function findMultiSplitOutdoorFromState"));
const priceGuardSource = html.slice(html.indexOf("function managedIndexSavedBelongsToCurrentItem"),html.indexOf("function migrateManagedDefaultPrice"));
vm.runInNewContext(runtimeSource + restoreSource + priceGuardSource + "\n" +
  "globalThis.products=productListFor;globalThis.restore=productLookupIndexFromState;globalThis.priceBelongs=managedIndexSavedBelongsToCurrentItem;",runtime);
runtime.savedManagedModelNorm = (saved) => runtime.normalizeLookup(saved?.model || "");
const effective = runtime.products("split");
const existingCount = context.catalogues.default.length - expected.length;
assert.equal(effective[existingCount], privateProduct, "Legacy index-only prices must still resolve to the original business row");
assert.equal(effective[existingCount+1].businessProductId, "private-id");
assert.equal(effective[existingCount+1].unitPriceInc, expected[3].price, "An unpriced private row gets the equivalent default at its original index");
assert.equal(effective[existingCount+2], priorVerified, "Prior verified row and its managed pricing key are preserved");
assert.equal(effective[existingCount+3].catalogueAdditionId, "unpriced-verified-id");
assert.equal(effective[existingCount+3].unitPriceInc, expected[2].price, "An unpriced verified row gets the equivalent default without replacing its ID");
assert.equal(effective.filter(p=>p.model===dkr.model).length,1);
assert.equal(runtime.restore({brand:"Panasonic",model:dkr.model,productManagedKey:"split|verified_existing-verified-id"},effective),existingCount+2);
const lateEntry = effective.find(p=>p.model===expected[1].model);
assert.ok(lateEntry.lateCatalogueEntry);
assert.equal(runtime.priceBelongs({unitPriceInc:5},{p:lateEntry},[]),false,"An orphaned index-only price cannot apply to a late entry");
assert.equal(runtime.priceBelongs({unitPriceInc:5,model:lateEntry.model},{p:lateEntry},[]),true);
const items = [
  {p:effective[existingCount+1],type:"split",key:`split|${existingCount+1}`},
  {p:effective[existingCount+3],type:"split",key:"split|verified_unpriced-verified-id"},
];
const storageKey = "installerManagedPricesV1";
const stored = new Map([[storageKey,JSON.stringify({
  [items[0].key]:{model:items[0].p.model,unitPriceInc:1099,locked:true},
  [items[1].key]:{model:items[1].p.model,unitPriceInc:0,locked:true},
})]]);
Object.assign(runtime,{
  allManagedProducts:()=>items,PRICE_STORAGE_KEY:storageKey,legacyStorageKey:x=>`legacy_${x}`,
  localStorage:{getItem:k=>stored.get(k)??null,setItem:(k,v)=>stored.set(k,v)},
  MANAGED_PRICE_DEFAULT_MIGRATIONS:[],aadPriceCode:runtime.normalizeLookup,equipmentPriceIsEmpty:x=>!Number(x),
  normalizedMultiSplitManagedPriceEntry:()=>null,applyAllManagedMultiSplitPrices:()=>{},priceLocks:{},
});
const loader = html.slice(html.indexOf("function defaultManagedPriceEntry"),html.indexOf("let priceDrawerReturnFocus"));
const legacyKey = html.slice(html.indexOf("function legacyProductKey"),html.indexOf("function allManagedProducts"));
vm.runInNewContext(legacyKey+loader+"\nloadManagedPrices();",runtime);
assert.equal(items[0].p.unitPriceInc,1099,"Existing positive business override wins");
assert.equal(items[1].p.unitPriceInc,expected[2].price,"A saved zero default cannot hide the newly priced verified model");
assert.equal(JSON.parse(stored.get(storageKey))[items[1].key].unitPriceInc,0,"The effective default is not saved as a business override");
console.log("Panasonic DKR: 16 exact NSW split pairs, matched GST-inclusive catalogue prices, stable append-only indices and estimator passed.");

if (process.argv.includes("--live")) {
  const modules = new Map();
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const json = name.endsWith(".json");
    const source = readFileSync(new URL(`../lib/${name}${json ? "" : ".ts"}`, import.meta.url), "utf8");
    const exports = json ? JSON.parse(source) : {};
    modules.set(name, exports);
    if (!json) {
      const {outputText} = ts.transpileModule(source, {
        compilerOptions: {module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022, esModuleInterop:true},
      });
      vm.runInThisContext(`(function(exports, require) { ${outputText}\n})`)(exports, path => {
        assert.match(path, /^\.\/[\w.-]+$/);
        return load(path.slice(2));
      });
    }
    return exports;
  }
  const {verifyRequestedModel} = load("model-request-verification");
  const {fetchGemsDatastoreRecords} = load("gems-model-search");
  let inventory;
  const fetchRecords = (options) => inventory ||= fetchGemsDatastoreRecords(options);
  const checks = expected.flatMap(({model,capacity}) => ["new","replacement"].map(install_type => ({
    system_type:"split",brand:"Panasonic",model,capacity:String(capacity),phase:"single",postcode:"2000",install_type,
  })));
  for (const postcode of ["2000", "2480", "2627", "2830"]) {
    for (const install_type of ["new", "replacement"]) checks.push({
      system_type:"split",brand:"Panasonic",model:"CU-Z20DKR / CS-Z20DKRW",capacity:"2.05",phase:"single",postcode,install_type,
    });
  }
  const results = [];
  for (let i = 0; i < checks.length; i += 4) {
    results.push(...await Promise.all(checks.slice(i,i+4).map(async input => {
      try {
        const result = await verifyRequestedModel(input, {fetchRecords});
        return {model:input.model, postcode:input.postcode, install:input.install_type, kind:result.kind,
          registration:result.evidence?.registry?.registrationNumber, reason:result.reason,
          esc:result.evidence?.certificates?.esc, prc:result.evidence?.certificates?.prc};
      } catch (error) {
        return {model:input.model, install:input.install_type, kind:"error", reason:error.message};
      }
    })));
  }
  const passed = results.filter(x => x.kind === "verified");
  const excluded = results.filter(x => !models.has(x.model));
  console.log(JSON.stringify({positiveChecks:passed.length,excluded,unexpected:results.filter(x=>models.has(x.model)&&x.kind!=="verified")}));
  assert.ok(results.filter(x => models.has(x.model)).every(x => x.kind === "verified"), "Do not publish pairs without verified live certificate results");
  assert.ok(excluded.every(x => x.registration === "AAC10218" && x.esc === 0 && x.prc === 0), "Reassess the exclusion if the Z 2.0 kW certificate check changes");
}
