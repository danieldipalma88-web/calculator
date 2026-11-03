const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "index.html"), "utf8");
const route = fs.readFileSync(path.join(root, "app/calculator/raw/route.ts"), "utf8");
const code = (s) => String(s).toUpperCase().replace(/\s/g, "");
const compact = (s) => code(s).replace(/[^A-Z0-9]/g, "");
const fd = "RZA140C2V1 / FDYAN140AV1";
const daikin = "3MXM52R2VMA";
const head = "CTXM35RVMA";
const dynamic = "4U71S2PR1FA";
const approvedFile = process.env.AAD_AUDIT_FILE;
const sample = (row) => ({ ...row, sku: "FIXTURE", exGstCents: 100000, incGstCents: 110000 });
const data = approvedFile ? JSON.parse(fs.readFileSync(approvedFile, "utf8")) : {
  systems: [sample({ catalogue: "default", type: "ducted", brand: "Daikin", model: fd, phase: "Single" })],
  multi: [
    sample({ kind: "outdoor", brand: "Daikin", model: daikin, registryOnly: false }),
    sample({ kind: "indoor", brand: "Daikin", model: head, registryOnly: false }),
    sample({ kind: "outdoor", brand: "Haier", model: dynamic, registryOnly: true }),
  ],
};
const catalogueStart = source.indexOf("const SPLIT_PRODUCTS =");
const catalogueEnd = source.indexOf("let systemType='split'", catalogueStart);
const lists = vm.runInNewContext(source.slice(catalogueStart, catalogueEnd)
  + "\n({default:{split:SPLIT_PRODUCTS,ducted:DUCTED_PRODUCTS},andos:{split:ANDOS_SPLIT_PRODUCTS,ducted:ANDOS_DUCTED_PRODUCTS}})");
data.systems.forEach((row) => {
  const products = lists[row.catalogue][row.type];
  const matches = products.map((p, index) => ({ p, index })).filter(({ p }) =>
    !p.deprecated && p.brand === row.brand && code(p.model) === code(row.model) && (p.phase || "Single") === row.phase);
  assert.equal(matches.length, 1, `Unique stable key: ${row.model}`);
  assert(!matches[0].p.unitPriceInc && !matches[0].p.priceIncGst, `Nonzero base catalogue price: ${row.model}`);
  row.managedKey = [row.catalogue === "andos" ? "andos" : "", row.type, matches[0].index].filter(x=>x!=="").join("|");
});
const fdPrice = data.systems.find((row) => row.catalogue === "default" && row.model === fd).incGstCents / 100;
const sourceModel = (row) => JSON.stringify([
  row.catalogue || row.kind, row.type, row.brand, code(row.model), row.phase,
]);

if (approvedFile) assert.deepEqual([
  data.systems.filter((p) => p.type === "split").length,
  data.systems.filter((p) => p.type === "ducted").length,
  data.multi.filter((p) => p.kind === "outdoor").length,
  data.multi.filter((p) => p.kind === "indoor").length,
  data.multi.filter((p) => p.registryOnly).length,
], [10, 16, 36, 59, 16]);
const seen = new Set();
for (const p of [...data.systems, ...data.multi]) {
  assert(!seen.has(sourceModel(p)), `Duplicate price identity: ${p.model}`);
  seen.add(sourceModel(p));
  assert(p.sku && p.brand && p.model && Number.isSafeInteger(p.exGstCents) && p.exGstCents > 0);
  assert.equal(p.incGstCents, Math.floor((p.exGstCents * 110 + 50) / 100), p.sku);
}
assert.match(route, /business\?\.id && String\(business\.operating_state \|\| ""\)\.trim\(\)\.toUpperCase\(\) === "NSW" \? aadCataloguePrices : null/);
assert.match(route, /__aadCataloguePrices=\$\{safeScriptJson\(prices\)\}/);
assert.doesNotMatch(fs.readFileSync(path.join(root, "app/api/public-rebate-catalogue/route.ts"), "utf8"), /aad-price|__aadCataloguePrices/);

let prices;

