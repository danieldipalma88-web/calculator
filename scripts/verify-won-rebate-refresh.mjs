import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = process.cwd();
const admin = fs.readFileSync(path.join(root, "app/admin/users/page.tsx"), "utf8");
const rebate = fs.readFileSync(path.join(root, "lib/nsw-hvac-rebate.ts"), "utf8");
const calculator = fs.readFileSync(path.join(root, "index.html"), "utf8");

function expect(source, pattern, message) {
  if (!pattern.test(source)) throw new Error(message);
}

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`${name} is missing`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} has an incomplete body`);
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
expect(admin, /if \(!systemType\) throw new Error\(`Saved quote system \$\{index \+ 1\} has an unrecognised system type/, "Unknown saved quote types do not fail safely before repricing");

const savedSystemTypeSource = functionSource(admin, "savedQuoteSystemType")
  .replace(/^function savedQuoteSystemType\([^)]*\): [^{]+\{/, "function savedQuoteSystemType(row) {");
const systemTypeSandbox = {
  quoteState: (row) => row.state && typeof row.state === "object" && !Array.isArray(row.state) ? row.state : {},
};
vm.runInNewContext(`${savedSystemTypeSource}\nglobalThis.__savedSystemType=savedQuoteSystemType;`, systemTypeSandbox);
assert.equal(systemTypeSandbox.__savedSystemType({ state: { systemType: "ducted" } }), "ducted");
assert.equal(systemTypeSandbox.__savedSystemType({ type: "Ducted" }), "ducted", "legacy Ducted quote labels must remain supported");
assert.equal(systemTypeSandbox.__savedSystemType({ type: "Multi-head Split" }), "multi_split", "legacy multi-head quote labels must remain supported");
assert.equal(systemTypeSandbox.__savedSystemType({ type: "Split" }), "split", "legacy Split quote labels must remain supported");
assert.equal(systemTypeSandbox.__savedSystemType({ state: { systemType: "unrecognised" }, type: "Ducted" }), "ducted", "a valid legacy row type must recover an invalid state label");
assert.equal(systemTypeSandbox.__savedSystemType({ state: { systemType: "unknown new ducted" } }), null, "ambiguous saved quote types must not default to split");

expect(rebate, /DCCEEW_CONTRACT_RATE/, "Current rebate calculator does not include the DCCEEW contract rate");
expect(rebate, /certificates\.esc \* effectiveEscRate[\s\S]*certificates\.prc \* input\.prcRate/, "Current payout rates are not applied to live certificate counts");
expect(rebate, /The saved multi-head quote is missing rated indoor capacity/, "Legacy multi-head quotes are not guarded against guessed capacity values");
expect(rebate, /Math\.min\(indoorCooling, outdoorCooling\)/, "Multi-head cooling capacity is not capped at the lesser connected/outdoor capacity");

expect(calculator, /businessId:String\(calculatorUserContext\(\)\.businessId\|\|''\), businessName:activeBusinessName\(\)/, "New saved quotes do not retain their business identity");
expect(calculator, /ratedCoolingCapacity:item\.row\.ratedCoolingCapacity,ratedHeatingCapacity:item\.row\.ratedHeatingCapacity/, "New multi-head quotes do not retain rated indoor capacities");

console.log("Won quote current-rebate refresh guards verified.");
