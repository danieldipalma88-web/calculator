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
    merged.push(winner);
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
    merged[key] = value;
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
