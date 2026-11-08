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
  /const message='Rebate unavailable\. This is not a confirmed \$0 rebate\.';\s*setCertificateBreakdown\(null,message,true\)/,
  "The visible failure message must distinguish an unavailable rebate from a confirmed zero rebate.",
);
assert.doesNotMatch(
  liveRefresh,
  /Using saved rebate/,
  "A failed live calculation must never claim to use a saved rebate.",
);

const certificateBreakdown = functionSource("setCertificateBreakdown");
assert.match(
  certificateBreakdown,
  /certRebateValue'\)\.textContent=isError\?'Unavailable':'-'/,
  "The certificate result card must display Unavailable while the numeric failure guard stays at zero.",
);

const multiSplitCalculation = functionSource("calculateMultiSplitTrialRebate");
assert.match(
  multiSplitCalculation,
  /catch\(e\)\{[\s\S]*?resetMultiSplitRebateMetrics\(\);[\s\S]*?multiSplitRebateValue'\)\.textContent='Unavailable'/,
  "A failed multi-head calculation clears numeric costs but displays Unavailable.",
);
assert.match(
  multiSplitCalculation,
  /const requestId=multiSplitTrialRequestSeq;/,
  "The request must use the revision from the initial invalidation.",
);
assert.match(
  multiSplitCalculation,
  /Rebate unavailable\. This is not a confirmed \$0 rebate\./,
  "The multi-head failure message must not claim a confirmed zero result.",
);
assert.match(
  multiSplitCalculation,
  /updateMultiSplitRebateFreshness\(multiSplitRebateFresh\?undefined:'error'\)/,
  "Final cleanup must restore the controls after a successful calculation.",
);
assert.doesNotMatch(multiSplitCalculation.slice(multiSplitCalculation.indexOf("}catch(e)")), /multiSplitRebateFresh=true/,
  "Failures must never become quote-ready.");
assert.match(functionSource("resetMultiSplitRebateMetrics"), /multiSplitTrialRequestSeq\+\+;[\s\S]*multiSplitRebateFresh=false;/,
  "Selection changes invalidate both the old result and pending responses.");

console.log("rebate failure zero checks passed");
