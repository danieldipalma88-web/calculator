import { readFile } from "node:fs/promises";

const files = {
  admin: await readFile(new URL("../app/admin/users/page.tsx", import.meta.url), "utf8"),
  calculator: await readFile(new URL("../app/calculator/page.tsx", import.meta.url), "utf8"),
  raw: await readFile(new URL("../app/calculator/raw/route.ts", import.meta.url), "utf8"),
  ui: await readFile(new URL("../index.html", import.meta.url), "utf8"),
};

const checks = [
  [files.calculator, "<CalculatorFrame src={rawSrc} />", "initial calculator loader"],
  [files.calculator, 'loadingLabel="Switching business..."', "business switch loader"],
  [files.calculator, 'loadingLabel="Opening user calculator..."', "account switch loader"],
  [files.admin, "<PageLoadingOverlay />", "Platform Admin loader"],
  [files.admin, "setWonActionLoading(form, submitter)", "won action loader"],
  [files.admin, 'setWonSectionLoading(true, "Preparing Excel export...")', "Excel export loader"],
  [files.raw, "setCloudSaveStatus('Saving...', 'saving')", "cloud saving status"],
  [files.raw, "setCloudSaveStatus('Retrying...', 'retrying')", "cloud retry status"],
  [files.ui, "setLiveRebateLoading(true)", "live rebate loader"],
  [files.ui, "data-rebate-disabled-before", "Add to Quote rebate protection"],
  [files.ui, "setSectionLoading('bestValueComparison',true", "best value comparison loader"],
  [files.ui, "setSectionLoading('energySavingsBody',true", "energy savings loader"],
  [files.ui, "setSectionLoading('multiSplitRebatePanel',true", "multi-head rebate loader"],
  [files.ui, "setWonAddressBusy(true)", "Google address verification loader"],
];

const missing = checks.filter(([source, needle]) => !source.includes(needle));
if (missing.length) {
  for (const [, , label] of missing) console.error(`Missing ${label}.`);
  process.exit(1);
}

console.log("loading state checks passed");
