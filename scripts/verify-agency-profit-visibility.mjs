import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { canSeeAgencyProfit } from "../lib/admin.ts";

const [calculator, rawRoute, adminPage] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../app/calculator/raw/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/admin/users/page.tsx", import.meta.url), "utf8"),
]);

assert.equal(canSeeAgencyProfit("admin"), true, "Platform admins must see agency profit.");
assert.equal(canSeeAgencyProfit("business_owner"), true, "Business owners must see agency profit.");
assert.equal(canSeeAgencyProfit("agency"), false, "Agency-role users must not see agency profit.");
assert.equal(canSeeAgencyProfit("salesperson"), false, "Salespeople must not see agency profit.");
assert.equal(canSeeAgencyProfit("user"), false, "Standard users must not see agency profit.");
assert.equal(canSeeAgencyProfit(undefined), false, "Missing roles must not see agency profit.");

const checks = [
  [rawRoute.includes("canSeeAgencyProfit: agencyProfitVisible"), "server-injected agency-profit permission"],
  [rawRoute.includes("previewAsViewedUser\n    ? canSeeAgencyProfit(contextRole)"), "restricted salesperson preview behavior"],
  [calculator.includes("u.canSeeAgencyProfit===true"), "strict client visibility check"],
  [calculator.includes("Math.max(0,agency-salesperson)"), "GST-inclusive subtraction formula"],
  [calculator.includes("Agency profit after salesperson commission inc GST"), "calculator commission row"],
  [calculator.includes("agencyProfitAfterSalesRow').classList.toggle('hidden',!showAgencyProfit)"), "calculator visibility toggle"],
  [adminPage.includes("data-won-agency-profit-total"), "Won Quotes agency-profit totals"],
  [adminPage.includes("Agency profit after salesperson commission inc GST"), "Won Quotes XLSX field"],
];

const failed = checks.filter(([passed]) => !passed);
if (failed.length) {
  for (const [, label] of failed) console.error(`Missing ${label}.`);
  process.exit(1);
}

console.log("agency profit visibility checks passed");
