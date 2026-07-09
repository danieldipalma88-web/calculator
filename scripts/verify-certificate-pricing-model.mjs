import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexHtml = readFileSync(path.join(root, "index.html"), "utf8");
const adminPage = readFileSync(path.join(root, "app/admin/users/page.tsx"), "utf8");

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
]) {
  assert.match(indexHtml, pattern, name);
}

for (const [name, pattern] of [
  ["admin ESC spot default", /escSpotPrice: 29,/],
  ["admin PERC spot default", /prcSpotPrice: 3,/],
  ["admin ESC agreement default", /escAgreementDeduction: 5,/],
  ["admin PERC agreement default", /prcAgreementDeduction: 0\.3,/],
  ["admin preserves business agreements", /agreementOverrides\?: Map<string, Pick<CertificateValues, "escAgreementDeduction" \| "prcAgreementDeduction">>/],
  ["admin global form saves spot price", /name="escSpotPrice"/],
  ["admin business form saves ESC agreement", /name="escAgreementDeduction"/],
  ["admin business form saves PERC agreement", /name="prcAgreementDeduction"/],
]) {
  assert.match(adminPage, pattern, name);
}

console.log("certificate pricing model ok");