async function pageFor(browser, { catalogue, businessState = "NSW", current = {}, legacy = {}, bare = {}, enabled = true, width = 1440 }) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.stack || e.message));
  await page.route("**/*", (req) => new URL(req.request().url()).pathname === "/"
    ? req.fulfill({ contentType: "text/html", body: source })
    : req.abort());
  await page.addInitScript(({ prices, catalogue, businessState, current, legacy, bare }) => {
    window.CALCULATOR_USER = {
      role: "admin", businessId: "isolated-aad-test",
      businessName: catalogue === "andos" ? "Andos Air" : "Example Air",
      businessOperatingState: businessState,
    };
    window.__aadCataloguePrices = prices;
    localStorage.setItem("installerManagedPricesV1", JSON.stringify(current));
    localStorage.setItem("greenEnergyManagedPricesV1", JSON.stringify(legacy));
    localStorage.setItem("ManagedPricesV1", JSON.stringify(bare));
  }, { prices: enabled ? prices : null, catalogue, businessState, current, legacy, bare });
  await page.goto("http://127.0.0.1:43824/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__calculatorReady === true);
  return { page, errors };
}
const assertClean = async ({ page, errors }) => {
  assert.deepEqual(errors, []);
  await page.close();
};
async function readSystem(page, { type, brand, model }) {
  return page.evaluate(({ type, brand, model }) => {
    const i = productListFor(type).findIndex((p) => p.brand === brand && p.model === model);
    if (i < 0) return null;
    const k = managedProductKey(type, i);
    return { key: k, price: productListFor(type)[i].unitPriceInc, stored: JSON.parse(localStorage.getItem(PRICE_STORAGE_KEY))[k] };
  }, { type, brand, model });
}
const selected = { type: "ducted", brand: "Daikin", model: fd };
async function readMulti(page, { kind, brand, model }) {
  return page.evaluate(({ kind, brand, model }) => {
    const row = (kind === "outdoor" ? MULTI_SPLIT_OUTDOORS : ALL_MODELS_MULTI_INDOORS).find((p) => p.brand === brand && p.model === model);
    return row ? { price: row.unitPriceInc, stored: JSON.parse(localStorage.getItem(PRICE_STORAGE_KEY))[multiSplitManagedPriceKey(kind, row)] } : null;
  }, { kind, brand, model });
}

