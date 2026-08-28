import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const admin = fs.readFileSync(path.join(root, "app/admin/users/page.tsx"), "utf8");
const rebate = fs.readFileSync(path.join(root, "lib/nsw-hvac-rebate.ts"), "utf8");
const calculator = fs.readFileSync(path.join(root, "index.html"), "utf8");

function expect(source, pattern, message) {
  if (!pattern.test(source)) throw new Error(message);
}

expect(admin, /value="update_rebate"[\s\S]{0,100}>\s*Update rebate\s*</, "Won Quotes is missing the Update rebate bulk action");
expect(admin, /export const maxDuration = 60/, "Won quote rebate refresh does not allow enough server execution time for bulk updates");
expect(admin, /if \(mode === "update_rebate"\)[\s\S]*getPlatformCertificateValues/, "Update rebate does not load authoritative current certificate values");
expect(admin, /Promise\.all\(targetIndexes\.map\([\s\S]*calculateCurrentNswRebate[\s\S]*const nextQuotes = quotes\.slice\(\)/, "Selected quote systems are not calculated atomically before mutation");
expect(admin, /nextQuotes\[index\] = recomputeSavedQuoteAfterRebate/, "Calculated rebates are not applied to saved quote rows");
expect(admin, /state: Record<string, unknown> = \{ \.\.\.quoteState\(row\), rebate: rebate\.toFixed\(2\) \}/, "Saved quote state rebate is not updated alongside the row rebate");
expect(admin, /verifyResult[\s\S]*savedWonRebateSummary[\s\S]*verified\.rebateTotal/, "Saved rebate updates are not verified after the database write");
expect(admin, /eq\("updated_at", dataResult\.data\.updated_at\)/, "Rebate updates are missing optimistic concurrency protection");
expect(admin, /Recovered backup quotes cannot be repriced/, "Recovered backup quote safety guard is missing");

expect(rebate, /DCCEEW_CONTRACT_RATE/, "Current rebate calculator does not include the DCCEEW contract rate");
expect(rebate, /certificates\.esc \* effectiveEscRate[\s\S]*certificates\.prc \* input\.prcRate/, "Current payout rates are not applied to live certificate counts");
expect(rebate, /The saved multi-head quote is missing rated indoor capacity/, "Legacy multi-head quotes are not guarded against guessed capacity values");
expect(rebate, /Math\.min\(indoorCooling, outdoorCooling\)/, "Multi-head cooling capacity is not capped at the lesser connected/outdoor capacity");

expect(calculator, /businessId:String\(calculatorUserContext\(\)\.businessId\|\|''\), businessName:activeBusinessName\(\)/, "New saved quotes do not retain their business identity");
expect(calculator, /ratedCoolingCapacity:item\.row\.ratedCoolingCapacity,ratedHeatingCapacity:item\.row\.ratedHeatingCapacity/, "New multi-head quotes do not retain rated indoor capacities");

console.log("Won quote current-rebate refresh guards verified.");
