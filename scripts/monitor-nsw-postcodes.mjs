import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import {
  createFrontendCalculator,
  createMemoizedFetch,
  expectedRequestBudget,
  fetchCurrentNswPostcodes,
  isInfrastructureError,
  loadPostcodeInventory,
  markdownSummary,
  parseMonitorArgs,
  validateComparableCertificates,
  NSW_SPATIAL_POSTCODE_URL,
} from "./monitor-nsw-postcodes-helpers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(root, "scripts", "fixtures", "nsw-postcodes.abs-2021.json");

const splitFixture = {
  name: "eligible-split",
  brand: "TCL",
  model: "TAC-10CHSD/VEIH",
  systemType: "split",
  airConditionerType: "non_ducted_single_split_system",
};
const ductedFixture = {
  name: "eligible-ducted",
  brand: "TCL",
  model: "TCD71D1HWH-DVO/TCD71D1HWH-DVI",
  systemType: "ducted",
  airConditionerType: "ducted_single_split_system",
};

function now() { return new Date().toISOString(); }

function taskFor(postcode, fixture, installType) {
  return { postcode, fixture, installType, case: `${fixture.name}-${installType}` };
}

function resultFor(task, status, message, extra = {}) {
  return { postcode: task.postcode, case: task.case, status, message, ...extra };
}

let loaderRegistered = false;
async function loadProductionCalculator() {
  if (!loaderRegistered) {
    register("./monitor-nsw-postcodes-loader.mjs", import.meta.url);
    loaderRegistered = true;
  }
  const [rebate, gems] = await Promise.all([
    import("../lib/nsw-hvac-rebate.ts"),
    import("../lib/gems-model-search.ts"),
  ]);
  return { ...rebate, ...gems };
}

