export const QUOTE_SYNC_TOMBSTONES_STORAGE_KEY = "installerQuoteSyncTombstonesV1";

const QUOTE_COLLECTION_STORAGE_KEYS = new Set([
  "installerMasterQuoteLogV1",
  "greenEnergyMasterQuoteLogV1",
  "MasterQuoteLogV1",
]);

const OPTION_COLLECTION_STORAGE_KEYS = new Set([
  "installerQuoteOptionDefsV1",
  "greenEnergyQuoteOptionDefsV1",
  "QuoteOptionDefsV1",
]);

const MANAGED_PRICE_STORAGE_KEYS = new Set([
  "installerManagedPricesV1",
  "greenEnergyManagedPricesV1",
  "ManagedPricesV1",
]);

const SHARED_SPLIT_PRICE_CORRECTIONS: Record<string, [number, number]> = {
  DXC28ZRAWDXK28ZRAWF1: [0, 2200],
  DXC33ZRAWDXK33ZRAWF1: [0, 2750],
  WRC080DSWRE080DS: [1725.64, 1705],
  WRC090DSWRE090DS: [2003.14, 2255],
};

type SyncRecord = Record<string, unknown>;
type TombstoneMap = Record<string, number>;
type TombstoneLedger = { rows: TombstoneMap; options: TombstoneMap };

function parseStoredJson(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function correctStaleManagedPrices(value: unknown) {
  const parsed = parseStoredJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return value;
  const prices = { ...(parsed as Record<string, unknown>) };
  let changed = false;
  for (const [key, entry] of Object.entries(prices)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const model = String(item.model || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const correction = SHARED_SPLIT_PRICE_CORRECTIONS[model];
    if (!correction || !["number", "string"].includes(typeof item.unitPriceInc)) continue;
    const current = Number(item.unitPriceInc);
    if (!Number.isFinite(current) || Math.abs(current - correction[0]) > 0.01) continue;
    // Old open calculators must not restore a superseded shared catalogue price.
    prices[key] = { ...item, unitPriceInc: correction[1] };
    changed = true;
  }
  return changed ? (typeof value === "string" ? JSON.stringify(prices) : prices) : value;
}

function parseStoredArray(value: unknown): SyncRecord[] | null {
  const parsed = parseStoredJson(value);
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is SyncRecord => !!entry && typeof entry === "object")
    : null;
}

function normalizedTimestamp(value: unknown) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function recordVersion(record: SyncRecord, kind: "rows" | "options") {
  return (
    normalizedTimestamp(record.syncUpdatedAt) ||
    (kind === "rows" ? normalizedTimestamp(record.timestamp) : 0) ||
    normalizedTimestamp(record.wonAt)
  );
}

function parseTombstoneMap(value: unknown): TombstoneMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: TombstoneMap = {};
  for (const [id, timestamp] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizedTimestamp(timestamp);
    if (id && normalized) output[id] = normalized;
  }
  return output;
}

function parseTombstones(value: unknown): TombstoneLedger {
  const parsed = parseStoredJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { rows: {}, options: {} };
  }
  const ledger = parsed as Record<string, unknown>;
  return {
    rows: parseTombstoneMap(ledger.rows),
    options: parseTombstoneMap(ledger.options),
  };
}

function mergeTombstoneMaps(existing: TombstoneMap, incoming: TombstoneMap) {
  const merged = { ...existing };
  for (const [id, timestamp] of Object.entries(incoming)) {
    merged[id] = Math.max(merged[id] || 0, timestamp);
  }
  return merged;
}

function mergeTombstones(existing: unknown, incoming: unknown): TombstoneLedger {
  const current = parseTombstones(existing);
  const next = parseTombstones(incoming);
  return {
    rows: mergeTombstoneMaps(current.rows, next.rows),
    options: mergeTombstoneMaps(current.options, next.options),
  };
}

function serializeLikeStorage(value: SyncRecord[], existing: unknown, incoming: unknown) {
  return typeof incoming === "string" || typeof existing === "string"
    ? JSON.stringify(value)
    : value;
}

