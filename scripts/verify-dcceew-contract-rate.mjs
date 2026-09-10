import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const html = read("index.html");
const dataSource = read("lib/dcceew-contract-data.ts");
const productRegister = JSON.parse(read("lib/dcceew-contract-products.json"));
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
const productKeys = productRegister;
const requiredAuthoritativeKeys = [
  "DAIKIN|5MXM100R2VMA",
  "DAIKIN|RZAS71C2V1FDYA71AV1",
  "FUJITSU|AOTG09KMTCASTG09KMTC",
  "MITSUBISHIELECTRIC|MUZAP42VG2MSZAP42VGD2",
  "MITSUBISHIHEAVYINDUSTRIES|SCM40ZSW",
  "PANASONIC|CUHZ35YKRCSHZ35YKR",
];
const retiredAuthoritativeKeys = [
  "ACTRONAIR|HRC035DSHRE035DS",
  "DAIKIN|RXM46AVMAFTXM46AVMA",
  "FUJITSU|AOTG12KVCAAGTG12KVCA",
  "MITSUBISHIELECTRIC|MUZAP42VG2MSZAP42VGD",
  "MITSUBISHIHEAVYINDUSTRIES|SRC35ZTAWSRK35ZTAWF",
  "RINNAI|MVRFON6H20",
];
const sortedPostcodes = [...postcodes].sort((left, right) => left - right);
assert.equal(postcodes.length, 651, "workbook postcode count changed unexpectedly");
assert.equal(new Set(postcodes).size, 651, "workbook postcode set contains duplicates");
assert.deepEqual(postcodes, sortedPostcodes, "workbook postcode set must remain sorted");
assert.equal(
  crypto.createHash("sha256").update(sortedPostcodes.join(",")).digest("hex"),
  "2fc22d84f9c9b505ad516345cf9586e6694d67d9010708f31f0525d7c20f83f3",
  "workbook postcode set differs from the reviewed authoritative set",
);
assert.equal(productKeys.length, 245, "central DCCEEW product register changed unexpectedly");
assert.equal(new Set(productKeys).size, 245, "central DCCEEW product register contains duplicates");
assert.deepEqual(productKeys, [...productKeys].sort(), "central DCCEEW product register must remain sorted");
assert.equal(
  crypto.createHash("sha256").update([...productKeys].sort().join("\n")).digest("hex"),
  "aea5de4d11cfd43e5af3b11975b96c41df68ee7d84ada9cef5098e6c3c0a964c",
  "central DCCEEW product register differs from the reviewed authoritative set",
);
for (const key of requiredAuthoritativeKeys) {
  assert.ok(productKeys.includes(key), `authoritative product is missing: ${key}`);
}
for (const key of retiredAuthoritativeKeys) {
  assert.ok(!productKeys.includes(key), `retired product remains active: ${key}`);
}
for (const postcode of [2000, 2309, 2522, 2890, 4380]) {
  assert.ok(postcodes.includes(postcode), `approved postcode ${postcode} is missing`);
}
for (const postcode of [2058, 2252, 2891]) {
  assert.ok(!postcodes.includes(postcode), `removed Sheet2 postcode ${postcode} remains eligible`);
}

assert.match(route, /DCCEEW_ELIGIBLE_POSTCODES/, "raw calculator route does not inject postcode data");
assert.match(route, /DCCEEW_ELIGIBLE_PRODUCT_KEYS/, "raw calculator route does not inject product data");
assert.match(route, /window\.DCCEEW_CONTRACT_DATA/, "contract data is not exposed to the calculator frame");

