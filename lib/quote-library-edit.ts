import { createHash, randomUUID } from "node:crypto";
// @ts-ignore Explicit TS extension is required by the direct Node regression runners.
import { applyStoredQuoteAdminUnlocks, copyQuoteWithoutLifecycle, quoteFamilyLocked, QUOTE_FAMILY_FIELDS, QUOTE_ROW_FIELDS } from "./quote-family.ts";

type Row = Record<string, unknown>;

const ROW_KEYS = ["installerMasterQuoteLogV1", "greenEnergyMasterQuoteLogV1", "MasterQuoteLogV1"];
const OPTION_KEYS = ["installerQuoteOptionDefsV1", "greenEnergyQuoteOptionDefsV1", "QuoteOptionDefsV1"];
const BACKUP_KEYS = ["installerSavedQuoteSetsV1", "greenEnergySavedQuoteSetsV1", "SavedQuoteSetsV1"];
const COPY_RECEIPTS_KEY = "installerQuoteLibraryCopyReceiptsV1";
const PRICE_FIELDS = ["unitInc", "finalInc", "labour", "materialsInc", "miscInc", "powerCost", "labourTreatment"];

export type QuoteLibraryEditResult =
  | { data: Row; row: Row }
  | { error: string; status: 409 | 422 };

export type QuoteLibraryCopyResult =
  | { data: Row; def: Row; rows: Row[] }
  | { error: string; status: 409 | 422 };

