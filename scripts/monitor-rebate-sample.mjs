import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";
import vm from "node:vm";
import {
  createFrontendCalculator,
  createMemoizedFetch,
  isInfrastructureError,
} from "./monitor-nsw-postcodes-helpers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(root, "scripts", "fixtures", "rebate-reference-cases.json");
const cataloguePath = path.join(root, "lib", "public-rebate-catalogue.generated.json");
const execFileAsync = promisify(execFile);
const DEFAULTS = { concurrency: 3, timeoutMs: 12_000, budgetMs: 8 * 60_000 };
const MAX_CONCURRENCY = 4;

function compact(value) { return String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, ""); }
function roundMoney(value) { return Math.round((value + Number.EPSILON) * 100) / 100; }
function finite(value) { return Number.isFinite(value) && value >= 0; }
function weekSeed(date = new Date()) {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc - yearStart) / 86_400_000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function parseSampleArgs(argv) {
  const options = { output: null, summary: null, seed: null, ...DEFAULTS, dryRun: false };
  for (const arg of argv) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg.startsWith("--seed=")) options.seed = arg.slice(7).trim() || null;
    else if (arg.startsWith("--output=")) options.output = arg.slice(9);
    else if (arg.startsWith("--summary=")) options.summary = arg.slice(10);
    else if (arg.startsWith("--concurrency=")) options.concurrency = boundedInteger(arg, "--concurrency", 1, MAX_CONCURRENCY);
    else if (arg.startsWith("--timeout-ms=")) options.timeoutMs = boundedInteger(arg, "--timeout-ms", 1_000, 30_000);
    else if (arg.startsWith("--budget-ms=")) options.budgetMs = boundedInteger(arg, "--budget-ms", 30_000, DEFAULTS.budgetMs);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function boundedInteger(arg, name, min, max) {
  const value = Number(arg.slice(arg.indexOf("=") + 1));
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

function hash(seed, value) {
  let state = 2166136261;
  for (const character of `${seed}|${value}`) {
    state ^= character.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return state >>> 0;
}

function capacityBucket(product) {
  return product.capacityKw < 4 ? "small" : product.capacityKw < 8 ? "medium" : "large";
}

function fixedKey(product) { return `${compact(product.brand)}|${compact(product.model)}|${product.systemType}`; }

export function rotatingContractExpectation(product, postcode, installType, approvedPostcodes) {
  return product.dcceewEligible === true
    && approvedPostcodes.includes(Number(postcode))
    && !(product.systemType === "ducted" && installType === "new");
}

function verifiedMultiSplitFixture(fixture) {
  const multi = fixture.sample.verifiedMultiSplit;
  if (multi === null || multi === undefined) return [];
  const heads = Array.isArray(multi.indoorHeads) ? multi.indoorHeads : [];
  const validHeads = heads.length > 0 && heads.every((head) => head && typeof head.model === "string"
    && Number.isInteger(head.qty) && head.qty > 0 && head.ratedCoolingCapacity > 0 && head.ratedHeatingCapacity > 0);
  if (multi.verified !== true || multi.systemType !== "multi_split" || !multi.id || !multi.brand || !multi.model
    || !/^\d{4}$/.test(multi.postcode || "") || !validHeads || !multi.provenance?.source || !/^https:\/\//.test(multi.provenance?.url || "")) {
    throw new Error("verifiedMultiSplit must contain verified physical outdoor/indoor models, positive rated capacities, and an official HTTPS provenance URL");
  }
  return [{ ...multi, fixed: true, capacityKw: null }];
}

function balancedPick(candidates, count, seed, initialBrands = new Map(), initialCapacity = new Map()) {
  const brandCounts = new Map(initialBrands);
  const capacityCounts = new Map(initialCapacity);
  const selected = [];
  const available = [...candidates];
  while (selected.length < count && available.length) {
    available.sort((left, right) => {
      const leftScore = (brandCounts.get(left.brand) || 0) * 10 + (capacityCounts.get(capacityBucket(left)) || 0) * 100 + (hash(seed, left.id) / 0xffffffff);
      const rightScore = (brandCounts.get(right.brand) || 0) * 10 + (capacityCounts.get(capacityBucket(right)) || 0) * 100 + (hash(seed, right.id) / 0xffffffff);
      return leftScore - rightScore;
    });
    const product = available.shift();
    selected.push(product);
    brandCounts.set(product.brand, (brandCounts.get(product.brand) || 0) + 1);
    const bucket = capacityBucket(product);
    capacityCounts.set(bucket, (capacityCounts.get(bucket) || 0) + 1);
  }
  return selected;
}

export function buildWeeklySample(catalogue, fixture, seed) {
  const fixed = fixture.sample.fixedCombinations.map((item) => ({ ...item, capacityKw: null, fixed: true }));
  const fixedKeys = new Set(fixed.map(fixedKey));
  const products = catalogue.products.filter((product) => !fixedKeys.has(fixedKey(product)));
  const splitFixed = fixed.filter((item) => item.systemType === "split").length;
  const ductedFixed = fixed.filter((item) => item.systemType === "ducted").length;
  const target = fixture.sample.distinctCombinations;
  if (fixed.length >= target) throw new Error("Fixed combinations leave no rotating sample capacity");
  const totalSplit = Math.ceil(target / 2);
  const targets = { split: totalSplit - splitFixed, ducted: target - totalSplit - ductedFixed };
  if (targets.split < 0 || targets.ducted < 0) throw new Error("Fixed combinations exceed a balanced system-type quota");
  const brandCounts = new Map(fixed.map((item) => [item.brand, 1]));
  const capacityCounts = new Map();
  const rotating = [
    ...balancedPick(products.filter((product) => product.systemType === "split"), targets.split, `${seed}|split`, brandCounts, capacityCounts),
    ...balancedPick(products.filter((product) => product.systemType === "ducted"), targets.ducted, `${seed}|ducted`, brandCounts, capacityCounts),
  ];
  if (rotating.length !== target - fixed.length) throw new Error("Committed catalogue cannot satisfy the split/ducted sample quotas");
  const climateEntries = Object.entries(fixture.sample.postcodesByClimate);
  const postcodeOffset = hash(seed, "postcode-cycle") % climateEntries.length;
  const selected = [...fixed, ...rotating].map((product, index) => {
    if (product.fixed) return product;
    const [plannedClimate, postcode] = climateEntries[(index + postcodeOffset) % climateEntries.length];
    return {
      ...product,
      postcode,
      plannedClimate,
      expectedContract: {
        new: rotatingContractExpectation(product, postcode, "new", catalogue.dcceewPostcodes),
        replacement: rotatingContractExpectation(product, postcode, "replacement", catalogue.dcceewPostcodes),
      },
      provenance: "Committed public rebate catalogue and DCCEEW approved-postcode register.",
    };
  });
  const duplicates = new Set(selected.map((item) => `${fixedKey(item)}|${item.postcode}`));
  if (duplicates.size !== selected.length) throw new Error("Sample selection produced duplicate brand/model/postcode combinations");
  return selected;
}

export function makeSampleCases(sample) {
  return sample.flatMap((combination) => ["new", "replacement"].map((installType) => ({
    ...combination,
    installType,
    id: `${combination.id || `${combination.brand}-${combination.model}`}|${combination.postcode}|${installType}`,
    expectedContract: Boolean(combination.expectedContract?.[installType]),
  })));
}

export function makeVerifiedMultiSplitCases(fixture) {
  return makeSampleCases(verifiedMultiSplitFixture(fixture));
}

export function validateLiveResult({ server, frontend, expectedContract, rates, requirePositiveCertificates = false }) {
  const values = [server?.esc, server?.prc, server?.rebate, server?.escRate, server?.prcRate, frontend?.esc, frontend?.prc];
  if (values.some((value) => !finite(value))) return "non-finite or negative certificate/payout result";
  if (Math.abs(server.esc - frontend.esc) > 0.000001 || Math.abs(server.prc - frontend.prc) > 0.000001) {
    return `frontend/server certificate mismatch (server ${server.esc}/${server.prc}, frontend ${frontend.esc}/${frontend.prc})`;
  }
  if ((requirePositiveCertificates || frontend?.eligibility?.essEligible || frontend?.eligibility?.prcEligible) && !(frontend.esc + frontend.prc > 0)) {
    return "eligible GEMS metadata returned zero total certificates";
  }
  if (server.contractApplied !== expectedContract) return `DCCEEW contract mismatch (expected ${expectedContract}, got ${server.contractApplied})`;
  const expectedEscRate = expectedContract ? 30 : rates.esc;
  if (server.escRate !== expectedEscRate || server.prcRate !== rates.prc) return `controlled payout rate mismatch (expected ${expectedEscRate}/${rates.prc}, got ${server.escRate}/${server.prcRate})`;
  const expectedRebate = roundMoney((frontend.esc * expectedEscRate) + (frontend.prc * rates.prc));
  if (server.rebate !== expectedRebate) return `payout mismatch (expected ${expectedRebate}, got ${server.rebate})`;
  return null;
}

export function validateExactGemsItem(item, task) {
  if (!item || !item.completeEnergyData) return "current GEMS record is missing complete energy data";
  if (compact(item.brand) !== compact(task.brand) || compact(item.model) !== compact(task.model)) return "current GEMS record is not an exact brand/model match";
  return null;
}

export function documentedGemsCandidates(task) {
  const add = (values, source, entries) => values.forEach((value) => {
    const model = String(value || "").trim();
    if (compact(model).length >= 5 && !entries.some((entry) => compact(entry.model) === compact(model))) entries.push({ model, source });
  });
  const entries = [];
  add([task.model], "catalogue-model", entries);
  add(task.modelAliases || [], "catalogue-model-alias", entries);
  add(task.searchTerms || [], "catalogue-search-term", entries);
  return entries;
}

export function acceptsServerMetadataSource(task, source) {
  return /^GEMS registry \+ NSW formula$/.test(source)
    || (compact(task.brand) === "ACTRONAIR" && source === "Verified GEMS metadata + NSW formula");
}

function extractFrontendFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`index.html no longer exposes ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"' || character === "`") { quote = character; continue; }
    if (character === "{") depth += 1;
    if (character === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`index.html has an incomplete ${name}`);
}

export function createFrontendMultiSplitInputs(indexHtml) {
  const context = vm.createContext({
    Number,
    Error,
    toNumber(value) { const number = Number(value); return Number.isFinite(number) ? number : Number.NaN; },
  });
  vm.runInContext(`${extractFrontendFunction(indexHtml, "multiSplitCertificateInputs")}; this.multiSplitCertificateInputs = multiSplitCertificateInputs;`, context, { timeout: 1_000 });
  return (metadata, indoorHeads) => context.multiSplitCertificateInputs(metadata, indoorHeads.map((head) => ({ row: head, qty: head.qty })));
}

export function compareHistoricalReference(reference, actual) {
  const expected = reference.expectedRoundedCertificates;
  for (const field of ["esc", "prc"]) {
    const rounded = Number(Number(actual[field]).toFixed(expected.decimalPlaces));
    if (!Number.isFinite(rounded) || Math.abs(rounded - expected[field]) > expected.tolerance) {
      return `${reference.id} historical certificate difference for ${field}: expected ${expected[field].toFixed(expected.decimalPlaces)}, got ${Number(actual[field]).toFixed(expected.decimalPlaces)}`;
    }
  }
  return null;
}

export function historicalReferencesComplete(references) {
  return references.length > 0 && references.every((reference) => reference.status === "matched");
}

function resultFor(task, status, message, extra = {}) { return { id: task.id, status, message, ...extra }; }

export async function executeCases(tasks, runCase, { concurrency, deadline, onRetry = () => {} }) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (Date.now() < deadline) {
      const index = next;
      next += 1;
      if (index >= tasks.length) return;
      const task = tasks[index];
      try {
        results[index] = await runCase(task, 0);
      } catch (error) {
        if (isInfrastructureError(error) && Date.now() < deadline) {
          onRetry();
          try { results[index] = await runCase(task, 1); } catch (retryError) {
            results[index] = resultFor(task, isInfrastructureError(retryError) ? "infrastructure-failure" : "calculation-failure", String(retryError?.message || retryError));
          }
        } else {
          results[index] = resultFor(task, isInfrastructureError(error) ? "infrastructure-failure" : "calculation-failure", String(error?.message || error));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return Array.from({ length: tasks.length }, (_, index) =>
    results[index] || resultFor(tasks[index], "untested", "monitor budget expired before this case"));
}

let loaderRegistered = false;
async function loadProduction() {
  if (!loaderRegistered) { register("./monitor-nsw-postcodes-loader.mjs", import.meta.url); loaderRegistered = true; }
  const [rebate, gems] = await Promise.all([import("../lib/nsw-hvac-rebate.ts"), import("../lib/gems-model-search.ts")]);
  return { ...rebate, ...gems };
}

async function loadExactGemsMetadata(production, task) {
  for (const candidate of documentedGemsCandidates(task)) {
    const records = await production.fetchGemsDatastoreRecords({ query: candidate.model, limit: 250, revalidateSeconds: 3_600 });
    const item = records.filter(production.isEligibleAustralianGemsRecord).map(production.mapGemsModelSearchItem).filter(Boolean)
      .find((record) => record.completeEnergyData
        && compact(record.brand) === compact(task.brand)
        && compact(record.model) === compact(candidate.model));
    if (item) return { metadata: item.metadata, matchedModel: item.model, candidate };
  }
  throw new Error(`INCOMPLETE: current GEMS has no approved, available, complete record matching a documented catalogue model/alias for ${task.brand} ${task.model}`);
}

function classifyIncomplete(error) { return /^INCOMPLETE:/.test(String(error?.message || error)); }

function countStatuses(results) {
  const counts = { passed: 0, calculationFailure: 0, infrastructureFailure: 0, untested: 0 };
  for (const result of results) {
    if (result.status === "passed") counts.passed += 1;
    else if (result.status === "calculation-failure") counts.calculationFailure += 1;
    else if (result.status === "infrastructure-failure") counts.infrastructureFailure += 1;
    else counts.untested += 1;
  }
  return counts;
}

async function sourceCommit() {
  try { return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(); } catch { return "unavailable"; }
}

export function markdownSampleSummary(report) {
  const lines = [
    "## Weekly rebate sample monitor", "",
    `- Status: **${report.ok ? "passed" : "failed"}**`,
    `- Seed: \`${report.seed}\`; source commit: \`${report.sourceCommit}\``,
    `- Scope: ${report.scope.distinctCombinations} split/ducted combinations plus ${report.scope.multiSplitCombinations} multi-split combination (${report.scope.totalDistinctCombinations} total); ${report.scope.cases} new/replacement cases`,
    `- Passed: ${report.counts.passed}; calculation failures: ${report.counts.calculationFailure}; infrastructure failures: ${report.counts.infrastructureFailure}; untested/incomplete: ${report.counts.untested}`,
    `- Network: ${report.network.networkRequests} requests, ${report.network.cacheHits} cache hits, ${report.network.retries} bounded retries`,
    `- Duration: ${report.durationMs} ms`,
    `- Historical references: ${report.historicalReferences.map((item) => `${item.id}: ${item.status}`).join(", ") || "not run"}; untested: ${report.counts.historicalReferenceUntested || 0}`,
    "", "### Coverage limits",
    `- Multi-split: ${report.coverageLimits.multiSplit}`,
    `- Non-eligible zero: ${report.coverageLimits.nonEligibleZero}`,
  ];
  const failures = report.results.filter((result) => result.status !== "passed").slice(0, 20);
  if (failures.length) {
    lines.push("", "### First failures");
    failures.forEach((result) => lines.push(`- ${result.id}: ${result.status} - ${result.message}`));
  }
  return `${lines.join("\n")}\n`;
}

export async function runSampleMonitor(options = parseSampleArgs(process.argv.slice(2))) {
  const started = Date.now();
  const [fixture, catalogue, indexHtml, sourceCommitValue] = await Promise.all([
    readFile(fixturePath, "utf8").then(JSON.parse), readFile(cataloguePath, "utf8").then(JSON.parse), readFile(path.join(root, "index.html"), "utf8"), sourceCommit(),
  ]);
  const seed = options.seed || weekSeed();
  const combinations = buildWeeklySample(catalogue, fixture, seed);
  const rotatingCases = makeSampleCases(combinations);
  const multiSplitCases = makeVerifiedMultiSplitCases(fixture);
  const tasks = [...rotatingCases, ...multiSplitCases];
  const capacityBuckets = combinations.filter((item) => item.capacityKw !== null).reduce((counts, item) => {
    const bucket = capacityBucket(item);
    counts[bucket] += 1;
    return counts;
  }, { small: 0, medium: 0, large: 0 });
  const plannedClimateInputs = combinations.reduce((counts, item) => {
    if (item.plannedClimate) counts[item.plannedClimate] = (counts[item.plannedClimate] || 0) + 1;
    return counts;
  }, {});
  const report = {
    monitor: "weekly-rebate-sample", startedAt: new Date().toISOString(), seed, sourceCommit: sourceCommitValue,
    scope: { distinctCombinations: combinations.length, multiSplitCombinations: multiSplitCases.length ? 1 : 0, totalDistinctCombinations: combinations.length + (multiSplitCases.length ? 1 : 0), cases: tasks.length, brands: new Set([...combinations, ...multiSplitCases].map((item) => item.brand)).size, systemTypes: Object.fromEntries(["split", "ducted", "multi_split"].map((type) => [type, combinations.filter((item) => item.systemType === type).length + (type === "multi_split" && multiSplitCases.length ? 1 : 0)])), capacityBuckets, plannedClimateInputs },
    controlledPayoutRates: fixture.controlledPayoutRates, coverageLimits: { ...fixture.coverageLimits, multiSplit: multiSplitCases.length ? `One verified physical combination included: ${fixture.sample.verifiedMultiSplit.provenance.source} (${fixture.sample.verifiedMultiSplit.provenance.url}).` : fixture.coverageLimits.multiSplit },
    results: [], historicalReferences: [], counts: { passed: 0, calculationFailure: 0, infrastructureFailure: 0, untested: 0, historicalReferenceUntested: 0 },
    network: { networkRequests: 0, cacheHits: 0, retries: 0 }, durationMs: 0, ok: false,
  };
  if (options.dryRun) {
    report.results = tasks.map((task) => resultFor(task, "untested", "dry run does not call live public services"));
    report.counts = countStatuses(report.results); report.durationMs = Date.now() - started; return report;
  }
  const originalFetch = globalThis.fetch;
  const memoized = createMemoizedFetch({ fetchImpl: originalFetch, timeoutMs: options.timeoutMs, retries: 0 });
  globalThis.fetch = memoized.fetch;
  try {
    const [production, frontend] = await Promise.all([loadProduction(), createFrontendCalculator({ indexHtml, fetch: memoized.fetch })]);
    const frontendMultiSplitInputs = createFrontendMultiSplitInputs(indexHtml);
    const runCase = async (task) => {
      try {
        const gems = await loadExactGemsMetadata(production, task);
        const metadata = gems.metadata;
        const multiInputs = task.systemType === "multi_split" ? frontendMultiSplitInputs(metadata, task.indoorHeads) : {};
        const [server, frontendResult] = await Promise.all([
          production.calculateCurrentNswRebate({ brand: task.brand, model: task.model, postcode: task.postcode, installType: task.installType, systemType: task.systemType, escRate: fixture.controlledPayoutRates.esc, prcRate: fixture.controlledPayoutRates.prc, indoorHeads: task.indoorHeads }),
          frontend.calculate({ postcode: task.postcode, metadata, installType: task.installType, airConditionerType: task.systemType === "ducted" ? "ducted_single_split_system" : task.systemType === "multi_split" ? "non_ducted_multi_split_system" : "non_ducted_single_split_system", ...multiInputs }),
        ]);
        if (!acceptsServerMetadataSource(task, server.lookupSource)) throw new Error(`INCOMPLETE: server used ${server.lookupSource}, not current exact GEMS metadata`);
        const failure = validateLiveResult({ server, frontend: frontendResult, expectedContract: task.expectedContract, rates: fixture.controlledPayoutRates, requirePositiveCertificates: task.requirePositiveCertificates === true });
        const expectedEscRate = task.expectedContract ? 30 : fixture.controlledPayoutRates.esc;
        const expectedRebate = roundMoney((frontendResult.esc * expectedEscRate) + (frontendResult.prc * fixture.controlledPayoutRates.prc));
        return resultFor(task, failure ? "calculation-failure" : "passed", failure || "", { brand: task.brand, model: task.model, postcode: task.postcode, installType: task.installType, expected: { contractApplied: task.expectedContract, escRate: expectedEscRate, prcRate: fixture.controlledPayoutRates.prc, rebate: expectedRebate }, actual: { esc: server.esc, prc: server.prc, rebate: server.rebate, escRate: server.escRate, prcRate: server.prcRate, contractApplied: server.contractApplied, frontend: { esc: frontendResult.esc, prc: frontendResult.prc } }, gemsProvenance: { source: "current approved, available GEMS", catalogueModel: task.model, matchedGemsModel: gems.matchedModel, catalogueMatch: gems.candidate.source, serverMetadataSource: server.lookupSource } });
      } catch (error) {
        if (classifyIncomplete(error)) return resultFor(task, "untested", String(error.message), { brand: task.brand, model: task.model, postcode: task.postcode, installType: task.installType });
        throw error;
      }
    };
    report.results = await executeCases(tasks, runCase, { concurrency: options.concurrency, deadline: started + options.budgetMs, onRetry: () => { report.network.retries += 1; } });
    for (const reference of fixture.historicalElectricFutureEvidence) {
      const result = report.results.find((item) => item.brand === reference.brand && item.model === reference.model && item.postcode === reference.postcode && item.installType === reference.installType);
      if (!result?.actual) { report.historicalReferences.push({ id: reference.id, status: "not-tested", provenance: reference.provenance }); continue; }
      const difference = compareHistoricalReference(reference, result.actual);
      report.historicalReferences.push({ id: reference.id, status: difference ? "different" : "matched", difference: difference || undefined, expected: reference.expectedRoundedCertificates, actual: { esc: result.actual.esc, prc: result.actual.prc }, provenance: reference.provenance });
      if (difference && result.status === "passed") { result.status = "calculation-failure"; result.message = difference; }
    }
  } finally {
    globalThis.fetch = originalFetch;
    report.network.networkRequests = memoized.stats.networkRequests;
    report.network.cacheHits = memoized.stats.cacheHits;
    report.network.retries += memoized.stats.retries;
  }
  report.counts = countStatuses(report.results);
  report.counts.historicalReferenceUntested = report.historicalReferences.filter((reference) => reference.status === "not-tested").length;
  report.durationMs = Date.now() - started;
  report.ok = report.counts.calculationFailure === 0 && report.counts.infrastructureFailure === 0 && report.counts.untested === 0;
  report.ok = report.ok && historicalReferencesComplete(report.historicalReferences);
  return report;
}

async function main() {
  const options = parseSampleArgs(process.argv.slice(2));
  const report = await runSampleMonitor(options);
  const summary = markdownSampleSummary(report);
  if (options.output) await writeFile(path.resolve(options.output), `${JSON.stringify(report, null, 2)}\n`);
  if (options.summary) await writeFile(path.resolve(options.summary), summary);
  console.log(JSON.stringify({ ok: report.ok, seed: report.seed, counts: report.counts, scope: report.scope, network: report.network, durationMs: report.durationMs }));
  console.log(summary);
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Weekly rebate sample monitor failed before execution: ${String(error?.stack || error)}`); process.exitCode = 1; });
}