const matcherStart = html.indexOf("let dcceewPostcodeSet=null;");
const matcherEnd = html.indexOf("function dcceewSignedMoney", matcherStart);
assert.ok(matcherStart >= 0 && matcherEnd > matcherStart, "could not isolate contract matcher");
const sandbox = {
  window: { DCCEEW_CONTRACT_DATA: { rate: 30, postcodes, productKeys } },
  state: "NSW",
  postcode: "2309",
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
for (const postcode of ["2000", "2309", "2522", "2890", "4380"]) {
  sandbox.postcode = postcode;
  assert.equal(sandbox.__match()?.rate, 30, `approved postcode ${postcode} did not receive a contract match`);
}
sandbox.postcode = "2002";
assert.equal(sandbox.__match(), null, "unlisted postcode received a contract match");
for (const postcode of ["2058", "2252", "2891"]) {
  sandbox.postcode = postcode;
  assert.equal(sandbox.__match(), null, `removed Sheet2 postcode ${postcode} received a contract match`);
}
sandbox.postcode = "2309";
sandbox.candidate = { brand: "Other Brand", model: "AOTG09KMTC/ASTG09KMTC" };
assert.equal(sandbox.__match(), null, "model matched without the exact approved brand");

const rebateStart = html.indexOf("function applyDcceewContractRebate");
const rebateEnd = html.indexOf("function setCertificateBreakdown", rebateStart);
const rebateSandbox = {};
vm.runInNewContext(`${html.slice(rebateStart, rebateEnd)}\nglobalThis.__effective=applyDcceewContractRebate;`, rebateSandbox);
const effective = rebateSandbox.__effective(
  { rate: 30 },
  { esc: 8.61, prc: 45.82, escRate: 24, prcRate: 2.7, escValue: 206.64, prcValue: 123.714 },
);
assert.equal(Number(effective.rebate.toFixed(2)), 382.01, "contract rebate was not added to the effective Costs-section rebate");
assert.equal(Number(effective.contractUplift.toFixed(2)), 51.66, "contract uplift was not calculated from the ESC difference");

assert.match(html, /Potentially eligible for the fixed \$30 per ESC rate/, "missing contract eligibility heading");
assert.match(html, /Important information/, "missing prominent information action");
assert.equal(
  (html.match(/href="https:\/\/rebateportal\.com\.au\/first-job-guide"/g) || []).length,
  2,
  "standard and multi-head contract panels must both link to the first job guide",
);
assert.equal(
  (html.match(/>Open first job checklist<\/a>/g) || []).length,
  2,
  "first job checklist actions must be clearly labelled",
);
assert.match(
  html,
  /class="dcceewGuideButton"[^>]+target="_blank"[^>]+rel="noopener noreferrer"/,
  "first job guide must open safely without replacing the current quote",
);
assert.match(html, /DCCEEW consent in Alitsy/, "missing consent requirement");
assert.match(html, /year of manufacture/, "missing baseline manufacture-year requirement");
assert.match(html, /compliance plate/, "missing compliance-plate requirement");
assert.match(html, /incentive or discount passed through/, "missing invoice pass-through requirement");
assert.match(html, /const contractEscValue=esc\*match\.rate;/, "contract ESC value is not certificate count times $30 rate");
assert.match(html, /const contractTotal=contractEscValue\+prcValue;/, "PERC value is not preserved in contract total");
assert.match(html, /const standardTotal=standardEscValue\+prcValue;/, "standard comparison does not preserve PERC");
assert.match(html, /function applyDcceewContractRebate\(match,result\)/, "missing shared effective contract rebate helper");
assert.match(html, /const effective=applyDcceewContractRebate\(dcceewMatch,result\);/, "live rebate result does not apply the contract rate");
assert.match(html, /\$\('rebate'\)\.value=\(Math\.round\(effective\.rebate\*100\)\/100\)\.toFixed\(2\);/, "contract rebate is not written to the Costs section");
assert.match(html, /id="rebateCostHint"/, "Costs section does not explain the contract uplift");
assert.match(html, /DCCEEW contract rate applied/, "rebate metadata does not disclose the applied contract rate");
assert.match(html, /\.dcceewComparisonCard:first-child\{\s*order:1;/, "standard rebate is not displayed first");
assert.match(html, /\.dcceewComparisonCard\.uplift\{\s*order:2;/, "additional contract value is not displayed second");
assert.match(html, /\.dcceewComparisonCard\.contract\{\s*order:3;/, "contract rebate is not displayed last");

console.log(`DCCEEW contract verifier passed (${postcodes.length} postcodes, ${productKeys.length} active products)`);
