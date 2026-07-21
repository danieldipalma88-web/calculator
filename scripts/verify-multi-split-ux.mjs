import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(path.join(root, "index.html"), "utf8");

const indoorBuilderPosition = html.indexOf('id="multiSplitIndoorRows"');
const rebatePanelPosition = html.indexOf('id="multiSplitRebatePanel"');
const costsPosition = html.indexOf('<h2 class="sectionTitle">Costs</h2>', rebatePanelPosition);
const summaryPosition = html.indexOf('class="summary card multiSplitSummaryCard"');

assert.ok(indoorBuilderPosition >= 0, "The indoor-unit builder must exist.");
assert.ok(rebatePanelPosition > indoorBuilderPosition, "Rebate calculation must follow the indoor-unit builder.");
assert.ok(costsPosition > rebatePanelPosition, "Rebate calculation must appear before the costs section.");
assert.ok(summaryPosition > costsPosition, "The sticky financial summary must follow the main workflow in source order.");

assert.match(html, /id="multiSplitCheckRebateBtn"[^>]*>Calculate rebate<\/button>/, "The prominent action must use the Calculate rebate label.");
assert.doesNotMatch(html, />Check rebate<\/button>/, "The old Check rebate action label must not return.");
assert.match(html, /id="multiSplitRebateFreshness"/, "The page must show whether the rebate is current.");
assert.match(html, /multiSplitRebateFresh=false;/, "Equipment changes must invalidate the previous rebate.");
assert.match(html, /multiSplitRebateFresh=true;/, "A completed or intentional manual rebate must become current.");
assert.match(html, /if\(rebatesEnabled\(\)&&!multiSplitRebateFresh\)/, "A stale rebate must block adding the system to a quote.");

assert.match(html, /class="multiSplitIndoorFacts"/, "Indoor rows must expose capacity and price facts.");
assert.match(html, /function adjustMultiSplitIndoorQty\(index,delta\)/, "Indoor quantity steppers must have a dedicated handler.");
assert.match(html, /id="multiSplitHeadProgress"/, "Head-count progress must be visible.");
assert.match(html, /id="multiSplitCapacityProgress"/, "Capacity progress must be visible.");
assert.match(html, /The rebate calculation will cap cooling capacity at the outdoor rating/, "Over-connected capacity feedback must explain the rebate cap.");
assert.match(html, /The rebate calculation will use the connected indoor capacity/, "Under-connected capacity feedback must explain the lesser-of rule.");

assert.match(html, /<details class="multiSplitFinancialDetails">/, "Detailed financials must use progressive disclosure.");
assert.match(html, /<details class="multiSplitTools">/, "Secondary tools must be grouped away from the primary quote action.");
assert.match(html, /id="multiSplitAddToQuoteBtn"/, "The summary must retain a clear primary quote action.");
assert.match(html, /\.multiSplitIndoorRow\{grid-template-columns:1fr;gap:12px/, "Indoor rows must stack at the mobile breakpoint.");
assert.match(html, /\.multiSplitPrimaryActions\{display:none\}/, "Mobile must rely on the existing compact floating quote actions.");

const multiIds = [...html.matchAll(/\sid="(multi[^"]+)"/g)].map((match) => match[1]);
const duplicateMultiIds = [...new Set(multiIds.filter((id, index) => multiIds.indexOf(id) !== index))];
assert.deepEqual(duplicateMultiIds, [], "Multi-head static element IDs must remain unique.");

console.log("multi-split ux ok");