function preserveWonCommission(existing: SyncRecord | undefined, next: SyncRecord) {
  if (!existing?.wonAt || existing.wonAt !== next.wonAt) return next;
  // Financial changes to locked jobs use the explicit admin actions, not autosave.
  const output = { ...next };
  const fields = [
    "commissionType", "commissionModelOn", "commissionRate", "agencyCommissionRate",
    "agencyCommission", "agencyCommissionGst", "agencyCommissionInc",
    "salespersonCommissionRate", "salespersonGstRegistered", "salespersonCommission",
    "salespersonCommissionGst", "salespersonCommissionInc", "agencyProfitAfterSalesInc",
    "commission", "commissionGst", "commissionInc",
  ];
  for (const key of fields) {
    if (key in existing) output[key] = existing[key];
  }
  if (existing.state && typeof existing.state === "object" && !Array.isArray(existing.state)) {
    const state = { ...(next.state && typeof next.state === "object" && !Array.isArray(next.state) ? next.state as SyncRecord : {}) };
    const priorState = existing.state as SyncRecord;
    for (const key of fields) {
      if (key in priorState) state[key] = priorState[key];
    }
    output.state = state;
  }
  return output;
}

function mergeRecordCollection(
  existingValue: unknown,
  incomingValue: unknown,
  kind: "rows" | "options",
  tombstones: TombstoneLedger,
) {
  const incoming = parseStoredArray(incomingValue);
  if (!incoming) return undefined;
  const existing = parseStoredArray(existingValue) || [];
  const existingById = new Map(
    existing
      .map((record) => [String(record.id || ""), record] as const)
      .filter(([id]) => id),
  );
  const merged: SyncRecord[] = [];
  const seen = new Set<string>();

  for (const incomingRecord of incoming) {
    const id = String(incomingRecord.id || "");
    if (!id) {
      merged.push(incomingRecord);
      continue;
    }
    const existingRecord = existingById.get(id);
    const winner =
      existingRecord && recordVersion(existingRecord, kind) >= recordVersion(incomingRecord, kind)
        ? existingRecord
        : incomingRecord;
    merged.push(kind === "rows" ? preserveWonCommission(existingRecord, winner) : winner);
    seen.add(id);
  }

  for (const existingRecord of existing) {
    const id = String(existingRecord.id || "");
    if (id && !seen.has(id)) merged.push(existingRecord);
  }

  const deletions = kind === "rows" ? tombstones.rows : tombstones.options;
  const filtered = merged.filter((record) => {
    const id = String(record.id || "");
    return !id || !deletions[id] || recordVersion(record, kind) > deletions[id];
  });

  return serializeLikeStorage(filtered, existingValue, incomingValue);
}

function storedValueHasData(value: unknown) {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.length > 0;
    if (parsed && typeof parsed === "object") return Object.keys(parsed).length > 0;
    return parsed !== null && parsed !== "";
  } catch {
    return true;
  }
}

export function mergeCalculatorData(existing: unknown, incoming: unknown) {
  const current: Record<string, unknown> =
    existing && typeof existing === "object" ? { ...(existing as Record<string, unknown>) } : {};
  if (!incoming || typeof incoming !== "object") return current;

  const next = incoming as Record<string, unknown>;
  const tombstones = mergeTombstones(
    current[QUOTE_SYNC_TOMBSTONES_STORAGE_KEY],
    next[QUOTE_SYNC_TOMBSTONES_STORAGE_KEY],
  );
  const merged = { ...current };

  for (const [key, value] of Object.entries(next)) {
    if (key === QUOTE_SYNC_TOMBSTONES_STORAGE_KEY) continue;
    const kind = QUOTE_COLLECTION_STORAGE_KEYS.has(key)
      ? "rows"
      : OPTION_COLLECTION_STORAGE_KEYS.has(key)
        ? "options"
        : null;
    if (kind) {
      const collection = mergeRecordCollection(current[key], value, kind, tombstones);
      if (collection !== undefined) merged[key] = collection;
      continue;
    }

    const existingHasData = storedValueHasData(merged[key]);
    const incomingHasData = storedValueHasData(value);
    if (!incomingHasData && existingHasData) continue;
    merged[key] = MANAGED_PRICE_STORAGE_KEYS.has(key) ? correctStaleManagedPrices(value) : value;
  }

  if (
    Object.keys(tombstones.rows).length ||
    Object.keys(tombstones.options).length ||
    QUOTE_SYNC_TOMBSTONES_STORAGE_KEY in current ||
    QUOTE_SYNC_TOMBSTONES_STORAGE_KEY in next
  ) {
    merged[QUOTE_SYNC_TOMBSTONES_STORAGE_KEY] = JSON.stringify(tombstones);
  }

  return merged;
}
