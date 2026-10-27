export type QuoteRecord = Record<string, unknown>;
export const QUOTE_ROW_KEYS = ["installerMasterQuoteLogV1", "greenEnergyMasterQuoteLogV1", "MasterQuoteLogV1"];
export const QUOTE_DEF_KEYS = ["installerQuoteOptionDefsV1", "greenEnergyQuoteOptionDefsV1", "QuoteOptionDefsV1"];
export const QUOTE_ARRANGEMENT_KEY = "installerQuoteArrangementV1";
export const QUOTE_FAMILY_FIELDS = ["quoteFamilyId", "quoteOptionName", "quoteOptionOrder"];
export const QUOTE_ROW_FIELDS = ["quotePosition"];
const QUOTE_LIFECYCLE_FIELDS = [
  "wonAt", "wonByEmail", "wonByName", "wonSourceId", "wonState",
  "paymentRequestedAt", "paymentRequestedByEmail", "agencyPaidInAt", "agencyPaidInByEmail",
  "paidInAt", "paidInByEmail", "salespersonPaidOutAt", "salespersonPaidOutByEmail", "paidOutAt", "paidOutByEmail",
  "paymentResetAt", "paymentResetByEmail", "unlockedAt", "unlockedByEmail", "resetAt", "resetByEmail", "resetWonAt",
  "paymentStatus", "agencyPaymentStatus", "salespersonPaymentEvidence", "commissionPaidAt", "commissionPaymentId",
  "archivedAt", "archivedByEmail", "archivedByName", "archived",
];
const QUOTE_ADMIN_STATE_KEYS = ["installerWonOptionAdminStateV1", "greenEnergyWonOptionAdminStateV1", "WonOptionAdminStateV1"];
const UNLOCK_FIELDS = QUOTE_LIFECYCLE_FIELDS.filter((key) => !key.startsWith("archived"));
const COPY_LIFECYCLE_FIELDS = [...QUOTE_LIFECYCLE_FIELDS,
  "quoteLibraryEditSaveId", "quoteLibraryEditFingerprint", "quoteLibraryEditVersion", "quoteLibraryCopySaveId",
];

export function quoteObject(value: unknown): value is QuoteRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function quoteParse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

export function quoteRecords(value: unknown): QuoteRecord[] {
  const parsed = quoteParse(value);
  return Array.isArray(parsed) ? parsed.filter(quoteObject) : [];
}

