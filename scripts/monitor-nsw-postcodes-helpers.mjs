import { readFile } from "node:fs/promises";
import vm from "node:vm";

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_TIMEOUT_MS = 12_000;
export const DEFAULT_BUDGET_MS = 20 * 60_000;
export const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
export const NSW_SPATIAL_POSTCODE_URL = "https://portal.spatial.nsw.gov.au/server/rest/services/NSW_Administrative_Boundaries_Theme/MapServer/2/query?where=postcode+IS+NOT+NULL&outFields=postcode&returnGeometry=false&returnDistinctValues=true&orderByFields=postcode&f=json";

export function parseMonitorArgs(argv) {
  const options = {
    postcodes: null,
    output: null,
    summary: null,
    concurrency: DEFAULT_CONCURRENCY,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    budgetMs: DEFAULT_BUDGET_MS,
    dryRun: false,
  };
  for (const arg of argv) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg.startsWith("--postcodes=")) options.postcodes = arg.slice(12).split(",").filter(Boolean);
    else if (arg.startsWith("--output=")) options.output = arg.slice(9);
    else if (arg.startsWith("--summary=")) options.summary = arg.slice(10);
    else if (arg.startsWith("--concurrency=")) options.concurrency = positiveInteger(arg, "--concurrency", 1, 4);
    else if (arg.startsWith("--timeout-ms=")) options.timeoutMs = positiveInteger(arg, "--timeout-ms", 1_000, 30_000);
    else if (arg.startsWith("--budget-ms=")) options.budgetMs = positiveInteger(arg, "--budget-ms", 30_000, DEFAULT_BUDGET_MS);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.postcodes && (!options.postcodes.length || options.postcodes.some((postcode) => !/^\d{4}$/.test(postcode)))) {
    throw new Error("--postcodes must be a comma-separated list of four-digit postcodes");
  }
  return options;
}

