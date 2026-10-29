import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildPublicRebateCatalogue } from "../lib/public-rebate-catalogue.ts";

const source = await readFile(new URL("../index.html", import.meta.url), "utf8");
const splitStart = source.indexOf("const SPLIT_PRODUCTS =");
const activeStart = source.indexOf("function activeProducts(list)");
const activeEnd = source.indexOf("let systemType='split'");
assert.ok(splitStart >= 0 && activeStart >= 0 && activeEnd > splitStart);
const activeProductsSource = source.match(/function activeProducts\(list\)\{[^\n]+\}/)?.[0];
assert.ok(activeProductsSource, "Could not isolate activeProducts().");

const sandbox = Object.create(null);
vm.runInNewContext(
  `${source.slice(splitStart, activeEnd)}\n${activeProductsSource}\nglobalThis.split = activeProducts(SPLIT_PRODUCTS); globalThis.ducted = activeProducts(DUCTED_PRODUCTS);`,
  sandbox,
  { timeout: 8000 },
);

const expectedSplit = [
  ["Daikin", "Alira X - A Series", "RXM25AVMA / FTXM25AVMA", 2.5, "Single", "new"],
  ["Daikin", "Alira X - A Series", "RXM46AVMA / FTXM46AVMA", 4.6, "Single", "new"],
  ["Daikin", "Cora - A Series", "RXV50AVMA / FTXV50AVMA", 5, "Single", "new"],
  ["Daikin", "Floor Standing", "RXM60YFVMA / FVXM60YVMA", 6, "Single", "existing"],
  ["Mitsubishi Heavy Industries", "Bronte", "DXC21ZRA-W / DXK21ZRA-WF1", 6.3, "Single", "new"],
  ["Mitsubishi Heavy Industries", "Bronte", "DXC33ZRA-W / DXK33ZRA-WF1", 9.5, "Single", "new"],
  ["Fujitsu General", "Comfort", "AOTH18KNTA/ASTH18KNTA", 5, undefined, "new"],
  ["Hisense", "X5", "HAWH18KR", 5.1, "Single", "new"],
  ["Carrier", "Azure", "38QAF020N8/42QAF020N8", 2.05, "Single", "new"],
];
const expectedDucted = [
  ["Samsung", "Duct S2+ Premium Splittable", "AC120TXAPKG\\AC120TNHPKG", 12.5, "Single"],
  ["Samsung", "Duct S2 Slim-Line", "AC120TXAPKG/SA / AC120TNHDKG/SA", 12, "Single"],
  ["Daikin", "Standard Inverter", "RZA71C2V1 / FDYAN71AV1", 7.1, "Single"],
  ["Daikin", "Standard Inverter", "RZA85C2V1 / FDYAN85AV1", 8.5, "Single"],
  ["Daikin", "Standard Inverter", "RZA100C2V1 / FDYAN100AV1", 10, "Single"],
  ["Daikin", "Standard Inverter", "RZA125C2V1 / FDYAN125AV1", 12.5, "Single"],
  ["Daikin", "Standard Inverter", "RZA140C2V1 / FDYAN140AV1", 14, "Single"],
  ["Daikin", "Standard Inverter", "RZA140C2Y1 / FDYAN140AV1", 14, "Three"],
  ["Daikin", "Standard Inverter", "RZA160C2Y1 / FDYAN160AV1", 15.5, "Three"],
  ["Daikin", "Standard Inverter R410A", "RZQ180M2Y1 / FDYQN180LCV1", 18, "Three"],
  ["Daikin", "Standard Inverter R410A", "RZQ200MY1 / FDYQN200LCV1", 19.5, "Three"],
  ["Daikin", "Standard Inverter R410A", "RZQ250LY1 / FDYQN250LBV1", 23.5, "Three"],
  ["Mitsubishi Heavy Industries", "", "FDCA140VNX-W/FDUA140VH", 14, "Single"],
  ["Mitsubishi Electric", "PEA-M Two Piece Power Inverter", "PUZ-ZM250YKA-A / PEA-M250LAA", 24.5, "Three"],
];
const normalize = (value) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const assertOneNormalizedModel = (rows, brand, model, section) => {
  const matches = rows.filter((row) => row.brand === brand && normalize(row.model) === normalize(model));
  assert.equal(matches.length, 1, `${brand} ${model} must occur exactly once in active ${section}.`);
  return matches[0];
};
const newRows = [];

