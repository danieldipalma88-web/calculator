import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { currencyFromExGst } from "./generate-business-price-update-sql.mjs";
import { mergeCalculatorData } from "../lib/quote-sync.ts";

const source = await readFile(new URL("../index.html", import.meta.url), "utf8");
const catalogueStart = source.indexOf("const SPLIT_PRODUCTS =");
const catalogueEnd = source.indexOf("let systemType='split'", catalogueStart);
const migrationStart = source.indexOf("const MANAGED_PRICE_DEFAULT_MIGRATIONS=");
const migrationEnd = source.indexOf("const QUOTE_STORAGE_KEY=", migrationStart);
const functionStart = source.indexOf("function migrateManagedDefaultPrice(");
const functionEnd = source.indexOf("function parseManagedPriceStorage(", functionStart);
const normalize = source.match(/function normalizeLookup\(v\)\{[^\n]+\}/)?.[0];
assert.ok(catalogueStart >= 0 && catalogueEnd > catalogueStart);
assert.ok(migrationStart >= 0 && migrationEnd > migrationStart);
assert.ok(functionStart >= 0 && functionEnd > functionStart && normalize);
const sandbox = {};
vm.runInNewContext(
  `${source.slice(catalogueStart, catalogueEnd)}
   ${source.slice(migrationStart, migrationEnd)}
   ${normalize}
   ${source.slice(functionStart, functionEnd)}
   globalThis.products = SPLIT_PRODUCTS; globalThis.migrate = migrateManagedDefaultPrice;`,
  sandbox,
  { timeout: 8000 },
);

const approved = [
  ["Mitsubishi Heavy Industries", "Bronte", 8, "DXC28ZRA-W / DXK28ZRA-WF1", 0, 2200, 5],
  ["Mitsubishi Heavy Industries", "Bronte", 9.5, "DXC33ZRA-W / DXK33ZRA-WF1", 0, 2750, 5],
  ["Rinnai", "PX Series", 8, "HONRPX80/HINRPX80M", 1550, 1550, 7],
  ["Actron Air", "Serene DS", 8, "WRC-080DS / WRE-080DS", 1725.64, currencyFromExGst(1550), 5],
  ["Actron Air", "Serene DS", 9, "WRC-090DS / WRE-090DS", 2003.14, currencyFromExGst(2050), 5],
  ["Daikin", "Cora - A Series", 2.5, "RXV25AVMA / FTXV25AVMA", 0, 850, 5],
  ["Daikin", "Cora - A Series", 5, "RXV50AVMA / FTXV50AVMA", 0, 1420, 5],
];

for (const [brand, series, capacity, model, oldPrice, newPrice, warranty] of approved) {
  const matches = sandbox.products.filter((p) => p.model === model);
  assert.equal(matches.length, 1, `${model} must match exactly one system.`);
  const product = matches[0];
  assert.equal(product.brand, brand);
  assert.equal(product.series, series);
  assert.equal(product.capacityNum, capacity);
  assert.equal(product.unitPriceInc, newPrice);
  if ("priceIncGst" in product) assert.equal(product.priceIncGst, newPrice);
  assert.equal(product.wifiStatus, brand === "Daikin" ? "optional" : "included");
  assert.equal(product.warrantyYears, warranty);

  const item = { type: "split", p: product };
  const saved = { model, unitPriceInc: oldPrice, locked: true, rebate: 321.45, rebateManual: false };
  const migrated = sandbox.migrate(saved, item);
  assert.equal(migrated.unitPriceInc, newPrice, `${model}: stale default override must migrate.`);
  assert.equal(saved.unitPriceInc, oldPrice, "Migration must not mutate its input.");
  assert.deepEqual({ ...migrated, unitPriceInc: oldPrice }, saved, "Only the equipment price may change.");
  assert.equal(sandbox.migrate(migrated, item).unitPriceInc, newPrice, "Migration must be idempotent.");
  const custom = { ...saved, unitPriceInc: 1234.56 };
  assert.equal(sandbox.migrate(custom, item), custom, "Unrelated future custom prices must be retained.");
  assert.equal(sandbox.migrate(saved, { ...item, type: "ducted" }), saved, "Do not migrate another system type.");

  for (const storageKey of ["installerManagedPricesV1", "greenEnergyManagedPricesV1", "ManagedPricesV1"]) {
    for (const encode of [(value) => value, JSON.stringify]) {
      const stale = { [storageKey]: encode({ "split|old-index": saved }) };
      const current = { [storageKey]: encode({ "split|old-index": migrated }) };
      for (const existing of [current, {}]) {
        const result = mergeCalculatorData(existing, stale);
        const map = typeof result[storageKey] === "string" ? JSON.parse(result[storageKey]) : result[storageKey];
        assert.deepEqual(map["split|old-index"], { ...saved, unitPriceInc: newPrice }, "Stale autosave must not restore an old default.");
        assert.deepEqual(stale[storageKey], encode({ "split|old-index": saved }), "Server correction must not mutate incoming data.");
      }
      const customResult = mergeCalculatorData(current, { [storageKey]: encode({ custom }) });
      const customMap = typeof customResult[storageKey] === "string" ? JSON.parse(customResult[storageKey]) : customResult[storageKey];
      assert.deepEqual(customMap.custom, custom, "Explicit custom prices remain editable.");
    }
  }
  const quote = { id: "saved-system", model, unitPriceInc: oldPrice, syncUpdatedAt: 100 };
  const quoteKey = "installerMasterQuoteLogV1";
  assert.equal(JSON.parse(mergeCalculatorData({}, { [quoteKey]: JSON.stringify([quote]) })[quoteKey])[0].unitPriceInc, oldPrice, "Saved quote prices must not be migrated.");
}

for (const [model, price] of [
  ["DXC21ZRA-W / DXK21ZRA-WF1", 0],
  ["DXC24ZRA-W - DXK24ZRA-WF1", 1699.5],
  ["SRC95ZRA-W / SRK95ZRA-WF1", 2750],
]) {
  assert.equal(sandbox.products.find((p) => p.model === model)?.unitPriceInc, price, `${model} must be unchanged.`);
}
console.log("Seven shared split prices, GST, identity, support and safe default migrations verified.");