function object(value: unknown): value is Row {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function records(value: unknown): Row[] {
  const parsed = parse(value);
  return Array.isArray(parsed) ? parsed.filter(object) : [];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

export function quoteLibraryVisibleRow(value: Row, financialsVisible: boolean): Row {
  if (financialsVisible) return value;
  function strip(item: unknown, root = false): unknown {
    if (Array.isArray(item)) return item.map((entry) => strip(entry));
    if (typeof item === "string") {
      const parsed = parse(item);
      if (object(parsed) || Array.isArray(parsed)) return JSON.stringify(strip(parsed));
    }
    if (!object(item)) return item;
    return Object.fromEntries(Object.entries(item).filter(([key]) => {
      const lower = key.toLowerCase();
      if (root && lower === "salespersoncommissioninc" && item.wonAt) return true;
      return !lower.includes("commission") && !lower.includes("profit") && !lower.includes("margin");
    }).map(([key, entry]) => [key, strip(entry)]));
  }
  return strip(value, true) as Row;
}

export function quoteLibraryResponseRow(value: Row, financialsVisible: boolean, canSeeSalespersonCommission: boolean): Row {
  if (financialsVisible) return value;
  const response = { ...quoteLibraryVisibleRow(value, false) };
  for (const key of ["salespersonCommissionInc", "netProfit"]) {
    delete response[key];
    if (canSeeSalespersonCommission) {
      const amount = number(value[key]);
      if (amount !== null) response[key] = amount;
    }
  }
  return response;
}

function conflict(): { error: string; status: 409 } {
  return { error: "This quote changed, was removed, or is locked. Reopen it before editing.", status: 409 };
}

function invalid(message: string): { error: string; status: 422 } {
  return { error: message, status: 422 };
}

function number(value: unknown): number | null {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function timestamp(value: unknown): number {
  return number(value) ?? (Date.parse(String(value || "")) || 0);
}

function isMultiHeadRow(row: Row) {
  const state = object(row.state) ? row.state : {};
  return [row.type, state.systemType].some((value) => /^multi[-_ ]?(head|split)/i.test(String(value || "")));
}

function pricingStateAliases(current: Row, prices: Row): Row | null {
  const prior = object(current.state) ? current.state : {};
  const multi = isMultiHeadRow(current);
  const ducted = !multi && String(prior.systemType || current.type || "").toLowerCase() === "ducted";
  const addonLabour = multi ? 0 : number(current.addonLabour) ?? 0;
  const addonMaterials = multi ? 0 : number(current.addonMaterialsInc) ?? 0;
  if ((!multi && "addonLabour" in current && number(current.addonLabour) === null) ||
      (!multi && "addonMaterialsInc" in current && number(current.addonMaterialsInc) === null) ||
      addonLabour < 0 || addonMaterials < 0) return null;
  const baseLabour = Number(prices.labour) - addonLabour;
  const baseMaterials = Number(prices.materialsInc) - addonMaterials;
  if (baseLabour < 0 || baseMaterials < 0) return null;
  const mirrors: Row = {
    unitPriceInc: prices.unitInc, finalInc: prices.finalInc, labour: baseLabour,
    materials: baseMaterials, misc: prices.miscInc,
    [multi ? "multiPower" : ducted ? "electrician" : "powerCircuit"]: prices.powerCost,
    installerRetainsLabour: prices.labourTreatment === "Retained",
  };
  if (multi) mirrors.powerCircuit = prices.powerCost;
  if (!multi) mirrors[ducted ? "ductedInstallerRetainsLabour" : "splitInstallerRetainsLabour"] = prices.labourTreatment === "Retained";
  if (!multi && !ducted) mirrors.powerMode = Number(prices.powerCost) > 0 ? "on" : "off";
  return mirrors;
}

function recompute(row: Row): Row | null {
  const state = object(row.state) ? row.state : {};
  const type = String(state.commissionType || row.commissionType || "").toLowerCase();
  if (!["none", "standard", "agency"].includes(type)) return null;
  const enabled = type !== "none" && state.commissionModelOn !== false;
  const rate = number(state.agencyCommissionRate ?? state.commissionRate ?? row.agencyCommissionRate ?? row.commissionRate);
  const salesRate = number(state.salespersonCommissionRate ?? row.salespersonCommissionRate);
  if (enabled && (rate === null || (type === "agency" && salesRate === null))) return null;
  if ((rate !== null && (rate < 0 || rate > 100)) || (salesRate !== null && (salesRate < 0 || salesRate > 100))) return null;
  const unit = number(row.unitInc);
  const final = number(row.finalInc);
  const labour = number(row.labour);
  const materials = number(row.materialsInc);
  const misc = number(row.miscInc);
  const power = number(row.powerCost);
  const rebate = number(row.rebate);
  if ([unit, final, labour, materials, misc, power, rebate].some((value) => value === null)) return null;
  const multi = isMultiHeadRow(row);
  const split = row.type === "Split" || multi;
  const addons = !split && state.airtouch === "yes"
    ? 1100 + (number(state.sensors) ?? 0) * 82 + (number(state.zones) ?? 0) * 65 : 0;
  const matsEx = materials! / 1.1;
  const otherEx = misc! / 1.1 + power! + addons;
  const trueCost = unit! / 1.1 + labour! + matsEx + otherEx;
  const sellEx = final! / 1.1;
  const disabledRebates = state.rebatesEnabled === false || ["none", "veu"].includes(String(state.rebateScheme || "").toLowerCase()) ||
    (!!state.businessOperatingState && String(state.businessOperatingState).toUpperCase() !== "NSW");
  const retained = (row.labourTreatment || (split ? "Retained" : "Expense")) === "Retained";
  const cashProfit = sellEx - trueCost + (disabledRebates ? 0 : rebate!) + (retained ? labour! : 0);
  const agency = enabled && type === "agency" ? cashProfit * rate! / 100 : 0;
  const sales = !enabled ? 0 : type === "agency" ? agency * salesRate! / 100 : cashProfit * rate! / 100;
  const gstRegistered = typeof row.salespersonGstRegistered === "boolean" ? row.salespersonGstRegistered
    : typeof state.salespersonGstRegistered === "boolean" ? state.salespersonGstRegistered
      : !(Number(row.salespersonCommission) > 0 && number(row.salespersonCommissionGst) === 0);
  const salesGst = gstRegistered ? sales * 0.1 : 0;
  const netProfit = cashProfit - (type === "standard" ? sales : agency);
  const derived = {
    matsEx, otherEx, trueCost, cashProfit, agencyCommission: agency, agencyCommissionGst: agency * 0.1,
    agencyCommissionInc: agency * 1.1, salespersonCommission: sales, salespersonCommissionGst: salesGst,
    salespersonCommissionInc: sales + salesGst, commission: agency, commissionGst: agency * 0.1,
    commissionInc: agency * 1.1, netProfit, netMargin: sellEx ? netProfit / sellEx : 0,
  };
  if (Object.values(derived).some((value) => !Number.isFinite(value))) return null;
  return { ...row, ...derived };
}

export function applyQuoteLibraryEdit(
  storedData: unknown,
  request: unknown,
  financialsVisible: boolean,
  now = Date.now(),
): QuoteLibraryEditResult {
  if (!object(request) || typeof request.rowId !== "string" || !request.rowId ||
      typeof request.optionId !== "string" || !request.optionId ||
      !object(request.expectedRow) || !object(request.row)) return invalid("A complete original row and candidate row are required.");
  if (Object.keys(request).some((key) => !["rowId", "optionId", "expectedRow", "row", "saveId"].includes(key))) return invalid("Unknown quote edit field.");
  const data = applyStoredQuoteAdminUnlocks(storedData);
  const matches = ROW_KEYS.flatMap((key) => records(data[key]).filter((row) => row.id === request.rowId).map((row) => ({ key, row })));
  if (!matches.length) return conflict();
  const current = matches[0].row;
  if (current.state !== undefined && !object(current.state)) return invalid("This quote has invalid saved state.");
  if (matches.some(({ row }) => canonical(row) !== canonical(current)) || current.optionId !== request.optionId) return conflict();
  const defs = OPTION_KEYS.flatMap((key) => records(data[key])).filter((def) => def.id === request.optionId);
  if (!defs.length || quoteFamilyLocked(data, request.optionId)) return conflict();
  const tombstones = parse(data.installerQuoteSyncTombstonesV1);
  if (object(tombstones) && ["rows", "options"].some((kind) => {
    const ledger = tombstones[kind];
    return object(ledger) && !!ledger[kind === "rows" ? request.rowId as string : request.optionId as string];
  })) return conflict();
  const expected = request.expectedRow;
  const candidate = request.row;
  const saveId = request.saveId;
  if (saveId !== undefined && (typeof saveId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(saveId))) return invalid("Invalid quote edit saveId.");
  const fingerprint = createHash("sha256").update(canonical({ rowId: request.rowId, optionId: request.optionId, expectedRow: expected, row: candidate })).digest("hex");
  if (saveId && current.quoteLibraryEditSaveId === saveId) {
    return current.quoteLibraryEditFingerprint === fingerprint ? { data, row: current } : conflict();
  }
  if (canonical(quoteLibraryVisibleRow(current, financialsVisible)) !== canonical(quoteLibraryVisibleRow(expected, financialsVisible))) return conflict();
  if (candidate.id !== current.id || candidate.optionId !== current.optionId) return invalid("Quote identity cannot be changed.");
  const writable = new Set(PRICE_FIELDS);
  for (const key of new Set([...Object.keys(expected), ...Object.keys(candidate)])) {
    if (canonical(candidate[key]) !== canonical(expected[key]) && !writable.has(key)) {
      return invalid(`Quote field cannot be changed: ${key}`);
    }
  }
  const patched = { ...current };
  for (const key of PRICE_FIELDS) {
    if (!(key in candidate)) continue;
    if (key === "labourTreatment") {
      if (typeof candidate[key] !== "string" || !["Retained", "Expense"].includes(candidate[key] as string)) return invalid("Invalid labour treatment.");
    } else if (typeof candidate[key] !== "number" || !Number.isFinite(candidate[key]) || Number(candidate[key]) < 0) {
      return invalid(`A finite non-negative amount is required: ${key}`);
    }
    patched[key] = candidate[key];
  }
  if (isMultiHeadRow(current) &&
      number(patched.unitInc) !== number(current.unitInc)) {
    return invalid("Multi-head equipment-price edits cannot round-trip through Calculator Load yet. Other saved pricing fields can still be edited.");
  }
  if (!["Retained", "Expense"].includes(String(patched.labourTreatment))) return invalid("A saved labour treatment is required.");
  const aliases = pricingStateAliases(current, patched);
  if (!aliases) return invalid("Base labour and materials must cover the stored add-ons.");
  patched.state = { ...(object(current.state) ? current.state : {}) };
  for (const [key, value] of Object.entries(aliases)) {
    (patched.state as Row)[key] = typeof value === "number" ? String(value) : value;
  }
  patched.installerRetainsLabour = patched.labourTreatment === "Retained";
  // Derivations use stored rates and the exact stored rebate, never client-supplied totals.
  const row = recompute(patched);
  if (!row) return invalid("This legacy row lacks valid stored pricing or commission context and cannot be edited safely.");
  const version = Math.max(now, timestamp(current.syncUpdatedAt) + 1, timestamp(current.timestamp) + 1);
  if (!Number.isSafeInteger(version)) return invalid("The stored quote version is invalid.");
  row.syncUpdatedAt = version;
  delete row.quoteLibraryEditSaveId;
  delete row.quoteLibraryEditFingerprint;
  if (saveId) {
    row.quoteLibraryEditSaveId = saveId;
    row.quoteLibraryEditFingerprint = fingerprint;
  }
  const next = { ...data };
  for (const { key } of matches) {
    const rows = parse(data[key]) as unknown[];
    const updated = rows.map((entry) => object(entry) && entry.id === current.id ? row : entry);
    next[key] = typeof data[key] === "string" ? JSON.stringify(updated) : updated;
  }
  return { data: next, row };
}

function copyCollection(data: Row, key: string): Row[] | null {
  if (!(key in data)) return [];
  const value = parse(data[key]);
  return Array.isArray(value) && value.every(object) ? value : null;
}

function copyWithoutLifecycle(record: Row): Row {
  const detachedCustomerKeys = new Set([
    "installationAddress", "installationLatitude", "installationLongitude", "proposedInstallationDate",
    "googlePlaceId", "googleAddressComponents", "googleAddressSelectedAt",
  ]);
  const copy = copyQuoteWithoutLifecycle(JSON.parse(JSON.stringify(record)) as Row);
  for (const target of [copy, ...(object(copy.state) ? [copy.state] : [])]) {
    for (const key of detachedCustomerKeys) delete target[key];
    for (const key of [...QUOTE_FAMILY_FIELDS, ...QUOTE_ROW_FIELDS]) delete target[key];
  }
  return copy;
}

export function applyQuoteLibraryCopy(storedData: unknown, request: unknown, now = Date.now()): QuoteLibraryCopyResult {
  if (!object(request) || typeof request.optionId !== "string" || !request.optionId ||
      typeof request.name !== "string" || !request.name.trim() || request.name.trim().length > 200 ||
      typeof request.saveId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(request.saveId) ||
      (request.backupId !== undefined && (typeof request.backupId !== "string" || !request.backupId)) ||
      Object.keys(request).some((key) => !["optionId", "backupId", "name", "saveId"].includes(key))) return invalid("A source quote, name and unique saveId are required.");
  if (!object(storedData)) return conflict();
  const data = applyStoredQuoteAdminUnlocks(storedData);
  const receipts = copyCollection(data, COPY_RECEIPTS_KEY);
  if (!receipts) return invalid("Saved copy receipts are malformed; no quote was copied.");
  const fingerprint = createHash("sha256").update(canonical({ optionId: request.optionId, backupId: request.backupId, name: request.name.trim() })).digest("hex");
  const receipt = receipts.find((entry) => entry.id === request.saveId);
  const targetRowsKey = ROW_KEYS.find((key) => key in data) || ROW_KEYS[0];
  const targetDefsKey = OPTION_KEYS.find((key) => key in data) || OPTION_KEYS[0];
  const targetRows = copyCollection(data, targetRowsKey);
  const targetDefs = copyCollection(data, targetDefsKey);
  if (!targetRows || !targetDefs) return invalid("Saved working quotes are malformed; no quote was copied.");
  if (receipt) {
    if (receipt.fingerprint !== fingerprint || !Array.isArray(receipt.rowIds)) return conflict();
    const def = targetDefs.find((entry) => entry.id === receipt.optionId);
    const rows = receipt.rowIds.map((id) => targetRows.find((entry) => entry.id === id));
    if (!def || rows.some((row) => !row || row.optionId !== def.id)) return conflict();
    return { data, def, rows: rows as Row[] };
  }
  let sourceRows: Row[] = [];
  let sourceDefs: Row[] = [];
  if (request.backupId !== undefined) {
    const backups: Row[] = [];
    for (const key of BACKUP_KEYS) {
      const collection = copyCollection(data, key);
      if (!collection) return invalid("Saved backups are malformed; no quote was copied.");
      backups.push(...collection.filter((entry) => entry.id === request.backupId));
    }
    if (!backups.length || backups.some((backup) => canonical(backup) !== canonical(backups[0]))) return conflict();
    const backup = backups[0];
    if (!Array.isArray(backup.quotes) || !backup.quotes.every(object) ||
        !Array.isArray(backup.optionDefs) || !backup.optionDefs.every(object)) return invalid("The selected backup is incomplete; no quote was copied.");
    sourceRows = backup.quotes;
    sourceDefs = backup.optionDefs;
  } else {
    for (const key of ROW_KEYS) {
      const collection = copyCollection(data, key);
      if (!collection) return invalid("Saved quote rows are malformed; no quote was copied.");
      sourceRows.push(...collection);
    }
    for (const key of OPTION_KEYS) {
      const collection = copyCollection(data, key);
      if (!collection) return invalid("Saved quote definitions are malformed; no quote was copied.");
      sourceDefs.push(...collection);
    }
  }
  const defs = sourceDefs.filter((def) => def.id === request.optionId);
  const selectedRows = sourceRows.filter((row) => row.optionId === request.optionId);
  if (!defs.length || !selectedRows.length || defs.some((def) => canonical(def) !== canonical(defs[0]))) return conflict();
  if (request.backupId === undefined) {
    const tombstones = parse(data.installerQuoteSyncTombstonesV1);
    if (object(tombstones)) {
      if (object(tombstones.options) && tombstones.options[request.optionId] && !defs[0].wonAt) return conflict();
      if (object(tombstones.rows) && selectedRows.some((row) => (tombstones.rows as Row)[String(row.id)] && !row.wonAt && !defs[0].wonAt)) return conflict();
    }
  }
  const uniqueRows = new Map<string, Row>();
  for (const row of selectedRows) {
    if (typeof row.id !== "string" || !row.id) return invalid("The selected quote has a system without an ID.");
    const existing = uniqueRows.get(row.id);
    if (existing && canonical(existing) !== canonical(row)) return conflict();
    uniqueRows.set(row.id, row);
  }
  const optionId = `option_${randomUUID()}`;
  const name = request.name.trim();
  const def: Row = { ...(copyWithoutLifecycle(defs[0]) as Row), id: optionId, name, syncUpdatedAt: now };
  const orderedSources = [...uniqueRows.values()].map((source, index) => ({ source, index })).sort((a, b) => {
    const position = (row: Row) => typeof row.quotePosition === "number" && Number.isFinite(row.quotePosition) ? row.quotePosition : Number.POSITIVE_INFINITY;
    return position(a.source) - position(b.source) || a.index - b.index;
  });
  const rows = orderedSources.map(({ source }, index) => ({
    ...(copyWithoutLifecycle(source) as Row), id: `quote_${randomUUID()}`, optionId, optionName: name,
    timestamp: now + index, syncUpdatedAt: now + index,
  }));
  const next = { ...data };
  const serialize = (original: unknown, values: Row[]) => typeof original === "string" || original === undefined ? JSON.stringify(values) : values;
  for (const [keys, fallback, additions] of [[OPTION_KEYS, targetDefsKey, [def]], [ROW_KEYS, targetRowsKey, rows]] as const) {
    const activeKeys = keys.filter((key) => key in data);
    for (const key of activeKeys.length ? activeKeys : [fallback]) {
      const entries = copyCollection(data, key);
      if (!entries) return invalid("Saved quote aliases are malformed; no quote was copied.");
      next[key] = serialize(data[key], [...entries, ...additions]);
    }
  }
  next[COPY_RECEIPTS_KEY] = serialize(data[COPY_RECEIPTS_KEY], [...receipts, { id: request.saveId, fingerprint, optionId, rowIds: rows.map((row) => row.id) }]);
  return { data: next, def, rows };
}
