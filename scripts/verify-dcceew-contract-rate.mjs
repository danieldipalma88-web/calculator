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
const required4To6KwNonDuctedKeys = [
  "DAIKIN|RXM46WVMAFTXM46WVMA",
  "DAIKIN|RXM50WVMAFTXM50WVMA",
  "DAIKIN|RXV50WVMAFTXV50WVMA",
  "FUJITSU|AOTG18KMTCASTG18KMTC",
  "FUJITSU|AOTH18KMTDASTH18KMTD",
  "MITSUBISHIELECTRIC|MUZAP42VG2MSZAP42VGD2",
  "MITSUBISHIELECTRIC|MUZAP42VG2MSZAP42VGKD2",
  "MITSUBISHIELECTRIC|MUZAP42VGD2MSZAP42VGD2",
  "MITSUBISHIELECTRIC|MUZAP42VGD2MSZAP42VGKD2",
  "MITSUBISHIELECTRIC|MUZAP50VG2MSZAP50VGD",
  "MITSUBISHIELECTRIC|MUZAP50VG2MSZAP50VGD2",
  "MITSUBISHIELECTRIC|MUZAP50VG2MSZAP50VGKD2",
  "MITSUBISHIELECTRIC|MUZAP50VGD2MSZAP50VGD2",
  "MITSUBISHIELECTRIC|MUZAP50VGD2MSZAP50VGKD2",
  "MITSUBISHIELECTRIC|MUZAP50VGDMSZAP50VGD",
  "MITSUBISHIELECTRIC|MUZAP50VGMSZAP50VGD",
  "MITSUBISHIELECTRIC|MUZAP50VGMSZAP50VGD2",
  "MITSUBISHIELECTRIC|MUZLN35VG2MSZLN35VG2B",
  "MITSUBISHIELECTRIC|MUZLN35VG2MSZLN35VG2R",
  "MITSUBISHIELECTRIC|MUZLN35VG2MSZLN35VG2V",
  "MITSUBISHIHEAVYINDUSTRIES|SCM40ZSW",
  "MITSUBISHIHEAVYINDUSTRIES|SCM45ZSW",
  "MITSUBISHIHEAVYINDUSTRIES|SCM50ZSW",
  "MITSUBISHIHEAVYINDUSTRIES|SRC35ZSXAWSRK35ZSXAW",
  "MITSUBISHIHEAVYINDUSTRIES|SRC35ZSXAWSRK35ZSXAWF",
  "PANASONIC|CUHZ35YKRCSHZ35YKR",
  "PANASONIC|CUHZ50YKRCSHZ50YKR",
  "PANASONIC|CURZ35AKRCSRZ35AKRW",
  "PANASONIC|CURZ35XKRCSRZ35XKRW",
  "PANASONIC|CUZ35AKRCSZ35AKRW",
  "PANASONIC|CUZ35XKRCSZ35XKRW",
  "PANASONIC|CUZ50XKR1CSZ50XKRW1",
];
const retired4To6KwNonDuctedKeys = [
  "ACTRONAIR|HRC035DSHRE035DS",
  "ACTRONAIR|HRC050DSHRE050DS",
  "ACTRONAIR|MRC050DS2",
  "ACTRONAIR|WRC050CSWRE050CS",
  "DAIKIN|RXM35UVMZFTXM35UVMZ",
  "DAIKIN|RXM46AVMAFTXM46AVMA",
  "DAIKIN|RXM46W2VMAFTXM46W2VMA",
  "FUJITSU|AOTG12KVCAAGTG12KVCA",
  "FUJITSU|AOTG14KVCAAGTG14KVCA",
  "FUJITSU|AOTH14KMCDASTH14KMCD",
  "MITSUBISHIELECTRIC|MUZAP42VG2MSZAP42VGD",
  "MITSUBISHIELECTRIC|MUZAP42VGD2MSZAP42VGD",
  "MITSUBISHIELECTRIC|MUZLN35VG2MSZLN35VGDB",
  "MITSUBISHIELECTRIC|MUZLN35VG2MSZLN35VGDR",
  "MITSUBISHIELECTRIC|MUZLN35VG2MSZLN35VGDV",
  "MITSUBISHIELECTRIC|MUZLN35VGDMSZLN35VG2B",
  "MITSUBISHIELECTRIC|MUZLN35VGDMSZLN35VG2R",
  "MITSUBISHIELECTRIC|MUZLN35VGDMSZLN35VG2V",
  "MITSUBISHIELECTRIC|MUZLN35VGDMSZLN35VGDB",
  "MITSUBISHIELECTRIC|MUZLN35VGDMSZLN35VGDR",
  "MITSUBISHIELECTRIC|MUZLN35VGDMSZLN35VGDV",
  "MITSUBISHIELECTRIC|MUZLN35VGHZ2MSZLN35VG2B",
  "MITSUBISHIELECTRIC|MUZLN35VGHZ2MSZLN35VG2R",
  "MITSUBISHIELECTRIC|MUZLN35VGHZ2MSZLN35VG2V",
  "MITSUBISHIELECTRIC|MUZLN35VGHZ2MSZLN35VGDB",
  "MITSUBISHIELECTRIC|MUZLN35VGHZ2MSZLN35VGDR",
  "MITSUBISHIELECTRIC|MUZLN35VGHZ2MSZLN35VGDV",
  "MITSUBISHIHEAVYINDUSTRIES|SRC35ZTAWBSRK35ZTAWF",
  "MITSUBISHIHEAVYINDUSTRIES|SRC35ZTAWBSRK35ZTAWFB",
  "MITSUBISHIHEAVYINDUSTRIES|SRC35ZTAWSRK35ZTAWF",
  "MITSUBISHIHEAVYINDUSTRIES|SRC35ZTAWSRK35ZTAWFB",
  "MITSUBISHIHEAVYINDUSTRIES|SRC35ZTAWSRK35ZTAWFT",
  "MITSUBISHIHEAVYINDUSTRIES|SRC42ZTAWBSRK42ZTAWF",
  "MITSUBISHIHEAVYINDUSTRIES|SRC42ZTAWBSRK42ZTAWFB",
  "MITSUBISHIHEAVYINDUSTRIES|SRC42ZTAWBSRK42ZTAWFT",
  "MITSUBISHIHEAVYINDUSTRIES|SRC42ZTAWFSRK42ZTAWFB",
  "MITSUBISHIHEAVYINDUSTRIES|SRC42ZTAWFSRK42ZTAWFT",
  "MITSUBISHIHEAVYINDUSTRIES|SRC42ZTAWSRK42ZTAWF",
  "MITSUBISHIHEAVYINDUSTRIES|SRK35ZTAWFBSRK35ZTAWFT",
  "RINNAI|FSNRP50B",
  "RINNAI|HONRJ35BHINRJ35B",
  "RINNAI|HONRJ50BHINRJ50B",
  "RINNAI|HONRJX50HINRJX50",
  "RINNAI|HONRT35BHINRT35B",
  "RINNAI|HONRT50BHINRT50B",
  "RINNAI|HONRTX35HINRTX35",
  "RINNAI|HONRTX50HINRTX50",
  "RINNAI|HONRVX35HINRVX35",
  "RINNAI|HSNRP50B",
  "RINNAI|HSNRTX35",
  "RINNAI|HSNRTX50",
];
assert.equal(new Set(postcodes).size, 647, "workbook postcode set changed unexpectedly");
assert.equal(new Set(productKeys).size, 796, "central DCCEEW product register changed unexpectedly");
assert.equal(
  crypto.createHash("sha256").update([...productKeys].sort().join("\n")).digest("hex"),
  "03fc45767a2bf8d71c4644b3b387881e69b245ae737b9f6391825c9413070fae",
  "central DCCEEW product register differs from the reviewed authoritative set",
);
for (const key of required4To6KwNonDuctedKeys) {
  assert.ok(productKeys.includes(key), `approved 4-6kW non-ducted product is missing: ${key}`);
}
for (const key of retired4To6KwNonDuctedKeys) {
  assert.ok(!productKeys.includes(key), `retired 4-6kW non-ducted product remains active: ${key}`);
}
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
sandbox.candidate = { brand: "Rinnai", model: "MVRFON6H20" };
assert.equal(sandbox.__match()?.rate, 30, "approved model not in the current catalogue did not receive a contract match");

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