export function quoteCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(quoteCanonical).join(",")}]`;
  if (quoteObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${quoteCanonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

export function quoteFamilyId(def: QuoteRecord): string {
  return String(def.quoteFamilyId || def.id || "");
}

export function quoteFamilyLocked(data: QuoteRecord, optionId: unknown): boolean {
  data = applyStoredQuoteAdminUnlocks(data);
  const defs = QUOTE_DEF_KEYS.flatMap((key) => quoteRecords(data[key]));
  const source = defs.find((def) => def.id === optionId);
  const family = source ? quoteFamilyId(source) : String(optionId || "");
  const ids = new Set(defs.filter((def) => quoteFamilyId(def) === family).map((def) => def.id));
  ids.add(optionId);
  return defs.some((def) => ids.has(def.id) && !!def.wonAt) ||
    QUOTE_ROW_KEYS.some((key) => quoteRecords(data[key]).some((row) => ids.has(row.optionId) && !!row.wonAt));
}

export function quoteSerialize(original: unknown, records: unknown): unknown {
  return typeof original === "string" || original === undefined ? JSON.stringify(records) : records;
}

export function copyQuoteWithoutLifecycle(record: QuoteRecord): QuoteRecord {
  const copy = { ...record };
  if (quoteObject(record.state)) copy.state = { ...record.state };
  for (const target of [copy, ...(quoteObject(copy.state) ? [copy.state] : [])]) {
    for (const key of COPY_LIFECYCLE_FIELDS) delete target[key];
  }
  return copy;
}

function quoteTime(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : Date.parse(String(value || "")) || 0;
}

// The second argument must be stored server data, never a client-supplied admin ledger.
export function applyStoredQuoteAdminUnlocks(value: unknown, trustedValue: unknown = value): QuoteRecord {
  const data = quoteObject(value) ? value : {};
  const trusted = quoteObject(trustedValue) ? trustedValue : {};
  const markers = new Map<string, Map<string, number>>();
  for (const key of QUOTE_ADMIN_STATE_KEYS) for (const marker of quoteRecords(trusted[key])) {
    if (String(marker.sourceId || "current") !== "current" || typeof marker.optionId !== "string" ||
        typeof marker.wonAt !== "string" || !marker.wonAt || !quoteTime(marker.unlockedAt)) continue;
    const option = markers.get(marker.optionId) || new Map<string, number>();
    option.set(marker.wonAt, Math.max(option.get(marker.wonAt) || 0, quoteTime(marker.unlockedAt)));
    markers.set(marker.optionId, option);
  }
  if (!markers.size) return data;
  const parents = latest(data, QUOTE_DEF_KEYS);
  const trustedParents = latest(trusted, QUOTE_DEF_KEYS);
  const optionAcceptances = new Map<string, Set<string>>();
  for (const source of [data, trusted]) for (const keys of [QUOTE_DEF_KEYS, QUOTE_ROW_KEYS]) for (const key of keys) for (const record of quoteRecords(source[key])) {
    if (typeof record.wonAt !== "string" || !record.wonAt) continue;
    const id = String(keys === QUOTE_DEF_KEYS ? record.id || "" : record.optionId || "");
    const acceptances = optionAcceptances.get(id) || new Set<string>();
    acceptances.add(record.wonAt); optionAcceptances.set(id, acceptances);
  }
  const output = { ...data };
  for (const keys of [QUOTE_DEF_KEYS, QUOTE_ROW_KEYS]) {
    const trustedRecords = latest(trusted, keys);
    const groups = new Map<string, QuoteRecord[]>();
    const collections = new Map<string, unknown[]>();
    for (const key of keys) {
      const parsed = quoteParse(data[key]);
      if (Array.isArray(parsed)) collections.set(key, parsed);
    }
    for (const values of collections.values()) for (const record of values.filter(quoteObject)) {
      const id = String(record.id || "");
      const optionId = String(keys === QUOTE_DEF_KEYS ? record.id || "" : record.optionId || "");
      if (!id || !markers.has(optionId)) continue;
      const group = groups.get(id) || [];
      group.push(record); groups.set(id, group);
    }
    const normalized = new Map<QuoteRecord, QuoteRecord>();
    for (const [id, records] of groups) {
      let changed = false;
      let unlockTime = 0;
      const cleaned = records.map((record) => {
        const optionId = String(keys === QUOTE_DEF_KEYS ? record.id : record.optionId);
        const receipts = markers.get(optionId)!;
        const matches = (wonAt: unknown) => typeof wonAt === "string" && receipts.has(wonAt);
        const parent = parents.get(optionId) || trustedParents.get(optionId);
        const parentWon = keys === QUOTE_DEF_KEYS ? record.wonAt : parent?.wonAt;
        const knownWon = optionAcceptances.get(optionId);
        if (!record.wonAt && knownWon?.size && ![...knownWon].some((wonAt) => receipts.has(wonAt))) return record;
        const clear = record.wonAt ? matches(record.wonAt) : !parentWon || matches(parentWon);
        const state = quoteObject(record.state) ? record.state : undefined;
        const clearState = state && (matches(state.wonAt) || (clear && !state.wonAt));
        if (!clear && !clearState) return record;
        unlockTime = Math.max(unlockTime, ...receipts.values());
        const next = { ...record };
        if (clear) for (const key of UNLOCK_FIELDS) delete next[key];
        if (clearState) {
          next.state = { ...state };
          for (const key of UNLOCK_FIELDS) delete (next.state as QuoteRecord)[key];
        }
        const authoritative = trustedRecords.get(id);
        const trustedParent = trustedParents.get(optionId);
        const staleAcceptance = matches(record.wonAt) || (matches(parentWon) && trustedParent?.wonAt && !matches(trustedParent.wonAt));
        // An old acceptance receipt cannot erase a genuinely new acceptance already on the server.
        if (staleAcceptance && authoritative &&
            ((authoritative.wonAt && !matches(authoritative.wonAt)) || (trustedParent?.wonAt && !matches(trustedParent.wonAt)))) {
          for (const key of UNLOCK_FIELDS) {
            delete next[key];
            if (key in authoritative) next[key] = authoritative[key];
          }
          if (quoteObject(authoritative.state) || quoteObject(next.state)) {
            next.state = { ...(quoteObject(next.state) ? next.state : {}) };
            for (const key of UNLOCK_FIELDS) {
              delete (next.state as QuoteRecord)[key];
              if (quoteObject(authoritative.state) && key in authoritative.state) (next.state as QuoteRecord)[key] = authoritative.state[key];
            }
          }
        }
        if (quoteCanonical(next) !== quoteCanonical(record)) changed = true;
        return next;
      });
      const priorVersion = Math.max(...records.map((record) => quoteTime(record.syncUpdatedAt) || quoteTime(record.timestamp)));
      const version = Math.max(unlockTime, priorVersion + (changed ? 1 : 0));
      if (!Number.isSafeInteger(version) || (!changed && (!unlockTime || priorVersion >= unlockTime))) continue;
      records.forEach((record, index) => normalized.set(record, { ...cleaned[index], syncUpdatedAt: version }));
    }
    for (const key of keys) {
      const parsed = collections.get(key);
      if (!parsed || !parsed.some((record) => quoteObject(record) && normalized.has(record))) continue;
      output[key] = quoteSerialize(data[key], parsed.map((record) => quoteObject(record) ? normalized.get(record) || record : record));
    }
  }
  return output;
}

function latest(data: QuoteRecord, keys: string[]): Map<string, QuoteRecord> {
  const result = new Map<string, QuoteRecord>();
  for (const key of keys) for (const record of quoteRecords(data[key])) {
    const id = String(record.id || "");
    if (!id) continue;
    const prior = result.get(id);
    if (!prior || Number(record.syncUpdatedAt || record.timestamp || 0) > Number(prior.syncUpdatedAt || prior.timestamp || 0)) result.set(id, record);
  }
  return result;
}

function nativeQuotePositions(current: QuoteRecord, incoming: QuoteRecord) {
  const defs = latest(current, QUOTE_DEF_KEYS);
  const existing = latest(current, QUOTE_ROW_KEYS);
  const ledger = quoteParse(current[QUOTE_ARRANGEMENT_KEY]);
  const removed = new Set(quoteObject(ledger) && Array.isArray(ledger.removedRowIds) ? ledger.removedRowIds : []);
  const removedOptions = new Set(quoteObject(ledger) && Array.isArray(ledger.removedOptionIds) ? ledger.removedOptionIds : []);
  const maxima = new Map<unknown, number>();
  for (const row of existing.values()) if (typeof row.quotePosition === "number") {
    maxima.set(row.optionId, Math.max(maxima.get(row.optionId) ?? -1, row.quotePosition));
  }
  const positions = new Map<string, number>();
  const seen = new Map<string, QuoteRecord>();
  const used = new Map<unknown, Set<number>>();
  const conflictingOptionIds = new Set<string>();
  let invalid = false;
  for (const key of QUOTE_ROW_KEYS) for (const row of quoteRecords(incoming[key])) {
    const id = String(row.id || "");
    if (!id || removed.has(id) || removedOptions.has(row.optionId) || existing.has(id) || !defs.get(String(row.optionId))?.quoteFamilyId || !("quotePosition" in row)) continue;
    const prior = seen.get(id);
    if (prior) {
      if (prior.optionId !== row.optionId || prior.quotePosition !== row.quotePosition) {
        invalid = true;
        conflictingOptionIds.add(String(prior.optionId));
        conflictingOptionIds.add(String(row.optionId));
      }
      continue;
    }
    seen.set(id, row);
    const position = row.quotePosition;
    const reserved = used.get(row.optionId) || new Set<number>();
    if (typeof position !== "number" || !Number.isSafeInteger(position) || position < 0 ||
        position <= (maxima.get(row.optionId) ?? -1) || reserved.has(position)) {
      invalid = true;
      conflictingOptionIds.add(String(row.optionId));
      continue;
    }
    reserved.add(position);
    used.set(row.optionId, reserved);
    positions.set(id, position);
  }
  // Invalid batches fall back to server append order in the pure merger; the API rejects them.
  return { positions: invalid ? new Map<string, number>() : positions, invalid, conflictingOptionIds };
}

export function quoteFamilySnapshotViolation(current: QuoteRecord, incoming: QuoteRecord): boolean {
  current = applyStoredQuoteAdminUnlocks(current);
  incoming = applyStoredQuoteAdminUnlocks(incoming, current);
  const defs = latest(current, QUOTE_DEF_KEYS);
  const rows = latest(current, QUOTE_ROW_KEYS);
  const wonIds = new Set([...defs.values()].filter((def) => def.wonAt).map((def) => def.id));
  for (const row of rows.values()) if (row.wonAt) wonIds.add(row.optionId);
  const ledger = quoteParse(current[QUOTE_ARRANGEMENT_KEY]);
  const removed = new Set(quoteObject(ledger) && Array.isArray(ledger.removedRowIds) ? ledger.removedRowIds : []);
  const removedOptions = new Set(quoteObject(ledger) && Array.isArray(ledger.removedOptionIds) ? ledger.removedOptionIds : []);
  if (nativeQuotePositions(current, incoming).invalid) return true;
  for (const keys of [QUOTE_DEF_KEYS, QUOTE_ROW_KEYS]) for (const key of keys) for (const record of quoteRecords(incoming[key])) {
    const isRow = keys === QUOTE_ROW_KEYS;
    if (isRow && removed.has(record.id)) continue;
    const prior = (isRow ? rows : defs).get(String(record.id));
    const optionId = isRow ? prior?.optionId ?? record.optionId : record.id;
    if (isRow && prior && "optionId" in record && prior.optionId !== record.optionId &&
        (defs.get(String(prior.optionId))?.quoteFamilyId || defs.get(String(record.optionId))?.quoteFamilyId || removedOptions.has(record.optionId))) return true;
    if (isRow && !prior && removedOptions.has(optionId)) return true;
    if (!defs.get(String(optionId))?.quoteFamilyId || !quoteFamilyLocked(current, optionId)) continue;
    if ((isRow && !prior) || (record.wonAt && !wonIds.has(optionId))) return true;
  }
  return false;
}

export function quoteFamilySnapshotConflict(current: QuoteRecord, incoming: QuoteRecord) {
  current = applyStoredQuoteAdminUnlocks(current);
  incoming = applyStoredQuoteAdminUnlocks(incoming, current);
  if (!quoteFamilySnapshotViolation(current, incoming)) return null;
  const defs = latest(current, QUOTE_DEF_KEYS);
  const rows = latest(current, QUOTE_ROW_KEYS);
  const ledger = quoteParse(current[QUOTE_ARRANGEMENT_KEY]);
  const removedRows = new Set(quoteObject(ledger) && Array.isArray(ledger.removedRowIds) ? ledger.removedRowIds : []);
  const removedOptions = new Set(quoteObject(ledger) && Array.isArray(ledger.removedOptionIds) ? ledger.removedOptionIds : []);
  const receipts = quoteObject(ledger) && Array.isArray(ledger.receipts) ? ledger.receipts.filter(quoteObject) : [];
  const families = new Set<string>();
  const restoredRows = new Set<string>();
  const deletedTargets = new Set<string>();
  let selectedOptionId = "";
  function affectOption(value: unknown) {
    let id = String(value || "");
    const seen = new Set<string>();
    // A deleted option's receipt points to a surviving sibling, possibly deleted later too.
    while (id && !defs.has(id) && removedOptions.has(id) && !seen.has(id)) {
      seen.add(id);
      deletedTargets.add(id);
      const receipt = receipts.find((entry) => Array.isArray(entry.removedOptionIds) && entry.removedOptionIds.includes(id));
      id = String(receipt?.selectedOptionId || "");
    }
    const def = defs.get(id);
    if (!def?.quoteFamilyId) return;
    families.add(quoteFamilyId(def));
    selectedOptionId ||= id;
  }
  for (const id of nativeQuotePositions(current, incoming).conflictingOptionIds) affectOption(id);
  const wonIds = new Set([...defs.values()].filter((def) => def.wonAt).map((def) => def.id));
  for (const row of rows.values()) if (row.wonAt) wonIds.add(row.optionId);
  for (const keys of [QUOTE_DEF_KEYS, QUOTE_ROW_KEYS]) for (const key of keys) for (const record of quoteRecords(incoming[key])) {
    const isRow = keys === QUOTE_ROW_KEYS;
    if (isRow && removedRows.has(record.id)) continue;
    const prior = (isRow ? rows : defs).get(String(record.id));
    const sourceId = isRow ? prior?.optionId ?? record.optionId : record.id;
    const destinationId = isRow && "optionId" in record ? record.optionId : sourceId;
    const transfer = isRow && prior && sourceId !== destinationId &&
      (defs.get(String(sourceId))?.quoteFamilyId || defs.get(String(destinationId))?.quoteFamilyId || removedOptions.has(destinationId));
    const deletedTarget = isRow && !prior && removedOptions.has(destinationId);
    const locked = defs.get(String(sourceId))?.quoteFamilyId && quoteFamilyLocked(current, sourceId) &&
      ((isRow && !prior) || (record.wonAt && !wonIds.has(sourceId)));
    if (!transfer && !deletedTarget && !locked) continue;
    affectOption(sourceId);
    affectOption(destinationId);
    if (isRow && prior) restoredRows.add(String(prior.id));
  }
  const familyDefs = [...defs.values()].filter((def) => families.has(quoteFamilyId(def)));
  const ids = new Set(familyDefs.map((def) => def.id));
  const familyRows = [...rows.values()].filter((row) => ids.has(row.optionId) || restoredRows.has(String(row.id)));
  const removedOptionIds = new Set<string>(deletedTargets);
  const removedRowIds = new Set<string>();
  for (const key of QUOTE_DEF_KEYS) for (const def of quoteRecords(incoming[key])) if (!defs.has(String(def.id)) && removedOptions.has(def.id)) removedOptionIds.add(String(def.id));
  for (const key of QUOTE_ROW_KEYS) for (const row of quoteRecords(incoming[key])) {
    if (!rows.has(String(row.id)) && (ids.has(row.optionId) || removedOptions.has(row.optionId) || removedRows.has(row.id))) removedRowIds.add(String(row.id));
  }
  return { defs: familyDefs, rows: familyRows, removedOptionIds: [...removedOptionIds], removedRowIds: [...removedRowIds], selectedOptionId };
}

export function quoteFamilyUnlockRequested(current: QuoteRecord, candidate: QuoteRecord): boolean {
  current = applyStoredQuoteAdminUnlocks(current);
  candidate = applyStoredQuoteAdminUnlocks(candidate, current);
  const defs = latest(current, QUOTE_DEF_KEYS);
  for (const keys of [QUOTE_DEF_KEYS, QUOTE_ROW_KEYS]) {
    const next = latest(candidate, keys);
    for (const record of latest(current, keys).values()) {
      const optionId = keys === QUOTE_DEF_KEYS ? record.id : record.optionId;
      if (defs.get(String(optionId))?.quoteFamilyId && record.wonAt && next.get(String(record.id))?.wonAt !== record.wonAt) return true;
    }
  }
  return false;
}

// Only arrangement owns topology. Old clients may still save ordinary prices/state.
export function fenceQuoteFamilySnapshot(current: QuoteRecord, incoming: QuoteRecord): QuoteRecord {
  current = applyStoredQuoteAdminUnlocks(current);
  incoming = applyStoredQuoteAdminUnlocks(incoming, current);
  const next = { ...incoming };
  delete next[QUOTE_ARRANGEMENT_KEY];
  for (const key of QUOTE_ADMIN_STATE_KEYS) delete next[key];
  const ledger = quoteParse(current[QUOTE_ARRANGEMENT_KEY]);
  const removedRows = new Set(quoteObject(ledger) && Array.isArray(ledger.removedRowIds) ? ledger.removedRowIds : []);
  const removedDefs = new Set(quoteObject(ledger) && Array.isArray(ledger.removedOptionIds) ? ledger.removedOptionIds : []);
  const defs = latest(current, QUOTE_DEF_KEYS);
  const rows = latest(current, QUOTE_ROW_KEYS);
  const managedDefs = new Set([...defs].filter(([, def]) => !!def.quoteFamilyId).map(([id]) => id));
  const managedRows = new Set([...rows].filter(([, row]) => managedDefs.has(String(row.optionId)) || "quotePosition" in row).map(([id]) => id));
  const nativePositions = nativeQuotePositions(current, incoming).positions;
  const wonIds = new Set([...defs.values()].filter((def) => def.wonAt).map((def) => def.id));
  for (const row of rows.values()) if (row.wonAt) wonIds.add(row.optionId);
  for (const keys of [QUOTE_DEF_KEYS, QUOTE_ROW_KEYS]) {
    const isRow = keys === QUOTE_ROW_KEYS;
    const prior = isRow ? rows : defs;
    const managed = isRow ? managedRows : managedDefs;
    for (const key of keys) {
      if (!(key in next)) continue;
      const parsed = quoteParse(next[key]);
      if (!Array.isArray(parsed)) continue;
      const values = parsed.filter((value) => !quoteObject(value) || !(isRow ? removedRows : removedDefs).has(value.id)).flatMap((value) => {
        if (!quoteObject(value)) return [value];
        const existing = prior.get(String(value.id));
        if (isRow && removedDefs.has(value.optionId)) return existing ? [existing] : [];
        if (isRow && !existing && managedDefs.has(String(value.optionId)) && quoteFamilyLocked(current, value.optionId)) return [];
        if (isRow && existing && "optionId" in value && existing.optionId !== value.optionId && managedDefs.has(String(value.optionId)) && !managedRows.has(String(value.id))) return [existing];
        let output = { ...value };
        for (const field of [...QUOTE_FAMILY_FIELDS, ...QUOTE_ROW_FIELDS]) delete output[field];
        if (isRow && !existing && nativePositions.has(String(value.id))) output.quotePosition = nativePositions.get(String(value.id));
        if (existing && managed.has(String(value.id))) {
          if (isRow && !wonIds.has(existing.optionId) && quoteFamilyLocked(current, existing.optionId)) return [existing];
          output = { ...existing, ...output };
          if (quoteObject(existing.state) && (value.state === undefined || quoteObject(value.state))) output.state = { ...existing.state, ...(quoteObject(value.state) ? value.state : {}) };
          // Omission clears known lifecycle fields exactly as the ordinary versioned merge does.
          for (const field of QUOTE_LIFECYCLE_FIELDS) {
            if (!(field in value)) delete output[field];
            if (quoteObject(output.state) && (!quoteObject(value.state) || !(field in value.state))) delete output.state[field];
          }
          const fields = isRow ? ["optionId", "optionName", ...QUOTE_ROW_FIELDS] : ["name", ...QUOTE_FAMILY_FIELDS];
          for (const field of fields) {
            delete output[field];
            if (field in existing) output[field] = existing[field];
          }
        }
        return [output];
      });
      next[key] = quoteSerialize(next[key], values);
    }
  }
  const tombstones = quoteParse(next.installerQuoteSyncTombstonesV1);
  if (quoteObject(tombstones)) {
    const filtered = { ...tombstones };
    for (const [kind, protectedIds] of [["rows", managedRows], ["options", managedDefs]] as const) {
      if (quoteObject(tombstones[kind])) filtered[kind] = Object.fromEntries(Object.entries(tombstones[kind] as QuoteRecord).filter(([id]) => !protectedIds.has(id)));
    }
    next.installerQuoteSyncTombstonesV1 = quoteSerialize(next.installerQuoteSyncTombstonesV1, filtered);
  }
  return next;
}

export function cohereQuoteFamilyAliases(data: QuoteRecord): QuoteRecord {
  const output = { ...data };
  const ledger = quoteParse(data[QUOTE_ARRANGEMENT_KEY]);
  const deletedRows = new Set(quoteObject(ledger) && Array.isArray(ledger.removedRowIds) ? ledger.removedRowIds : []);
  const deletedDefs = new Set(quoteObject(ledger) && Array.isArray(ledger.removedOptionIds) ? ledger.removedOptionIds : []);
  const defs = latest(data, QUOTE_DEF_KEYS);
  const managedDefs = new Map([...defs].filter(([, def]) => !!def.quoteFamilyId && !deletedDefs.has(def.id)));
  const rows = latest(data, QUOTE_ROW_KEYS);
  const positions = new Map<string, number>();
  for (const row of rows.values()) if (managedDefs.has(String(row.optionId)) && typeof row.quotePosition === "number") {
    positions.set(String(row.optionId), Math.max(positions.get(String(row.optionId)) ?? -1, row.quotePosition));
  }
  const managedRows = new Map([...rows].filter(([, row]) => managedDefs.has(String(row.optionId)) && !deletedRows.has(row.id)).map(([id, row]) => {
    if (typeof row.quotePosition !== "number") {
      const position = (positions.get(String(row.optionId)) ?? -1) + 1;
      positions.set(String(row.optionId), position);
      row = { ...row, quotePosition: position };
    }
    return [id, { ...row, optionName: managedDefs.get(String(row.optionId))!.name } as QuoteRecord] as const;
  }));
  for (const [keys, managed, deleted] of [[QUOTE_DEF_KEYS, managedDefs, deletedDefs], [QUOTE_ROW_KEYS, managedRows, deletedRows]] as const) {
    for (const key of keys.filter((key) => key in data)) {
      if (!managed.size && !deleted.size) continue;
      const seen = new Set<unknown>();
      const parsed = quoteParse(data[key]);
      if (!Array.isArray(parsed)) continue;
      const values = parsed.flatMap((record) => {
        if (!quoteObject(record)) return [record];
        if (deleted.has(record.id) || (managed.has(String(record.id)) && seen.has(record.id))) return [];
        seen.add(record.id);
        return [managed.get(String(record.id)) || record];
      });
      for (const record of managed.values()) if (!seen.has(record.id)) values.push(record);
      output[key] = quoteSerialize(data[key], values);
    }
  }
  return output;
}
