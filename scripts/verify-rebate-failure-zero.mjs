import assert from "node:assert/strict";
import fs from "node:fs";

const calculator = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

function functionSource(name) {
  const start = calculator.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing ${name}`);
  let depth = 0;
  let opened = false;
  for (let index = start; index < calculator.length; index += 1) {
    if (calculator[index] === "{") {
      depth += 1;
      opened = true;
    } else if (calculator[index] === "}") {
      depth -= 1;
      if (opened && depth === 0) return calculator.slice(start, index + 1);
    }
  }
  throw new Error(`Could not parse ${name}`);
}

const liveRefresh = functionSource("refreshLiveRebateForCurrentProduct");
assert.match(
  liveRefresh,
  /clearCertificateRuntime\(\);\s*if\(\$\('rebate'\)\) \$\('rebate'\)\.value='0\.00';\s*render\(\);\s*setCertificateBreakdown\(null,'Loading live certificate counts\.\.\.'/,
  "A live calculation must clear any saved/default rebate before the request starts.",
);
assert.match(
  liveRefresh,
  /catch\(e\)\{[\s\S]*?if\(\$\('rebate'\)\) \$\('rebate'\)\.value='0\.00';\s*render\(\);/,
  "A failed standard rebate calculation must leave the active rebate at zero.",
);
assert.match(
  liveRefresh,
  /setRebateCalcMeta\(`Rebate set to \$0\.00\./,
  "The failure message must explicitly report a zero rebate.",
);
assert.doesNotMatch(
  liveRefresh,
  /Using saved rebate/,
  "A failed live calculation must never claim to use a saved rebate.",
);

const certificateBreakdown = functionSource("setCertificateBreakdown");
assert.match(
  certificateBreakdown,
  /certRebateValue'\)\.textContent=isError\?money\(0\):'-'/,
  "The certificate result card must display $0.00 on calculation failure.",
);

const multiSplitCalculation = functionSource("calculateMultiSplitTrialRebate");
assert.match(
  multiSplitCalculation,
  /catch\(e\)\{[\s\S]*?multiSplitRebateValue'\)\.textContent=money\(0\)/,
  "A failed multi-head calculation must display a zero rebate.",
);
assert.match(
  multiSplitCalculation,
  /multiSplitHasCalculated=true;\s*multiSplitRebateFresh=true;/,
  "A failed multi-head calculation must be treated as a current zero result, not stale fallback data.",
);
assert.match(
  multiSplitCalculation,
  /Rebate set to \$0\.00 because the multi-head rebate could not be calculated/,
  "The multi-head failure message must explain the zero result.",
);
assert.match(
  multiSplitCalculation,
  /if\(!multiSplitRebateFresh\) updateMultiSplitRebateFreshness\('error'\)/,
  "Final cleanup must not overwrite the current zero-result state.",
);

console.log("rebate failure zero checks passed");
