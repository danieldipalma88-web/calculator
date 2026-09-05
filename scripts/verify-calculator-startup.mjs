import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const calculatorPage = await readFile(
  new URL("../app/calculator/page.tsx", import.meta.url),
  "utf8",
);
const rawRoute = await readFile(
  new URL("../app/calculator/raw/route.ts", import.meta.url),
  "utf8",
);
const loadingUi = await readFile(
  new URL("../app/page-loading-overlay.tsx", import.meta.url),
  "utf8",
);
const middleware = await readFile(
  new URL("../middleware.ts", import.meta.url),
  "utf8",
);
const calculatorUi = await readFile(
  new URL("../index.html", import.meta.url),
  "utf8",
);
const inlineScripts = [...calculatorUi.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
  (match) => match[1],
);

assert.ok(inlineScripts.length > 0, "The calculator must contain its startup script.");
for (const source of inlineScripts) {
  assert.doesNotThrow(
    () => new Function(source),
    "The optimized calculator startup script must remain valid JavaScript.",
  );
}

assert.match(
  calculatorPage,
  /after\(async \(\) => \{\s*await supabase\.rpc\("record_current_user_activity"\);\s*\}\);/,
  "Last-active tracking must run after the calculator response.",
);
assert.match(
  calculatorPage,
  /const approvedUsersPromise =/,
  "Admin user data should begin loading without blocking the business query.",
);
assert.match(
  calculatorPage,
  /const allBusinessesPromise =/,
  "Admin business data should load in parallel with approved users.",
);

assert.match(
  rawRoute,
  /const calculatorHtmlPromise = readFile\(/,
  "Warm server instances should reuse the immutable calculator source.",
);
assert.match(
  rawRoute,
  /const \[byEmail, byUser, businessResult, platformResult\] = await Promise\.all\(/,
  "Independent calculator data reads must run in parallel.",
);
assert.match(
  rawRoute,
  /const \[businessIds, requestedBusiness\] = await Promise\.all\(/,
  "Business membership validation and the requested business lookup should overlap.",
);
assert.match(
  rawRoute,
  /"Cache-Control": "no-store"/,
  "Private calculator responses must never be cached.",
);

assert.match(
  calculatorUi,
  /<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">/,
  "The calculator should preconnect before requesting its web fonts.",
);
assert.doesNotMatch(
  calculatorUi,
  /@import url\('https:\/\/fonts\.googleapis\.com/,
  "Web fonts should not be discovered through a late CSS import.",
);
assert.match(
  calculatorUi,
  /fonts\.googleapis\.com[\s\S]*?media="print" onload="this\.media='all'"/,
  "Web fonts must load without blocking the usable calculator signal.",
);
assert.match(
  calculatorUi,
  /<noscript><link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com/,
  "Web fonts must retain a no-JavaScript fallback.",
);
assert.match(
  middleware,
  /request\.nextUrl\.pathname === "\/calculator\/raw"/,
  "The raw calculator must avoid duplicate middleware authentication.",
);
assert.match(
  middleware,
  /request\.nextUrl\.pathname === "\/api\/calculator-data"/,
  "The authenticated calculator data endpoint must avoid duplicate middleware authentication.",
);
assert.match(
  rawRoute,
  /const \{\s*data: \{ user \},\s*\} = await supabase\.auth\.getUser\(\);/,
  "The raw calculator must retain its own authoritative authentication check.",
);
assert.match(
  calculatorUi,
  /function ensureSecondaryStartup\(\)/,
  "Secondary calculator tools must have an immediate initialization fallback.",
);
assert.match(
  calculatorUi,
  /window\.addEventListener\('load',run,\{once:true\}\)/,
  "Secondary tools should wait until the primary calculator has loaded.",
);
assert.match(
  calculatorUi,
  /window\.parent\.postMessage\(\{type:'calculator-ready'\},window\.location\.origin\)/,
  "The initialized calculator must announce when its critical UI is usable.",
);
assert.match(
  loadingUi,
  /event\.origin !== window\.location\.origin/,
  "The outer loader must only accept same-origin readiness messages.",
);
assert.match(
  loadingUi,
  /event\.source !== frame\?\.contentWindow/,
  "The outer loader must only accept readiness from its calculator iframe.",
);
assert.match(
  loadingUi,
  /event\.data\?\.type !== "calculator-ready"/,
  "The outer loader must validate the readiness message type.",
);
assert.match(
  loadingUi,
  /onLoad=\{\(\) => setLoading/,
  "The iframe load event must remain as a readiness fallback.",
);
assert.match(
  calculatorUi,
  /function openDrawer\(\)\{ensureSecondaryStartup\(\);/,
  "Opening quotes must initialize deferred quote history immediately.",
);
assert.match(
  calculatorUi,
  /function openWonJobsDrawer\(\)\{ensureSecondaryStartup\(\);/,
  "Opening won jobs must initialize deferred quote history immediately.",
);
assert.doesNotMatch(
  calculatorUi,
  /energySavings|\bENERGY_(?:SAVINGS|HEATING|COOLING|DEFAULT_ELECTRICITY|EXISTING)|energyPanelOpen|firstFiniteEnergyValue|energyBasisLabel|Estimated annual saving/i,
  "The removed annual energy savings estimator must not retain UI, settings, helpers or background requests.",
);

const startupBlock =
  calculatorUi.match(
    /setupMobileHorizontalDragLock\(\);([\s\S]*?)scheduleSecondaryStartup\(\);/,
  )?.[1] || "";
assert.ok(startupBlock, "The primary calculator startup block must be present.");
assert.doesNotMatch(
  startupBlock,
  /loadSavedQuoteSets\(\)|loadQuoteExportName\(\)/,
  "Secondary tools must not block the primary calculator startup.",
);

console.log("calculator startup checks passed");
