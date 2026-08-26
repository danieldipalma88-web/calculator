import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "index.html"), "utf8");

assert.match(html, /id="allModelsSingleModeBtn"[^>]+setAllModelsMode\('single'\)/);
assert.match(html, /id="allModelsMultiModeBtn"[^>]+setAllModelsMode\('multi'\)/);
assert.match(html, /id="allModelsMultiBrand"/);
assert.match(html, /id="allModelsMultiOutdoor"/);
assert.match(html, /id="allModelsMultiRows"/);
assert.match(html, /id="allModelsMultiCompatibility"/);

assert.match(
  html,
  /multiSplitCompatibleIndoorIndexes\(outdoor,\{includeUnpriced:true\}\)/,
  "The rebate-only lookup must include verified catalogue models even when no quote price exists.",
);
assert.match(
  html,
  /compatible\.includes\(previousIndex\)\?previousIndex:compatible\[0\]/,
  "Adding another head must reuse the previous compatible indoor model.",
);
assert.match(html, /totals\.headCount>=maxHeads/);
assert.match(html, /totals\.headCount>maxHeads/);
assert.match(html, /The rebate calculation will use the outdoor unit limit/);
assert.match(html, /The rebate calculation will use the connected indoor capacity/);

assert.match(html, /if\(allModelsMode==='multi'\) return calculateAllModelsMultiRebate\(\)/);
assert.match(html, /const capacityInputs=multiSplitCertificateInputs\(resolved\.meta,totals\.indoorItems\)/);
assert.match(html, /airConditionerType:'non_ducted_multi_split_system'/);
assert.match(html, /coolingCapacity:capacityInputs\.coolingCapacity/);
assert.match(html, /heatingCapacity:capacityInputs\.heatingCapacity/);
assert.match(html, /inputPower:capacityInputs\.inputPower/);
assert.match(
  html,
  /getDcceewContractMatch\(\{brand:outdoor\.brand,model:outdoor\.rebateModel\|\|outdoor\.model\},postcode\)/,
);
assert.match(html, /renderAllModelsCalculationError\(error\)/);
assert.match(html, /Rebate set to \$0\.00 because the calculation could not be completed/);

const allModelsSection = html.slice(
  html.indexOf('<div class="allModelsCard"'),
  html.indexOf('<div class="currentOptionPanel card"'),
);
assert.doesNotMatch(allModelsSection, /onclick="addToQuote\(/);
assert.doesNotMatch(allModelsSection, /unitPriceInc|finalInc|Add to Quote/);
assert.match(html, /\.allModelsMultiRow\{grid-template-columns:1fr;/);
assert.match(html, /\.allModelsMultiSummary\{grid-template-columns:1fr\}/);

console.log("All Models multi-head lookup verification passed.");
