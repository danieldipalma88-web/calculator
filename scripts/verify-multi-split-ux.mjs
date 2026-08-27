import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "index.html"), "utf8");
const dcceewProducts = JSON.parse(readFileSync(path.join(root, "lib", "dcceew-contract-products.json"), "utf8"));

const indoorBuilderPosition = html.indexOf('id="multiSplitIndoorRows"');
const rebatePanelPosition = html.indexOf('id="multiSplitRebatePanel"');
const costsPosition = html.indexOf('<h2 class="sectionTitle">Costs</h2>', rebatePanelPosition);
const summaryPosition = html.indexOf('class="summary card multiSplitSummaryCard"');

assert.ok(indoorBuilderPosition >= 0, "The indoor-unit builder must exist.");
assert.ok(rebatePanelPosition > indoorBuilderPosition, "Rebate calculation must follow the indoor-unit builder.");
assert.ok(costsPosition > rebatePanelPosition, "Rebate calculation must appear before the costs section.");
assert.ok(summaryPosition > costsPosition, "The sticky financial summary must follow the main workflow in source order.");

assert.match(html, /id="multiSplitCheckRebateBtn"[^>]*>Calculate rebate<\/button>/, "The prominent action must use the Calculate rebate label.");
assert.match(html, /id="multiSplitQuickRebateBtn"[^>]*onclick="calculateMultiSplitTrialRebate\(true\)"/, "A second rebate action must sit beside the multi-head postcode.");
assert.match(html, /scrollIntoView\(\{behavior:'smooth',block:'start'\}\)/, "The upper rebate action must reveal the rebate results.");
assert.doesNotMatch(html, />Check rebate<\/button>/, "The old Check rebate action label must not return.");
assert.match(html, /id="multiSplitTab" onclick="setMultiSplitSection\(\)"/, "The multi-head tab must be visible by default.");
assert.match(html, /function multiSplitTrialEnabled\(\)\{\s*return true;\s*\}/, "Multi-head access must be enabled for every approved calculator user.");
assert.doesNotMatch(html, /Admin trial|admin-only trial mode|Not live/, "The live calculator must not show trial-only messaging.");
assert.match(html, /id="multiSplitRebateFreshness"/, "The page must show whether the rebate is current.");
assert.match(html, /multiSplitRebateFresh=false;/, "Equipment changes must invalidate the previous rebate.");
assert.match(html, /multiSplitRebateFresh=true;/, "A completed or intentional manual rebate must become current.");
assert.match(html, /if\(rebatesEnabled\(\)&&!multiSplitRebateFresh\)/, "A stale rebate must block adding the system to a quote.");
assert.match(html, /function syncSharedEssPostcode\(/, "All calculator types must use a shared postcode synchronizer.");
assert.match(html, /syncSharedEssPostcode\(postcodeEl\.value,'standard',true\)/, "Standard postcode changes must update the shared value.");
assert.match(html, /syncSharedEssPostcode\(postcode\.value,'multi',true\)/, "Multi-head postcode changes must update the shared value.");

assert.match(html, /class="multiSplitIndoorFacts"/, "Indoor rows must expose capacity and price facts.");
assert.match(html, /function adjustMultiSplitIndoorQty\(index,delta\)/, "Indoor quantity steppers must have a dedicated handler.");
assert.match(html, /compatible\.includes\(previousIndex\)\?previousIndex:compatible\[0\]/, "A new indoor row must reuse the last selected compatible model.");
assert.match(html, /id="multiSplitHeadProgress"/, "Head-count progress must be visible.");
assert.match(html, /id="multiSplitCapacityProgress"/, "Capacity progress must be visible.");
assert.match(html, /The rebate calculation will cap cooling capacity at the outdoor rating/, "Over-connected capacity feedback must explain the rebate cap.");
assert.match(html, /The rebate calculation will use the connected indoor capacity/, "Under-connected capacity feedback must explain the lesser-of rule.");
assert.doesNotMatch(html, /daikin-cooling-only|CTKM\d+RVMA|[345]MKM\d+R[2Z]VMA/, "Daikin cooling-only products must not appear in the live catalogue.");
assert.match(html, /multiOutdoor\('Daikin','Reverse Cycle Lite'/, "Daikin reverse-cycle outdoor products must remain available.");
assert.match(html, /multiIndoor\('Daikin','Reverse Cycle Cora'/, "Daikin reverse-cycle indoor products must remain available.");
assert.match(html, /function clearMultiSplitCataloguePrices\(\)/, "Multi-head pricing must have one explicit reset path.");
assert.match(html, /clearMultiSplitCataloguePrices\(\);/, "The zero-price reset must run when the calculator catalogue loads.");
assert.match(html, /MULTI_SPLIT_OUTDOORS\.forEach\(row=>\{row\.unitPriceInc=0;row\.priceIncGst=0;\}\)/, "Every outdoor price must be reset to zero.");
assert.match(html, /ALL_MODELS_MULTI_INDOORS\.forEach\(row=>\{row\.unitPriceInc=0;row\.priceIncGst=0;\}\)/, "Every indoor-head price must be reset to zero.");
assert.match(html, /function loadVerifiedMultiSplitBrandRegistry\(\)/, "Available brands must be intersected with the verified head catalogue.");
assert.match(html, /const brand=canonicalMultiSplitHeadBrand\(rawBrand\)/, "Raw GEMS brand aliases must resolve to the verified catalogue brand.");
assert.match(html, /function fetchVerifiedMultiSplitOutdoors\(brand\)/, "The quote builder must load current GEMS outdoor models.");
assert.match(html, /function mergeVerifiedMultiSplitOutdoors\(brand,rows\)/, "Live outdoor models must be available to the quote builder.");
assert.match(html, /function multiSplitCompatibleIndoorIndexes\(outdoor,options\)[\s\S]*ALL_MODELS_MULTI_INDOORS/, "The quote builder must use the complete verified head catalogue.");
assert.match(html, /Equipment prices must be added before this system can be quoted/, "Zero-priced multi-head equipment must explain why quoting is blocked.");
assert.match(html, /HINRPX25M:\[2\.6,3\.25\]/, "Rinnai PX rebate capacity must use manufacturer-rated cooling and heating values.");
assert.match(html, /MON6H19B1TA',[0-9.]+,6/, "The 19kW Rinnai outdoor must support six indoor heads.");

const normalizeBrand = (value) => {
  const compact = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact === "ACTRON") return "ACTRONAIR";
  if (compact === "FUJITSUGENERAL") return "FUJITSU";
  return compact;
};
const multiOutdoors = [...html.matchAll(/multiOutdoor\('([^']+)','[^']+',[^,]+,'([^']+)'[^\n]*/g)].map((match) => ({
  brand: match[1],
  model: match[0].match(/rebateModel:'([^']+)'/)?.[1] || match[2],
}));
const contractSet = new Set(dcceewProducts);
const contractMatches = multiOutdoors.filter(({ brand, model }) => contractSet.has(
  `${normalizeBrand(brand)}|${model.toUpperCase().replace(/[^A-Z0-9]/g, "")}`,
));
assert.ok(contractMatches.length >= 20, "Approved multi-head outdoor models must remain detectable in the DCCEEW register.");
assert.match(html, /getDcceewContractMatch\(\{brand:outdoor\.brand,model:outdoor\.rebateModel\|\|outdoor\.model\},postcode\)/, "Multi-head calculations must check the approved rebate model against the DCCEEW register.");
assert.match(html, /applyDcceewContractRebate\(dcceewMatch,standardResult\)/, "A qualifying multi-head calculation must use the DCCEEW contract payout.");
assert.match(html, /id="multiSplitDcceewContractPanel"/, "Multi-head contract eligibility must be visible to the user.");

assert.match(html, /<details class="multiSplitFinancialDetails">/, "Detailed financials must use progressive disclosure.");
assert.match(html, /<details class="multiSplitTools">/, "Secondary tools must be grouped away from the primary quote action.");
assert.match(html, /id="multiSplitAddToQuoteBtn"/, "The summary must retain a clear primary quote action.");
assert.match(html, /\.multiSplitIndoorRow\{grid-template-columns:1fr;gap:12px/, "Indoor rows must stack at the mobile breakpoint.");
assert.match(html, /\.multiSplitPrimaryActions\{display:none\}/, "Mobile must rely on the existing compact floating quote actions.");

const multiIds = [...html.matchAll(/\sid="(multi[^"]+)"/g)].map((match) => match[1]);
const duplicateMultiIds = [...new Set(multiIds.filter((id, index) => multiIds.indexOf(id) !== index))];
assert.deepEqual(duplicateMultiIds, [], "Multi-head static element IDs must remain unique.");

console.log(`multi-split ux ok (${contractMatches.length} DCCEEW-approved outdoor models)`);