function positiveInteger(arg, name, min, max) {
  const value = Number(arg.slice(arg.indexOf("=") + 1));
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export async function loadPostcodeInventory(file) {
  const inventory = JSON.parse(await readFile(file, "utf8"));
  if (!inventory || typeof inventory !== "object" || !Array.isArray(inventory.postcodes)) {
    throw new Error("NSW postcode fixture is missing its postcode array");
  }
  if (typeof inventory.source !== "string" || !/^https:\/\//.test(inventory.sourceUrl || "")) {
    throw new Error("NSW postcode fixture is missing authoritative source provenance");
  }
  const rawPostcodes = [...inventory.postcodes, ...(inventory.crossBorderPostcodes || [])].map(String);
  const postcodes = [...new Set(rawPostcodes)].sort();
  if (postcodes.length !== rawPostcodes.length || !postcodes.length || postcodes.some((postcode) => !/^\d{4}$/.test(postcode))) {
    throw new Error("NSW postcode fixture has duplicate, missing, or invalid postcodes");
  }
  return { ...inventory, postcodes };
}

export async function fetchCurrentNswPostcodes({ fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(NSW_SPATIAL_POSTCODE_URL, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`NSW Spatial Services inventory returned HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.error || payload?.exceededTransferLimit === true || !Array.isArray(payload?.features)) {
      throw new Error("NSW Spatial Services inventory was malformed or truncated");
    }
    const postcodes = payload.features.map((feature) => String(feature?.attributes?.postcode ?? "").padStart(4, "0"));
    const unique = [...new Set(postcodes)].sort();
    if (!unique.length || unique.length !== postcodes.length || unique.some((postcode) => !/^\d{4}$/.test(postcode))) {
      throw new Error("NSW Spatial Services inventory has duplicate, missing, or invalid postcodes");
    }
    return unique;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("NSW Spatial Services inventory timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function expectedRequestBudget(postcodeCount) {
  return {
    climateLookups: postcodeCount,
    certificateCalculations: (postcodeCount * 2) + 2,
    normalNswServiceRequests: (postcodeCount * 3) + 2,
    metadataLookups: 2,
    estimateScope: "Normal-path lower bound; excludes postcode recovery calls, retries, and distinct browser/server payloads. See measured network counts.",
  };
}

function requestKey(input, init = {}) {
  const method = String(init.method || "GET").toUpperCase();
  const body = typeof init.body === "string" ? init.body : "";
  return `${method} ${String(input)}\n${body}`;
}

function isTransientError(error) {
  return error?.name === "AbortError" || /network|fetch failed|timed out|socket|ECONNRESET|EAI_AGAIN/i.test(String(error?.message || error));
}

function responseFromSaved(saved) {
  return new Response(saved.body, { status: saved.status, statusText: saved.statusText, headers: saved.headers });
}

export function createMemoizedFetch({ fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1 } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");
  const entries = new Map();
  const stats = { networkRequests: 0, cacheHits: 0, retries: 0 };

  async function fetchOnce(input, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      stats.networkRequests += 1;
      const { next: _next, signal: _signal, ...safeInit } = init || {};
      const response = await fetchImpl(input, { ...safeInit, signal: controller.signal });
      const body = await response.text();
      const saved = {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()],
        body,
      };
      return saved;
    } finally {
      clearTimeout(timer);
    }
  }

  async function network(input, init) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const saved = await fetchOnce(input, init);
        if (TRANSIENT_STATUS.has(saved.status) && attempt < retries) {
          stats.retries += 1;
          continue;
        }
        return saved;
      } catch (error) {
        lastError = error;
        if (attempt === retries || !isTransientError(error)) throw error;
        stats.retries += 1;
      }
    }
    throw lastError;
  }

  return {
    stats,
    fetch: async (input, init = {}) => {
      const key = requestKey(input, init);
      let entry = entries.get(key);
      if (entry) {
        stats.cacheHits += 1;
      } else {
        entry = network(input, init);
        entries.set(key, entry);
      }
      return responseFromSaved(await entry);
    },
  };
}

function extractFunction(source, name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const functionStart = source.indexOf(`function ${name}(`);
  const start = asyncStart === -1 ? functionStart : asyncStart;
  if (start === -1) throw new Error(`index.html no longer exposes ${name}`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`index.html has an incomplete ${name}`);
}

function extractConst(source, name) {
  const match = source.match(new RegExp(`const ${name}=([^;]+);`));
  if (!match) throw new Error(`index.html no longer exposes ${name}`);
  return `const ${name}=${match[1]};`;
}

const FRONTEND_FUNCTIONS = [
  "toNumber", "fetchJson", "normalizeEssClimateZone", "isEssClimateZoneFallbackPostcode",
  "fallbackEssClimateZoneFromPostcode", "electricFutureBcaClimateZoneOverride", "resolvePostcodeZones",
  "getClimateContext", "activityValueForInstall", "normalizeAirConditionerType", "normalizeHvacProductClass",
  "hvacProductClassNumber", "nswHvacRequirementForClass", "nswHvacMeasuredValue", "nswHvacPassesMetric",
  "deriveHvacProductClass", "evaluateNswHvacEligibility", "certificateProxyPostcodeForClimateZone",
  "certificatePayload", "fetchCertificateCalculation", "certificateBuilding", "certificateFieldNumber",
  "decimalEscCertificatesFromBuilding", "decimalPrcCertificatesFromBuilding", "calculateCertificatesWithPostcodeFallback",
  "nswCertificateCapsForAirType", "calculateCertificatesForModel",
];
const FRONTEND_CONSTS = [
  "ESS_CALCULATE_API", "ESS_CALC_DATE", "DEFAULT_FETCH_TIMEOUT_MS", "HVAC_AIR_CONDITIONER_TYPE_ALIASES", "HVAC_AIR_CONDITIONER_TYPE_VALUES",
  "HVAC_PRODUCT_CLASS_VALUES", "NSW_HVAC_ELIGIBLE_PRODUCT_CLASS_NUMBERS", "NSW_HVAC_EFFICIENCY_REQUIREMENTS",
  "CERTIFICATE_OUTPUT_FIELDS", "CERTIFICATE_ESC_PROXY_FIELDS", "CERTIFICATE_ACTUAL_POSTCODE_FIELDS",
];

export async function createFrontendCalculator({ indexHtml, fetch }) {
  const source = indexHtml || await readFile(new URL("../index.html", import.meta.url), "utf8");
  const context = vm.createContext({
    AbortController,
    Promise,
    Number,
    String,
    Object,
    Array,
    Set,
    RegExp,
    Error,
    JSON,
    Math,
    fetch,
    setTimeout,
    clearTimeout,
    systemType: "split",
    installType: "replacement",
    essCache: { zoneByPostcode: {} },
  });
  vm.runInContext([...FRONTEND_CONSTS.map((name) => extractConst(source, name)), ...FRONTEND_FUNCTIONS.map((name) => extractFunction(source, name))].join("\n"), context, { timeout: 1_000 });
  return {
    calculate: async ({ postcode, metadata, installType, airConditionerType, coolingCapacity, heatingCapacity, inputPower }) => {
      const climate = await context.getClimateContext(postcode);
      return await context.calculateCertificatesForModel(metadata, climate, {
        installType,
        airConditionerType,
        coolingCapacity,
        heatingCapacity,
        inputPower,
      });
    },
  };
}

export function isInfrastructureError(error) {
  return /HTTP (408|425|429|5\d\d)|timed out|fetch failed|network|service unavailable/i.test(String(error?.message || error));
}

export function validateComparableCertificates(server, frontend, expectedPositive) {
  const values = [server.esc, server.prc, frontend.esc, frontend.prc, server.rebate];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    return "non-finite or negative certificate/rebate result";
  }
  if (Math.abs(server.esc - frontend.esc) > 0.000001 || Math.abs(server.prc - frontend.prc) > 0.000001) {
    return `frontend/server certificate mismatch (server ${server.esc}/${server.prc}, frontend ${frontend.esc}/${frontend.prc})`;
  }
  if (expectedPositive && !(server.esc + server.prc > 0 && server.rebate > 0)) {
    return "known eligible fixture returned no rebate";
  }
  return null;
}

export function markdownSummary(report) {
  const counts = report.counts;
  const failed = report.results.filter((result) => result.status !== "passed").slice(0, 20);
  const lines = [
    "## NSW postcode rebate monitor",
    "",
    `- Status: **${report.status || (report.ok ? "passed" : "failed")}**`,
    `- Scope: ${report.scope.postcodeCount} postcodes; ${report.scope.cases} calculation cases`,
    `- Passed: ${counts.passed}; calculation failures: ${counts.calculationFailure}; infrastructure failures: ${counts.infrastructureFailure}; untested: ${counts.untested}`,
    `- Requests: ${report.network.networkRequests} network, ${report.network.cacheHits} memoized, ${report.network.retries} transient retries`,
    `- Duration: ${report.durationMs} ms`,
  ];
  if (failed.length) {
    lines.push("", "### First failures");
    for (const result of failed) lines.push(`- ${result.postcode} ${result.case}: ${result.status} - ${result.message}`);
  }
  return `${lines.join("\n")}\n`;
}
