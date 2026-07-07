import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexHtml = readFileSync(path.join(root, "index.html"), "utf8");
const rawRoute = readFileSync(path.join(root, "app/calculator/raw/route.ts"), "utf8");
const apiRoute = readFileSync(path.join(root, "app/api/calculator-data/route.ts"), "utf8");

function quoteStateDisablesRebates(row) {
  const state = row && row.state && typeof row.state === "object" ? row.state : {};
  if (state.rebatesEnabled === false) return true;
  const scheme = String(state.rebateScheme || "").toLowerCase();
  if (scheme === "none" || scheme === "veu") return true;
  const operatingState = String(state.businessOperatingState || "").toUpperCase();
  return Boolean(operatingState && operatingState !== "NSW");
}

function finiteMoneyNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function savedQuoteStoredRebate(row) {
  if (quoteStateDisablesRebates(row)) return 0;
  const state = row && row.state && typeof row.state === "object" ? row.state : {};
  const candidates = [
    row && row.rebate,
    row && row.rebateAmount,
    row && row.rebateInc,
    state.rebate,
    state.rebateAmount,
    state.rebateInc,
    state.savedRebate,
  ];
  const numbers = candidates.map(finiteMoneyNumber).filter((value) => value !== null);
  const positive = numbers.find((value) => Math.abs(value) > 0.0001);
  return positive === undefined ? (numbers[0] || 0) : positive;
}

function parseManagedPriceMap(value) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function normalizeManagedLookup(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function managedEntryHasTrustedRebate(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const rebate = Number(entry.rebate);
  return entry.rebateManual === true || (Number.isFinite(rebate) && Math.abs(rebate) > 0.0001);
}

function managedEntryModelKey(entry) {
  return entry && typeof entry === "object" && !Array.isArray(entry)
    ? normalizeManagedLookup(entry.model)
    : "";
}

function managedRebateSource(entryKey, entry, existingMaps) {
  for (const map of existingMaps) {
    const source = map[entryKey];
    if (managedEntryHasTrustedRebate(source)) return source;
  }
  const modelKey = managedEntryModelKey(entry);
  if (!modelKey) return null;
  for (const map of existingMaps) {
    for (const source of Object.values(map)) {
      if (managedEntryModelKey(source) === modelKey && managedEntryHasTrustedRebate(source)) return source;
    }
  }
  return null;
}

function preserveManagedRebateFields(existingValue, incomingValue, fallbackExistingValues = []) {
  const existingMaps = [
    parseManagedPriceMap(existingValue),
    ...fallbackExistingValues.map(parseManagedPriceMap),
  ];
  const incoming = parseManagedPriceMap(incomingValue);
  for (const [key, entry] of Object.entries(incoming)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const source = managedRebateSource(key, entry, existingMaps);
    if (!source) continue;
    if (!("rebate" in entry) && "rebate" in source) entry.rebate = source.rebate;
    if (!("rebateManual" in entry) && "rebateManual" in source) entry.rebateManual = source.rebateManual;
  }
  return JSON.stringify(incoming);
}

assert.equal(
  savedQuoteStoredRebate({
    rebate: "725.50",
    state: { businessOperatingState: "NSW", rebateScheme: "nsw_ess", rebatesEnabled: true },
  }),
  725.5,
  "NSW saved quote rebates must remain active.",
);

assert.equal(
  savedQuoteStoredRebate({
    rebate: "725.50",
    state: { businessOperatingState: "QLD", rebateScheme: "none", rebatesEnabled: false },
  }),
  0,
  "QLD saved quote rebates must remain disabled.",
);

const preserved = JSON.parse(
  preserveManagedRebateFields(
    JSON.stringify({ "split|0": { unitPriceInc: 1000, rebate: 321.25, rebateManual: true } }),
    JSON.stringify({ "split|0": { unitPriceInc: 950 } }),
  ),
);
assert.equal(preserved["split|0"].rebate, 321.25, "Business rebate value must survive non-owner sync.");
assert.equal(preserved["split|0"].rebateManual, true, "Manual rebate marker must survive non-owner sync.");

const crossKeyPreserved = JSON.parse(
  preserveManagedRebateFields(
    JSON.stringify({ "split|0": { unitPriceInc: 950, model: "ABC-25" } }),
    JSON.stringify({ "split|0": { unitPriceInc: 930, model: "ABC-25" } }),
    [JSON.stringify({ "split|0": { unitPriceInc: 960, model: "ABC-25", rebate: 444.4, rebateManual: true } })],
  ),
);
assert.equal(crossKeyPreserved["split|0"].rebate, 444.4, "Current managed prices must recover trusted legacy rebates.");
assert.equal(crossKeyPreserved["split|0"].rebateManual, true, "Current managed prices must recover legacy manual rebate flags.");

assert.match(rawRoute, /greenEnergyManagedPricesV1/, "Raw route must handle legacy managed price key.");
assert.match(rawRoute, /trustedBusinessManagedPriceData/, "Raw route must restore trusted business rebate data.");
assert.match(rawRoute, /trustedManagedPriceKeys\[key\]\) return/, "Browser bootstrap must not strip trusted business rebates.");
assert.match(apiRoute, /preserveManagedRebateFields/, "API route must preserve managed rebate fields.");
assert.match(apiRoute, /managedRebateSource/, "API route must recover rebates across managed price keys.");
assert.match(apiRoute, /greenEnergyManagedPricesV1/, "API route must protect legacy managed price key.");
assert.match(indexHtml, /if\(saved\.rebateManual===true\) entry\.rebateManual=true;/, "Trusted manual rebate flag must be honored read-only.");
assert.match(indexHtml, /if\(saved\.rebate!==undefined\)\{/, "Trusted saved rebate value must be applied read-only.");
assert.match(indexHtml, /const rebate=quoteStateDisablesRebates\(r\)\?0:storedRebate;/, "Saved quote rebate math must use the quote state.");
assert.match(indexHtml, /copyManagedRebateFields/, "Client startup must recover trusted legacy managed rebates.");

console.log("rebate guards ok");