(async () => {
  const { parseAadCataloguePriceDefaults, preserveAadTargetPrices } = await import("../lib/aad-catalogue-price-defaults.ts");
  const { mergeCalculatorData } = await import("../lib/quote-sync.ts");
  assert.equal(parseAadCataloguePriceDefaults(undefined), null);
  assert.equal(parseAadCataloguePriceDefaults("bad json"), null);
  assert.equal(parseAadCataloguePriceDefaults(JSON.stringify({ ...data, systems: [...data.systems, data.systems[0]] })), null);
  assert.equal(parseAadCataloguePriceDefaults(JSON.stringify({ ...data, multi: [{ ...data.multi[0], incGstCents: -1 }] })), null);
  prices = parseAadCataloguePriceDefaults(JSON.stringify(data));
  assert(prices);
  assert(!JSON.stringify(prices).includes("exGstCents") && !JSON.stringify(prices).includes('"sku"'));
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    let fdKey;
    for (const catalogue of ["default", "andos"]) {
      const fixture = await pageFor(browser, { catalogue });
      for (const row of data.systems.filter((p) => p.catalogue === catalogue)) {
        const result = await readSystem(fixture.page, row);
        assert(result, `Missing catalogue row: ${catalogue} ${row.model}`);
        assert.equal(result.price, row.incGstCents / 100, row.model);
        assert.equal(result.stored.unitPriceInc, 0, "Supplier price must not become a saved override");
        if (row.model === fd) fdKey = result.key;
      }
      for (const row of data.multi.filter((p) => !p.registryOnly)) {
        const result = await readMulti(fixture.page, row);
        assert(result, `Missing static multi-head row: ${row.model}`);
        assert.equal(result.price, row.incGstCents / 100, row.model);
        assert.equal(result.stored, undefined, "Supplier price must not become a saved component override");
      }
      const loaded = await fixture.page.evaluate((rows) => rows.map(({ brand, model }) => {
        const [index] = mergeVerifiedMultiSplitOutdoors(brand, [{ model, capacityKw: 7.1, phase: "Single" }]);
        return MULTI_SPLIT_OUTDOORS[index].unitPriceInc;
      }), data.multi.filter((p) => p.registryOnly));
      assert.deepEqual(loaded, data.multi.filter((p) => p.registryOnly).map((p) => p.incGstCents / 100));
      await assertClean(fixture);
    }
    assert(fdKey?.startsWith("ducted|"));
    const dKey = `multi-outdoor|DAIKIN|${compact(daikin)}`;
    const hKey = `multi-indoor|DAIKIN|${compact(head)}`;
    const dynamicKey = `multi-outdoor|HAIER|${compact(dynamic)}`;
    const savedDucted = { model: fd, unitPriceInc: 4321.09, locked: false, rebate: 123.45, rebateManual: true };
    const savedOutdoor = { unitPriceInc: 1800.01, model: daikin, brand: "Daikin", component: "outdoor", locked: true };
    const savedDynamic = { unitPriceInc: 1250, model: dynamic, brand: "Haier", component: "outdoor", locked: true };
    const savedHead = { unitPriceInc: 198, model: head, brand: "Daikin", component: "indoor", locked: true };
    const storageKey = "installerManagedPricesV1";
    const oldMap = { [fdKey]: { ...savedDucted, unitPriceInc: 0 }, "split|999": { unitPriceInc: 0, model: "UNRELATED" } };
    const newMap = { [fdKey]: savedDucted, [dKey]: savedOutdoor, "split|999": { unitPriceInc: 900, model: "UNRELATED" } };
    const guard = (existing, incoming, edits) => preserveAadTargetPrices({ [storageKey]: existing }, { [storageKey]: incoming }, prices, edits);
    const guards = preserveAadTargetPrices({ [storageKey]: JSON.stringify(newMap) }, { [storageKey]: JSON.stringify(oldMap), other: "unchanged" }, prices, null);
    assert.deepEqual(JSON.parse(guards.data[storageKey]), { ...oldMap, [fdKey]: savedDucted, [dKey]: savedOutdoor });
    assert.equal(guards.data.other, "unchanged");
    const explicit = { ...savedDucted, unitPriceInc: 4850 };
    const newPrice = { ...newMap, [fdKey]: explicit };
    const intent = { [fdKey]: { before: savedDucted.unitPriceInc, after: explicit.unitPriceInc } };
    assert.deepEqual(guard(newMap, newPrice).data[storageKey][fdKey], savedDucted, "Unmarked positive replay must preserve newer price");
    assert.deepEqual(guard(newMap, newPrice, intent).data[storageKey][fdKey], explicit);
    assert.equal(guard({ ...newMap, [fdKey]: { unitPriceInc: 800 } }, newPrice, intent).conflict, true);
    assert.equal(guard(newPrice, newPrice, intent).conflict, false, "A lost acknowledgement is safe to retry");
    assert.equal(guard({ [fdKey]: { unitPriceInc: 800 } }, { [fdKey]: oldMap[fdKey] }).data[storageKey][fdKey].unitPriceInc, 800);
    const rolledBack = guard(newMap, { [fdKey]: savedDucted }, { [dKey]: { before: savedOutdoor.unitPriceInc, after: 0 } });
    assert.equal(rolledBack.conflict, false);
    assert.equal(rolledBack.data[storageKey][dKey].unitPriceInc, 0);
    const onlyOutdoor = { [storageKey]: JSON.stringify({ [dKey]: savedOutdoor }) };
    const emptyRollback = preserveAadTargetPrices(onlyOutdoor, { [storageKey]: "{}" }, prices, { [dKey]: { before: savedOutdoor.unitPriceInc, after: 0 } });
    assert.equal(JSON.parse(mergeCalculatorData(onlyOutdoor, emptyRollback.data)[storageKey])[dKey].unitPriceInc, 0);
    const legacyMapKey = `ducted|Daikin|${fd}`;
    const legacyAlias = "greenEnergyManagedPricesV1";
    const legacyMap = { [legacyAlias]: JSON.stringify({ [legacyMapKey]: { unitPriceInc: 4800 } }) };
    const legacyReplay = { [legacyAlias]: JSON.stringify({ [legacyMapKey]: { unitPriceInc: 0 } }) };
    const checkedLegacy = preserveAadTargetPrices(legacyMap, legacyReplay, prices, null);
    assert.equal(JSON.parse(mergeCalculatorData(legacyMap, checkedLegacy.data)[legacyAlias])[legacyMapKey].unitPriceInc, 4800);
    const fixture = await pageFor(browser, { catalogue: "default", width: 390, current: {
      [fdKey]: savedDucted, [dKey]: savedOutdoor, [hKey]: savedHead, [dynamicKey]: savedDynamic,
    } });
    assert.deepEqual((await readSystem(fixture.page, selected)).stored, savedDucted);
    assert.equal((await readSystem(fixture.page, selected)).price, savedDucted.unitPriceInc);
    assert.deepEqual((await readMulti(fixture.page, { kind: "outdoor", brand: "Daikin", model: daikin })).stored, savedOutdoor);
    assert.equal((await readMulti(fixture.page, { kind: "indoor", brand: "Daikin", model: head })).price, savedHead.unitPriceInc);
    const live = await fixture.page.evaluate(({ daikin, dynamic }) => {
      const merge = (brand, model) => {
        const [i] = mergeVerifiedMultiSplitOutdoors(brand, [{ model, capacityKw: 7.1 }]);
        return MULTI_SPLIT_OUTDOORS[i].unitPriceInc;
      };
      return [merge("Daikin", daikin), merge("Haier", dynamic), merge("Haier", dynamic+"-wrong"), merge("Samsung", "AJ050TXJ2KH/AJ035TNAPKH/AJ050TNAPKH")];
    }, { daikin, dynamic });
    assert.deepEqual(live, [1800.01, 1250, 0, 0]);
    await assertClean(fixture);

    const blank = await pageFor(browser, { catalogue: "default", current: { [fdKey]: { ...savedDucted, unitPriceInc: "0.00" } } });
    assert.equal((await readSystem(blank.page, selected)).price, fdPrice);
    const preserved = (await readSystem(blank.page, selected)).stored;
    assert.deepEqual(preserved, { ...savedDucted, unitPriceInc: 0 });
    const display = await blank.page.evaluate(({ fdKey, fd }) => {
      const item = managedProductByKey(fdKey);
      const i = item.index;
      refreshLiveRebateForCurrentProduct = async () => {};
      refreshBestValueIndicator = () => {};
      setSystem("ducted");
      $("brand").value = "Daikin";
      populateProducts();
      $("product").value = String(i);
      onProductChange({ skipAsyncRefresh: true });
      renderPriceManager();
      const cost = $("unitPriceInc").value;
      const managed = $("priceRows").querySelector(`tr[data-key="${encodeKeyForDom(fdKey)}"] input[data-field="unitPriceInc"]`)?.value;
      const canQuote = standardQuotePriceReadiness().ok;
      const originalModel = item.p.model;
      updateManagedPrice(fdKey, "model", "EXAMPLE-OUT / EXAMPLE-IN");
      return { cost, managed, canQuote, originalModel, replacedPrice: item.p.unitPriceInc, correctModel: originalModel === fd };
    }, { fdKey, fd });
    assert.deepEqual(display, { cost: fdPrice.toFixed(2), managed: fdPrice.toFixed(2), canQuote: true, originalModel: fd, replacedPrice: 0, correctModel: true });
    await assertClean(blank);

    for (const alias of ["legacy", "bare"]) {
      const old = await pageFor(browser, {
        catalogue: "default",
        current: { [fdKey]: { ...savedDucted, unitPriceInc: 0 } },
        [alias]: { [fdKey]: savedDucted, [dKey]: savedOutdoor },
      });
      assert.equal((await readSystem(old.page, selected)).price, 4321.09, "A legacy positive price must beat AAD");
      assert.equal((await readMulti(old.page, { kind: "outdoor", brand: "Daikin", model: daikin })).price, 1800.01);
      await assertClean(old);
    }

    const quote = await pageFor(browser, { catalogue: "default" });
    const quoteResult = await quote.page.evaluate(async ({ daikin, head }) => {
      const i = MULTI_SPLIT_OUTDOORS.findIndex((p) => p.model === daikin);
      const hi = ALL_MODELS_MULTI_INDOORS.findIndex((p) => p.model === head);
      const currentOutdoor = MULTI_SPLIT_OUTDOORS[i].unitPriceInc;
      const currentHead = ALL_MODELS_MULTI_INDOORS[hi].unitPriceInc;
      populateMultiSplitBrands = async () => {
        $("multiSplitBrand").innerHTML = '<option value="Daikin">Daikin</option>';
        $("multiSplitOutdoor").innerHTML = '<option value="'+i+'">Outdoor</option>';
      };
      const state = {
        brand: "Daikin", model: daikin, outdoorModel: daikin, outdoorIndex: 0, outdoorUnitPriceInc: 1800,
        indoorSelections: [{ indoorIndex: 0, qty: 2 }],
        indoorHeads: [{ brand: "Daikin", model: head, qty: 2, unitPriceInc: 200 }],
        finalInc: 4200, installType: "new",
      };
      await loadMultiSplitQuote({}, state);
      const totals = multiSplitEquipmentTotals();
      const saved = currentMultiSplitState(totals);
      const quoteCost = $("multiUnitPriceInc").value;
      const destination = createNewOptionNow("Destination B", true);
      return [quoteCost, totals.total, saved.outdoorIndex === i, saved.indoorHeads[0].model,
        saved.indoorHeads[0].unitPriceInc, MULTI_SPLIT_OUTDOORS[i].unitPriceInc === currentOutdoor,
        ALL_MODELS_MULTI_INDOORS[hi].unitPriceInc === currentHead, multiSplitPriceDestination()===destination.id,
        multiSplitEquipmentTotals().total === currentOutdoor + 2 * currentHead];
    }, { daikin, head });
    assert.deepEqual(quoteResult, ["2200.00", 2200, true, head, 200, true, true, true, true]);
    await assertClean(quote);

    const other = await pageFor(browser, { catalogue: "default", businessState: "QLD", enabled: false });
    assert.equal((await readMulti(other.page, { kind: "outdoor", brand: "Daikin", model: daikin })).price, 0);
    await assertClean(other);
    console.log(`${data.systems.length} systems, ${data.multi.length} multi-head components, GST, exact identity, NSW scope, saved prices, and price manager checked.`);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