function compact(value) {
  return String(value).toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

async function loadLiveGemsMetadata(production, fixture) {
  const records = await production.fetchGemsDatastoreRecords({
    query: fixture.model,
    limit: 250,
    revalidateSeconds: 3_600,
  });
  const item = records
    .filter(production.isEligibleAustralianGemsRecord)
    .map(production.mapGemsModelSearchItem)
    .find((candidate) => candidate?.completeEnergyData
      && compact(candidate.brand) === compact(fixture.brand)
      && compact(candidate.model) === compact(fixture.model));
  if (!item) throw new Error(`Current GEMS metadata is unavailable for ${fixture.name}; refusing to compare different browser and server inputs`);
  return item.metadata;
}

export async function runMonitor(options = parseMonitorArgs(process.argv.slice(2))) {
  const started = Date.now();
  const [inventory, indexHtml, currentPostcodes] = await Promise.all([
    loadPostcodeInventory(fixturePath),
    readFile(path.join(root, "index.html"), "utf8"),
    fetchCurrentNswPostcodes({ timeoutMs: options.timeoutMs }),
  ]);
  if (currentPostcodes.length < inventory.postcodes.length) {
    throw new Error(`NSW Spatial Services inventory is unexpectedly smaller than the pinned baseline (${currentPostcodes.length} < ${inventory.postcodes.length})`);
  }
  const allPostcodes = [...new Set([...inventory.postcodes, ...currentPostcodes])].sort();
  const requested = options.postcodes || allPostcodes;
  const unknown = requested.filter((postcode) => !allPostcodes.includes(postcode));
  if (unknown.length) throw new Error(`Requested postcode(s) are absent from the independent NSW fixture: ${unknown.join(", ")}`);
  const postcodes = [...new Set(requested)].sort();
  const tasks = postcodes.flatMap((postcode) => [
    taskFor(postcode, splitFixture, "new"),
    taskFor(postcode, splitFixture, "replacement"),
  ]);
  // A physical multi-split fixture is not committed with complete outdoor and indoor ratings.
  // The monitor refuses to invent those inputs; dedicated multi-split coverage remains a required future fixture.
  const controlPostcode = postcodes.includes("2550") ? "2550" : postcodes[0];
  tasks.push(taskFor(controlPostcode, ductedFixture, "new"));
  tasks.push(taskFor(controlPostcode, ductedFixture, "replacement"));
  const report = {
    monitor: "nsw-postcode-rebate",
    startedAt: now(),
    inventory: {
      source: inventory.source,
      sourceUrl: inventory.sourceUrl,
      coverage: inventory.coverage,
      currentSourceUrl: NSW_SPATIAL_POSTCODE_URL,
      pinnedCount: inventory.postcodes.length,
      currentCount: currentPostcodes.length,
      unionCount: allPostcodes.length,
      currentOnly: currentPostcodes.filter((postcode) => !inventory.postcodes.includes(postcode)),
      baselineOnly: inventory.postcodes.filter((postcode) => !currentPostcodes.includes(postcode)),
    },
    scope: { postcodeCount: postcodes.length, cases: tasks.length, postcodes },
    expectedRequestBudget: expectedRequestBudget(postcodes.length),
    configuration: {
      concurrency: options.concurrency,
      timeoutMs: options.timeoutMs,
      budgetMs: options.budgetMs,
      fixtures: [splitFixture.name, ductedFixture.name],
      metadata: "same current GEMS records mapped by lib/gems-model-search.ts for both paths",
      multiSplit: "not run: no committed complete physical multi-split rating fixture",
    },
    results: [],
    counts: { passed: 0, calculationFailure: 0, infrastructureFailure: 0, untested: 0 },
    network: { networkRequests: 0, cacheHits: 0, retries: 0 },
    durationMs: 0,
    ok: false,
  };
  if (options.dryRun) {
    report.status = "dry-run (not tested)";
    report.counts.untested = tasks.length;
    report.durationMs = Date.now() - started;
    report.ok = null;
    return report;
  }

  const originalFetch = globalThis.fetch;
  const memoized = createMemoizedFetch({ fetchImpl: originalFetch, timeoutMs: options.timeoutMs, retries: 1 });
  globalThis.fetch = memoized.fetch;
  try {
    const [production, frontend] = await Promise.all([
      loadProductionCalculator(),
      createFrontendCalculator({ indexHtml, fetch: memoized.fetch }),
    ]);
    const [splitMetadata, ductedMetadata] = await Promise.all([
      loadLiveGemsMetadata(production, splitFixture),
      loadLiveGemsMetadata(production, ductedFixture),
    ]);
    const metadataFor = (fixture) => fixture === splitFixture ? splitMetadata : ductedMetadata;
    let taskIndex = 0;
    let stopReason = "";
    let infrastructureFailures = 0;
    const deadline = started + options.budgetMs;
    const runTask = async (task) => {
      const metadata = metadataFor(task.fixture);
      try {
        const server = await production.calculateCurrentNswRebate({
          brand: task.fixture.brand,
          model: task.fixture.model,
          postcode: task.postcode,
          installType: task.installType,
          systemType: task.fixture.systemType,
          escRate: 1,
          prcRate: 1,
        });
        const frontendResult = await frontend.calculate({
          postcode: task.postcode,
          metadata,
          installType: task.installType,
          airConditionerType: task.fixture.airConditionerType,
        });
        const failure = validateComparableCertificates(server, frontendResult, true);
        if (failure) return resultFor(task, "calculation-failure", failure, { server, frontend: { esc: frontendResult.esc, prc: frontendResult.prc } });
        return resultFor(task, "passed", "", { server, frontend: { esc: frontendResult.esc, prc: frontendResult.prc } });
      } catch (error) {
        const message = String(error?.message || error).slice(0, 500);
        return resultFor(task, isInfrastructureError(error) ? "infrastructure-failure" : "calculation-failure", message);
      }
    };
    const workers = Array.from({ length: options.concurrency }, async () => {
      while (!stopReason) {
        if (Date.now() >= deadline) { stopReason = "monitor time budget exceeded"; break; }
        const index = taskIndex;
        taskIndex += 1;
        if (index >= tasks.length) break;
        const result = await runTask(tasks[index]);
        report.results[index] = result;
        if (result.status === "infrastructure-failure") {
          infrastructureFailures += 1;
          if (infrastructureFailures >= options.concurrency) stopReason = "broad upstream infrastructure outage";
        }
      }
    });
    await Promise.all(workers);
    for (let index = 0; index < tasks.length; index += 1) {
      if (!report.results[index]) report.results[index] = resultFor(tasks[index], "untested", stopReason || "monitor stopped before this case");
    }
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(report.network, memoized.stats);
  }
  for (const result of report.results) {
    if (result.status === "passed") report.counts.passed += 1;
    else if (result.status === "calculation-failure") report.counts.calculationFailure += 1;
    else if (result.status === "infrastructure-failure") report.counts.infrastructureFailure += 1;
    else report.counts.untested += 1;
  }
  report.durationMs = Date.now() - started;
  report.ok = report.counts.calculationFailure === 0
    && report.counts.infrastructureFailure === 0
    && report.counts.untested === 0;
  return report;
}

async function main() {
  const options = parseMonitorArgs(process.argv.slice(2));
  const report = await runMonitor(options);
  const summary = markdownSummary(report);
  if (options.output) await writeFile(path.resolve(options.output), `${JSON.stringify(report)}\n`);
  if (options.summary) await writeFile(path.resolve(options.summary), summary);
  console.log(JSON.stringify({ status: report.status || (report.ok ? "passed" : "failed"), ok: report.ok, counts: report.counts, scope: report.scope, network: report.network, durationMs: report.durationMs }));
  console.log(summary);
  process.exitCode = report.ok === false ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`NSW postcode monitor failed before execution: ${String(error?.stack || error)}`);
    process.exitCode = 1;
  });
}
