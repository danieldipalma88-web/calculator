import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const html = read("index.html");
const dataSource = read("lib/dcceew-contract-data.ts");
const route = read("app/calculator/raw/route.ts");

for (const name of [
  "normalizeDcceewBrand",
  "dcceewProductKey",
  "getDcceewContractMatch",
  "setDcceewContractDisplay",
]) {
  assert.match(html, new RegExp(`function\\s+${name}\\b`), `missing ${name}`);
}

assert.match(dataSource, /DCCEEW_CONTRACT_RATE\s*=\s*30\b/, "contract rate must be exactly $30");
const postcodes = dataSource.match(/DCCEEW_ELIGIBLE_POSTCODES\s*=\s*\[([\s\S]*?)\]\s+as const/)?.[1]
  ?.match(/\b\d{4}\b/g)?.map(Number) ?? [];
const productKeys = [...dataSource.matchAll(/"([A-Z0-9]+\|[^"\r\n]+)"/g)].map(([, key]) => key);
assert.equal(new Set(postcodes).size, 647, "workbook postcode set changed unexpectedly");
assert.equal(new Set(productKeys).size, 81, "active eligible product set changed unexpectedly");
assert.ok(postcodes.includes(2163), "approved postcode 2163 is missing");
assert.ok(productKeys.includes("FUJITSU|AOTG09KMTCASTG09KMTC"), "approved Fujitsu fixture is missing");

assert.match(route, /DCCEEW_ELIGIBLE_POSTCODES/, "raw calculator route does not inject postcode data");
assert.match(route, /DCCEEW_ELIGIBLE_PRODUCT_KEYS/, "raw calculator route does not inject product data");
assert.match(route, /window\.DCCEEW_CONTRACT_DATA/, "contract data is not exposed to the calculator frame");

const matcherStart = html.indexOf("let dcceewPostcodeSet=null;");
const matcherEnd = html.indexOf("function dcceewSignedMoney", matcherStart);
assert.ok(matcherStart >= 0 && matcherEnd > matcherStart, "could not isolate contract matcher");
const sandbox = {
  window: { DCCEEW_CONTRACT_DATA: { rate: 30, postcodes, productKeys } },
  state: "NSW",
  postcode: "2163",
  candidate: { brand: "Fujitsu General", model: "AOTG09KMTC/ASTG09KMTC" },
};
sandbox.rebatesEnabled = () => true;
sandbox.activeBusinessState = () => sandbox.state;
sandbox.getEssPostcode = () => sandbox.postcode;
sandbox.product = () => sandbox.candidate;
vm.runInNewContext(`${html.slice(matcherStart, matcherEnd)}\nglobalThis.__match=getDcceewContractMatch;`, sandbox);

assert.equal(sandbox.__match()?.rate, 30, "eligible NSW postcode/product did not receive contract match");
sandbox.state = "QLD";
assert.equal(sandbox.__match(), null, "contract match must be NSW-only");
sandbox.state = "NSW";
sandbox.postcode = "2002";
assert.equal(sandbox.__match(), null, "unlisted postcode received a contract match");
sandbox.postcode = "2163";
sandbox.candidate = { brand: "Other Brand", model: "AOTG09KMTC/ASTG09KMTC" };
assert.equal(sandbox.__match(), null, "model matched without the exact approved brand");

assert.match(html, /Potentially eligible for the fixed \$30 per ESC rate/, "missing contract eligibility heading");
assert.match(html, /Important information/, "missing prominent information action");
assert.match(html, /DCCEEW consent in Alitsy/, "missing consent requirement");
assert.match(html, /year of manufacture/, "missing baseline manufacture-year requirement");
assert.match(html, /compliance plate/, "missing compliance-plate requirement");
assert.match(html, /incentive or discount passed through/, "missing invoice pass-through requirement");
assert.match(html, /const contractEscValue=esc\*match\.rate;/, "contract ESC value is not certificate count times $30 rate");
assert.match(html, /const contractTotal=contractEscValue\+prcValue;/, "PERC value is not preserved in contract total");
assert.match(html, /const standardTotal=standardEscValue\+prcValue;/, "standard comparison does not preserve PERC");
assert.match(html, /\$\('rebate'\)\.value=\(Math\.round\(result\.rebate\*100\)\/100\)\.toFixed\(2\);/, "quote rebate no longer uses the standard result");
assert.doesNotMatch(html, /\$\('rebate'\)\.value[^;]*(?:contractTotal|contractEscValue)/, "contract amount overwrote the standard quote rebate");

console.log(`DCCEEW contract verifier passed (${postcodes.length} postcodes, ${productKeys.length} active products)`);
