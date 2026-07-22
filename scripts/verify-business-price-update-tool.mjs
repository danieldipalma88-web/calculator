import assert from "node:assert/strict";
import {
  canonicalModel,
  currencyFromExGst,
  generateSql,
  preparePriceUpdate,
} from "./generate-business-price-update-sql.mjs";

const suppliedPrices = [
  ["WRE-026DS/WRC-026DS", 690.91, 760.0],
  ["WRE-035DS/WRC-035DS", 827.56, 910.32],
  ["WRE-050DS/WRC-050DS", 1164.54, 1280.99],
  ["WRE-060DS/WRC-060DS", 1213.79, 1335.17],
  ["WRE-072DS/WRC-072DS", 1341.3, 1475.43],
  ["WRE-080DS/WRC-080DS", 1550, 1705.0],
  ["WRE-090DS/WRC-090DS", 2050, 2255.0],
];

for (const [, exGst, incGst] of suppliedPrices) {
  assert.equal(currencyFromExGst(exGst), incGst);
}

assert.equal(canonicalModel("WRE-026DS/WRC-026DS"), canonicalModel("WRC-026DS / WRE-026DS"));

const request = {
  businessName: "S&H Air Con",
  priceBasis: "ex_gst",
  prices: suppliedPrices.map(([model, price]) => ({ model, price })),
};
const prepared = preparePriceUpdate(request);
assert.deepEqual(prepared.prices.map((item) => item.price_inc_gst), suppliedPrices.map(([, , incGst]) => incGst));

const sql = generateSql(request);
assert.match(sql, /where lower\(btrim\(name\)\) = lower\(btrim\('S&H Air Con'\)\)/);
assert.match(sql, /if v_business_count <> 1 then/);
assert.match(sql, /if v_matches <> 1 then/);
assert.match(sql, /for update;/);
assert.match(sql, /array\[v_match_key, 'unitPriceInc'\]/);
assert.match(sql, /array\[v_match_key, 'locked'\]/);
assert.doesNotMatch(sql, /update public\.businesses/);
assert.doesNotMatch(sql, /priceIncGst'\]/);

assert.throws(
  () => preparePriceUpdate({
    businessName: "S&H Air Con",
    priceBasis: "inc_gst",
    prices: [
      { model: "WRE-026DS/WRC-026DS", price: 760 },
      { model: "WRC-026DS / WRE-026DS", price: 760 },
    ],
  }),
  /Duplicate model/,
);

assert.throws(
  () => preparePriceUpdate({
    businessName: "S&H Air Con",
    priceBasis: "ex_gst",
    prices: [{ model: "WRE-026DS/WRC-026DS", price: -1 }],
  }),
  /Invalid price/,
);

assert.throws(
  () => preparePriceUpdate({
    businessName: "S&H Air Con\nAnother Business",
    priceBasis: "inc_gst",
    prices: [{ model: "WRE-026DS/WRC-026DS", price: 760 }],
  }),
  /businessName must be a single line/,
);

console.log("Business price update tool verified.");
