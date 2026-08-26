import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanGemsBrand,
  isEligibleAustralianGemsRecord,
  isGemsMultiSplitOutdoorRecord,
  mapGemsModelSearchItem,
  normalizeGemsModelQuery,
} from "../lib/gems-model-search.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const route = fs.readFileSync(
  path.join(root, "app", "api", "gems-model-search", "route.ts"),
  "utf8",
);

assert.match(html, /id="allModelsTab"[^>]+setAllModelsSection/);
assert.match(html, /id="allModelsCard"/);
assert.match(html, /id="allModelsBrand"/);
assert.match(html, /id="allModelsSearch"/);
assert.match(html, /id="allModelsCalculateBtn"/);
assert.match(html, /calculateCertificatesForModel\(meta,climate,\{airConditionerType,installType:allModelsInstallType\}\)/);
assert.match(html, /getDcceewContractMatch\(\{brand:selected\.brand,model:selected\.model\},postcode\)/);
assert.match(html, /selected\.multiHead/);
assert.match(html, /Rebate set to \$0\.00 because the calculation could not be completed/);
assert.match(html, /source!==['"]allModels['"]/);

const allModelsSection = html.slice(
  html.indexOf('<div class="allModelsCard"'),
  html.indexOf('<div class="currentOptionPanel card"'),
);
assert.ok(allModelsSection.length > 0, "All Models section should be present");
assert.doesNotMatch(allModelsSection, /onclick="addToQuote\(/);
assert.doesNotMatch(allModelsSection, /unitPriceInc|finalInc|Add to Quote/);

assert.match(route, /mode === "brands"/);
assert.match(route, /mode === "multi-brands"/);
assert.match(route, /mode === "multi-outdoors"/);
assert.match(route, /query\.length < 2/);
assert.match(route, /slice\(0, 30\)/);

assert.equal(normalizeGemsModelQuery("  RXM-25 / FTXM-25  "), "RXM25FTXM25");
assert.equal(cleanGemsBrand(" Daikin\u0000 "), "Daikin");

assert.equal(
  isEligibleAustralianGemsRecord({
    SubmitStatus: "Approved",
    "Availability Status": "Available",
    Sold_in: "Australia, New Zealand",
  }),
  true,
);
assert.equal(
  isEligibleAustralianGemsRecord({
    SubmitStatus: "Approved",
    "Availability Status": "Unavailable",
    Sold_in: "Australia",
  }),
  false,
);

const completeRecord = {
  Brand: "Daikin",
  Model_No: "RXM25YVMA / FTXM25YVMA",
  "Family Name": "Cora",
  Configuration1: "Non ducted single split system",
  "Product Class": "Class 8",
  "C-Total Cool Rated": "2.5",
  "H-Total Heat Rated": "3.2",
  "C-Power_Inp_Rated": "0.55",
  "Rated AEER": "4.1",
  "Rated ACOP": "4.3",
  "Residential TCSPF_mixed": "5.1",
  "Residential HSPF_mixed": "4.2",
  "Residential HSPF_cold": "3.9",
  "Residential tcec_hot": "100",
  "Residential tcec_mixed": "110",
  "Residential tcec_cold": "120",
  "Residential thec_hot": "90",
  "Residential thec_mixed": "95",
  "Residential thec_cold": "105",
};
const mapped = mapGemsModelSearchItem(completeRecord);
assert.equal(mapped?.brand, "Daikin");
assert.equal(mapped?.capacityKw, 2.5);
assert.equal(mapped?.multiHead, false);
assert.equal(mapped?.completeEnergyData, true);
assert.equal(mapped?.metadata["Product Class"], "Class 8");

const multi = mapGemsModelSearchItem({
  ...completeRecord,
  Model_No: "2MXM50",
  ApplStandard: "[SEER Multi-Split <=65kW] AS/NZS 3823.4.1",
  Configuration2: "fixed",
  "Outdoor unit only": "Yes",
});
assert.equal(isGemsMultiSplitOutdoorRecord(multi?.metadata || {}), true);
assert.equal(multi?.multiHead, true);
assert.equal(multi?.multiSplitOutdoor, true);

const ordinaryOutdoorOnly = mapGemsModelSearchItem({
  ...completeRecord,
  Model_No: "RXM25YVMA",
  Configuration2: "non_ducted_single_split_system",
  "Outdoor unit only": "Yes",
});
assert.equal(ordinaryOutdoorOnly?.outdoorOnly, true);
assert.equal(ordinaryOutdoorOnly?.multiHead, false);

console.log("All Models lookup verification passed.");