for (const [brand, series, model, capacity, phase, status] of expectedSplit) {
  const product = assertOneNormalizedModel(sandbox.split, brand, model, "split");
  assert.equal(product.series, series, `${model} series`);
  assert.equal(product.capacityNum, capacity, `${model} capacity`);
  if (phase) assert.equal(product.phase, phase, `${model} phase`);
  if (status === "new") {
    assert.equal(product.nswOnly, true, `${model} must be NSW-only.`);
    const expectedPrice = model === "DXC33ZRA-W / DXK33ZRA-WF1" ? 2750 : 0;
    assert.equal(product.unitPriceInc, expectedPrice, `${model} must match approved pricing.`);
    assert.equal(product.priceIncGst, expectedPrice, `${model} must match approved GST-inclusive pricing.`);
    assert.equal(product.rebate, 0, `${model} must not have a static rebate.`);
    newRows.push(product);
  } else {
    assert.equal(product.unitPriceInc, 0, "Existing Daikin Floor Standing pricing must remain unchanged.");
    assert.equal(product.nswOnly, true);
  }
}

for (const [brand, series, model, capacity, phase] of expectedDucted) {
  const product = assertOneNormalizedModel(sandbox.ducted, brand, model, "ducted");
  assert.equal(product.series || "", series, `${model} series`);
  assert.equal(product.capacityNum, capacity, `${model} capacity`);
  assert.equal(product.phase, phase, `${model} phase`);
  if (brand === "Mitsubishi Heavy Industries") {
    assert.equal(product.unitPriceInc, 4250, "Existing MHI 14 kW pricing must remain unchanged.");
  } else {
    assert.equal(product.nswOnly, true, `${model} must be NSW-only.`);
    assert.equal(product.unitPriceInc, 0, `${model} must retain a clear price.`);
    assert.equal(product.priceIncGst, 0, `${model} must retain a clear GST price.`);
    assert.equal(product.rebate, 0, `${model} must not have a static rebate.`);
    newRows.push(product);
  }
}

assert.equal(newRows.length, 21, "Expected 21 new NSW rows across split and ducted arrays.");

const supportSource = source.slice(source.indexOf("const PRODUCT_SUPPORT_DEFAULT="), activeEnd);
const support = Object.create(null);
Object.assign(support, {
  SPLIT_PRODUCTS: sandbox.split,
  DUCTED_PRODUCTS: sandbox.ducted,
  ANDOS_SPLIT_PRODUCTS: [],
  ANDOS_DUCTED_PRODUCTS: [],
});
vm.runInNewContext(`${supportSource}\nglobalThis.splitSupport = SPLIT_PRODUCT_SUPPORT; globalThis.ductedSupport = DUCTED_PRODUCT_SUPPORT;`, support, { timeout: 8000 });
const supportRule = (rules, brand, series) => rules.find((rule) => rule.brand === brand && (!rule.series || rule.series === series))?.details;
const carrierSupport = supportRule(support.splitSupport, "Carrier", "Azure");
assert.equal(carrierSupport?.wifiStatus, "included");
assert.equal(carrierSupport?.wifiLabel, "Wi-Fi kit included");
assert.equal(carrierSupport?.warrantyYears, 7);
const hisenseSupport = supportRule(support.splitSupport, "Hisense", "X5");
assert.equal(hisenseSupport?.wifiStatus, "included");
assert.equal(hisenseSupport?.warrantyLabel, "7 yrs promo (conditions apply)");
const fujitsuSupport = supportRule(support.splitSupport, "Fujitsu General", "Comfort");
assert.equal(fujitsuSupport?.wifiStatus, "optional");
assert.equal(fujitsuSupport?.wifiLabel, "Wi-Fi optional adaptor");
assert.equal(fujitsuSupport?.warrantyYears, 5);
const samsungSupport = supportRule(support.ductedSupport, "Samsung", "Duct S2+ Premium Splittable");
assert.equal(samsungSupport?.wifiStatus, "optional");
assert.equal(samsungSupport?.wifiLabel, "Wi-Fi kit sold separately");
assert.equal(samsungSupport?.warrantyYears, 5);

