import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexHtml = readFileSync(path.join(root, "index.html"), "utf8");
const adminPage = readFileSync(path.join(root, "app/admin/users/page.tsx"), "utf8");
const calculatorApi = readFileSync(path.join(root, "app/api/calculator-data/route.ts"), "utf8");
const rawCalculatorRoute = readFileSync(path.join(root, "app/calculator/raw/route.ts"), "utf8");
const certificateValuesHelper = readFileSync(path.join(root, "lib/certificate-values.ts"), "utf8");
const certificateMigration = readFileSync(
  path.join(root, "supabase/platform_certificate_values_upgrade.sql"),
  "utf8",
);

function payout(spot, agreement) {
  return Math.max(spot - agreement, 0);
}

assert.equal(payout(29, 5), 24, "Default ESC payout must be spot $29 less agreement $5.");
assert.equal(payout(3, 0.3), 2.7, "Default PERC payout must be spot $3 less agreement $0.30.");

for (const [name, pattern] of [
  ["calculator ESC spot default", /const DEFAULT_ESC_SPOT_PRICE=29\.00;/],
  ["calculator PERC spot default", /const DEFAULT_PRC_SPOT_PRICE=3\.00;/],
  ["calculator ESC agreement default", /const DEFAULT_ESC_AGREEMENT_DEDUCTION=5\.00;/],
  ["calculator PERC agreement default", /const DEFAULT_PRC_AGREEMENT_DEDUCTION=0\.30;/],
  ["calculator derived ESC payout default", /const DEFAULT_ESC_RATE=24\.00;/],
  ["calculator derived PERC payout default", /const DEFAULT_PRC_RATE=2\.70;/],
  ["calculator normalizes spot values", /function normalizeCertValues\(saved\)/],
  ["calculator derives payout from spot less agreement", /escRate:certPayoutRate\(escSpotPrice,escAgreementDeduction\)/],
  ["calculator accepts authoritative refreshes", /window\.applyAuthoritativeCertificateValues=function\(raw\)/],
]) {
  assert.match(indexHtml, pattern, name);
}

for (const [name, pattern] of [
  ["admin preserves business agreements", /agreementOverrides\?: Map<string, Pick<CertificateValues, "escAgreementDeduction" \| "prcAgreementDeduction">>/],
  ["admin global form saves spot price", /name="escSpotPrice"/],
  ["admin business form saves ESC agreement", /name="escAgreementDeduction"/],
  ["admin business form saves PERC agreement", /name="prcAgreementDeduction"/],
  ["admin writes authoritative record", /\.from\("platform_certificate_values"\)[\s\S]*?\.upsert\(platformCertificateValuesPayload/],
  ["admin verifies authoritative write", /certificatePlatformFieldsMatch\(verifiedValues, values\)/],
  ["admin verifies business compatibility copies", /Certificate values could not be verified for:/],
]) {
  assert.match(adminPage, pattern, name);
}

for (const [name, pattern] of [
  ["shared ESC spot default", /escSpotPrice: 29,/],
  ["shared PERC spot default", /prcSpotPrice: 3,/],
  ["shared ESC agreement default", /escAgreementDeduction: 5,/],
  ["shared PERC agreement default", /prcAgreementDeduction: 0\.3,/],
  ["shared calculator overlay", /export function overlayPlatformCertificateValues/],
]) {
  assert.match(certificateValuesHelper, pattern, name);
}

assert.match(
  calculatorApi,
  /\.from\("platform_certificate_values"\)[\s\S]*?overlayPlatformCertificateValues/,
  "calculator data API must overlay the authoritative spot price",
);
assert.match(
  rawCalculatorRoute,
  /\.from\("platform_certificate_values"\)[\s\S]*?overlayPlatformCertificateValues/,
  "calculator HTML load must overlay the authoritative spot price",
);
assert.match(
  rawCalculatorRoute,
  /setInterval\(refreshAuthoritativeCertificateValues, certificateRefreshIntervalMs\)/,
  "open calculators must refresh authoritative certificate values",
);
assert.match(
  rawCalculatorRoute,
  /window\.addEventListener\('focus', refreshAuthoritativeCertificateValues\)/,
  "calculator focus must refresh authoritative certificate values",
);
assert.match(
  certificateMigration,
  /create table if not exists public\.platform_certificate_values/,
  "migration must create the authoritative certificate table",
);
assert.match(
  certificateMigration,
  /authenticated users can read platform certificate values/,
  "authenticated calculators must be allowed to read the authoritative values",
);
assert.match(
  certificateMigration,
  /admins can manage platform certificate values/,
  "only admins may manage authoritative values",
);

console.log("certificate pricing model ok");
