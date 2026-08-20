import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const match = source.match(
  /const MITSUBISHI_ELECTRIC_NSW_DUCTED_PRODUCTS = (\[[\s\S]*?\]);\s*DUCTED_PRODUCTS\.push\(\.\.\.MITSUBISHI_ELECTRIC_NSW_DUCTED_PRODUCTS\);/,
);

assert.ok(match, "The NSW Mitsubishi Electric ducted catalogue was not found.");
const products = JSON.parse(match[1]);
const expectedModels = [
  "SUZ-M25VAD2-A / SEZ-M25DA3",
  "SUZ-M35VAD2-A / SEZ-M35DA3",
  "SUZ-M50VAD2-A / SEZ-M50DA3",
  "SUZ-M60VAD2-A / SEZ-M60DA3",
  "SUZ-M71VAD2-A / SEZ-M71DA3",
  "SUZ-M50VAD2-A / PEAD-M50JAAD",
  "SUZ-M60VAD2-A / PEAD-M60JAAD",
  "SUZ-M71VAD2-A / PEAD-M71JAAD",
  "PUZ-ZM71VHA2-A / PEAD-M71JAAD",
  "PUZ-ZM125VKA2-A / PEAD-M125JAAD",
  "PUZ-M140VKA2-A / PEA-M140GAA",
  "PUZ-ZM100VKA2-A / PEA-M100GAA",
  "PUZ-ZM100YKA3-A / PEA-M100GAA",
  "PUZ-ZM125VKA2-A / PEA-M125GAA",
  "PUZ-ZM140VKA2-A / PEA-M140GAA",
  "PUZ-ZM140YKA2-A / PEA-M140GAA",
  "PUZ-M100VKA2-A / PEA-M100HAA",
  "PUZ-ZM100VKA2-A / PEA-M100HAA",
  "PUZ-ZM100YKA3-A / PEA-M100HAA",
  "PUZ-ZM125VKA2-A / PEA-M125HAA",
  "PUZ-ZM125YKA2-A / PEA-M125HAA",
  "PUZ-ZM140VKA2-A / PEA-M140HAA",
  "PUZ-ZM140YKA2-A / PEA-M140HAA",
  "PUZ-ZM160VKA-A / PEA-M160HAA",
  "PUZ-ZM160YKA-A / PEA-M160HAA",
  "PUZ-ZM180VKA-A / PEA-M180LAA",
  "PUZ-ZM180YKA-A / PEA-M180LAA",
  "PUZ-ZM200YKA-A / PEA-M200LAA",
];

assert.deepEqual(products.map((product) => product.model), expectedModels);
assert.equal(new Set(products.map((product) => product.model)).size, expectedModels.length);
assert.equal(products.filter((product) => product.phase === "Single").length, 20);
assert.equal(products.filter((product) => product.phase === "Three").length, 8);

for (const product of products) {
  assert.equal(product.brand, "Mitsubishi Electric");
  assert.equal(product.unitPriceInc, 0, `${product.model} must have no unit price.`);
  assert.equal(product.priceIncGst, 0, `${product.model} must have no GST-inclusive unit price.`);
  assert.equal(product.rebate, 0, `${product.model} must not use a default rebate.`);
  assert.equal(product.nswOnly, true, `${product.model} must remain NSW-only.`);
  assert.match(product.model, /^[A-Z0-9-]+ \/ [A-Z0-9-]+$/, `${product.model} must use outdoor / indoor rebate-search order.`);
}

assert.match(
  source,
  /\{brand:'Mitsubishi Electric',details:\{wifiStatus:'optional',wifiLabel:'Wi-Fi optional interface',warrantyYears:5,warrantyLabel:'5 yrs parts & labour'\}\}/,
  "Mitsubishi Electric ducted Wi-Fi and warranty metadata must be present.",
);
assert.match(source, /'Mitsubishi Electric':'Japanese'/, "Mitsubishi Electric origin metadata must be present.");
assert.match(
  source,
  /return activeBusinessState\(\)==='NSW'\?list:list\.filter\(product=>product\.nswOnly!==true\);/,
  "NSW-only products must remain hidden from non-NSW default catalogues.",
);

console.log("Mitsubishi Electric ducted catalogue verification passed: 28 rebate-eligible NSW combinations, prices unset, optional Wi-Fi, 5-year parts and labour warranty.");