assert.match(source, /andosSplit\("Fujitsu", "Comfort", 5\.0, "ASTH18KNTA", "AOTH18KNTA", 1185\)/, "The separate ANDOS Fujitsu row and price must remain untouched.");
assert.match(source, /andosDucted\("Samsung", "1 Phase", 12\.0, "Single", "AC120TNHPKG\/SA", "AC120TXAPKG\/SA", 2695\)/, "The separate ANDOS Samsung row and price must remain untouched.");

const multiStart = source.indexOf("function multiOutdoor(");
const multiEnd = source.indexOf("const MULTI_SPLIT_INDOORS=[", multiStart);
assert.ok(multiStart >= 0 && multiEnd > multiStart, "Could not isolate the multi-head outdoor catalogue.");
const multiSandbox = Object.create(null);
vm.runInNewContext(`${source.slice(multiStart, multiEnd)}\nglobalThis.outdoors = MULTI_SPLIT_OUTDOORS;`, multiSandbox, { timeout: 8000 });
const multi = multiSandbox.outdoors.filter((row) => row.brand === "Fujitsu General" && normalize(row.model) === normalize("AOTH24KBCA3"));
assert.equal(multi.length, 1, "AOTH24KBCA3 must remain in the multi-head outdoor catalogue exactly once.");
assert.equal(multi[0].capacityNum, 6.8);
assert.equal(multi[0].unitPriceInc, 1910, "The existing catalogue price must remain unchanged.");
assert.equal(multi[0].maxHeads, 3, "AOTH24KBCA3 must retain its corrected three-head maximum.");

const mergeStart = source.indexOf("function mergeVerifiedMultiSplitOutdoors(");
const mergeEnd = source.indexOf("function rebateLookupModelCandidates", mergeStart);
assert.ok(mergeStart >= 0 && mergeEnd > mergeStart, "Could not isolate the verified multi-head merge.");
const mergeSandbox = Object.create(null);
Object.assign(mergeSandbox, {
  MULTI_SPLIT_OUTDOORS: multiSandbox.outdoors,
  normalizeLookup: normalize,
  brandsEquivalent: (a, b) => a === b,
  applyManagedMultiSplitPrice: () => {},
});
vm.runInNewContext(`${source.slice(mergeStart, mergeEnd)}\nglobalThis.merge = mergeVerifiedMultiSplitOutdoors;`, mergeSandbox, { timeout: 8000 });
mergeSandbox.merge("Fujitsu General", [{ model: "AOTH24KBCA3", capacityKw: 6.8, family: "fujitsu-airstage" }]);
const mergedMulti = mergeSandbox.MULTI_SPLIT_OUTDOORS.find((row) => normalize(row.model) === normalize("AOTH24KBCA3"));
assert.equal(mergedMulti.maxHeads, 3, "Merging verified data must preserve the known three-head maximum.");
assert.equal(mergedMulti.unitPriceInc, 0, "Verified merge must clear the shared catalogue price.");

const publicCatalogue = await buildPublicRebateCatalogue();
assert.equal(publicCatalogue.products.length, 461, "The regenerated public catalogue must contain 461 products.");
for (const [brand, series, model, capacity, phase] of [...expectedSplit, ...expectedDucted]) {
  const matches = publicCatalogue.products.filter((product) =>
    product.systemType === (expectedSplit.some((row) => row[0] === brand && normalize(row[2]) === normalize(model)) ? "split" : "ducted") &&
    product.brand === brand && normalize(product.model) === normalize(model),
  );
  assert.equal(matches.length, 1, `${model} must appear exactly once in the public catalogue.`);
  assert.ok(matches.some((match) => match.capacityKw === capacity), `${model} public capacity`);
  if (phase === "Single" || phase === "Three") {
    assert.ok(matches.some((match) => match.phase === phase || (phase === "Single" && match.phase === undefined)), `${model} public phase`);
  }
  if (series) assert.ok(matches.some((match) => match.series === series), `${model} public series`);
}

console.log("Requested model active NSW, pricing, support, public catalogue and multi-head checks passed (21 new rows; 2 existing rows; multi-head separate).");
