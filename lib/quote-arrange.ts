import { createHash, randomUUID } from "node:crypto";
// @ts-ignore Explicit TS extension is required by the direct Node regression runners.
import { quoteLibraryVisibleRow } from "./quote-library-edit.ts";
// @ts-ignore Explicit TS extension is required by the direct Node regression runners.
import { QUOTE_ARRANGEMENT_KEY, QUOTE_DEF_KEYS, QUOTE_ROW_KEYS, applyStoredQuoteAdminUnlocks, copyQuoteWithoutLifecycle, quoteCanonical, quoteFamilyId, quoteFamilyLocked, quoteObject, quoteParse, quoteSerialize, type QuoteRecord } from "./quote-family.ts";

type Patch = { defs: QuoteRecord[]; rows: QuoteRecord[]; removedOptionIds: string[]; removedRowIds: string[]; selectedOptionId: string };
export type QuoteArrangeResult = ({ data: QuoteRecord } & Patch) | { error: string; status: 409 | 422; currentFamily?: Patch };
const conflict = (): QuoteArrangeResult => ({ error: "This quote family changed, was removed, or is locked. Reopen it before arranging.", status: 409 });
const invalid = (error: string): QuoteArrangeResult => ({ error, status: 422 });
const actions = ["addOption", "renameOption", "renameCustomer", "duplicateOption", "moveRow", "copyRow", "removeRow", "deleteOption"];
const hash = (value: unknown) => createHash("sha256").update(quoteCanonical(value)).digest("hex");

function collection(data: QuoteRecord, keys: string[]): QuoteRecord[] | null {
  const records = new Map<string, QuoteRecord>();
  for (const key of keys) {
    if (!(key in data)) continue;
    const parsed = quoteParse(data[key]);
    if (!Array.isArray(parsed) || !parsed.every(quoteObject)) return null;
    const seen = new Set<string>();
    for (const record of parsed) {
      if (typeof record.id !== "string" || !record.id || seen.has(record.id)) return null;
      seen.add(record.id);
      const prior = records.get(record.id);
      if (prior && quoteCanonical(prior) !== quoteCanonical(record)) return null;
      records.set(record.id, record);
    }
  }
  return [...records.values()];
}

function sorted(records: QuoteRecord[], field: string): QuoteRecord[] {
  return records.map((record, index) => ({ record, index })).sort((a, b) => {
    const left = typeof a.record[field] === "number" ? a.record[field] as number : Number.MAX_SAFE_INTEGER;
    const right = typeof b.record[field] === "number" ? b.record[field] as number : Number.MAX_SAFE_INTEGER;
    return left - right || a.index - b.index;
  }).map(({ record }) => record);
}

function snapshot(records: QuoteRecord[], financialsVisible: boolean): string {
  return quoteCanonical(records.map((record) => quoteLibraryVisibleRow(record, financialsVisible)).sort((a, b) => String(a.id).localeCompare(String(b.id))));
}

export function applyQuoteArrange(storedData: unknown, request: unknown, financialsVisible: boolean, now = Date.now()): QuoteArrangeResult {
  if (quoteObject(storedData)) storedData = applyStoredQuoteAdminUnlocks(storedData);
  const result = arrange(storedData, request, financialsVisible, now);
  if (!("error" in result) || result.status !== 409 || !quoteObject(storedData) || !quoteObject(request)) return result;
  const defs = collection(storedData, QUOTE_DEF_KEYS);
  const rows = collection(storedData, QUOTE_ROW_KEYS);
  if (!defs || !rows) return result;
  const expected = quoteObject(request.expected) ? request.expected : {};
  const expectedDefs = Array.isArray(expected.defs) ? expected.defs.filter(quoteObject) : [];
  const expectedRows = Array.isArray(expected.rows) ? expected.rows.filter(quoteObject) : [];
  const source = defs.find((def) => def.id === request.optionId) || defs.find((def) => def.quoteFamilyId === request.optionId) || expectedDefs.find((def) => def.id === request.optionId);
  if (!source) return result;
  const familyDefs = defs.filter((def) => quoteFamilyId(def) === quoteFamilyId(source));
  const ids = new Set(familyDefs.map((def) => def.id));
  const familyRows = rows.filter((row) => ids.has(row.optionId));
  return { ...result, currentFamily: { defs: familyDefs, rows: familyRows,
    removedOptionIds: expectedDefs.filter((def) => !defs.some((current) => current.id === def.id)).map((def) => String(def.id)),
    removedRowIds: expectedRows.filter((row) => !rows.some((current) => current.id === row.id)).map((row) => String(row.id)),
    selectedOptionId: String(familyDefs.find((def) => def.id === request.optionId)?.id || familyDefs[0]?.id || ""),
  } };
}

function arrange(storedData: unknown, request: unknown, financialsVisible: boolean, now: number): QuoteArrangeResult {
  if (!quoteObject(storedData) || !quoteObject(request) || !actions.includes(String(request.action)) ||
      typeof request.optionId !== "string" || !request.optionId ||
      typeof request.saveId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(request.saveId) ||
      !quoteObject(request.expected) || !Array.isArray(request.expected.defs) || !request.expected.defs.every(quoteObject) ||
      !Array.isArray(request.expected.rows) || !request.expected.rows.every(quoteObject) ||
      Object.keys(request.expected).some((key) => !["defs", "rows"].includes(key)) ||
      Object.keys(request).some((key) => !["action", "optionId", "targetOptionId", "rowId", "beforeRowId", "name", "expected", "saveId"].includes(key))) return invalid("A supported action, complete family snapshot and unique saveId are required.");
  for (const key of ["targetOptionId", "rowId", "beforeRowId"]) {
    if (request[key] !== undefined && (typeof request[key] !== "string" || !request[key])) return invalid(`Invalid ${key}.`);
  }
  const action = String(request.action);
  const needsName = ["renameOption", "renameCustomer"].includes(action);
  if ((needsName || request.name !== undefined) && (typeof request.name !== "string" || !request.name.trim() || request.name.trim().length > 200)) return invalid("A name between 1 and 200 characters is required.");
  const rowAction = ["moveRow", "copyRow", "removeRow"].includes(action);
  if (rowAction !== (request.rowId !== undefined) ||
      (request.targetOptionId !== undefined && !["moveRow", "copyRow"].includes(action)) ||
      (request.beforeRowId !== undefined && !["moveRow", "copyRow"].includes(action)) ||
      (request.name !== undefined && !["addOption", "duplicateOption", "renameOption", "renameCustomer"].includes(action))) return invalid("Fields do not match the arrangement action.");
  const data = storedData;
  const defs = collection(data, QUOTE_DEF_KEYS);
  const rows = collection(data, QUOTE_ROW_KEYS);
  if (!defs || !rows) return invalid("Saved quote aliases are malformed or disagree. No systems were changed.");
  const rawLedger = quoteParse(data[QUOTE_ARRANGEMENT_KEY]);
  if (rawLedger !== undefined && (!quoteObject(rawLedger) || !Array.isArray(rawLedger.receipts) || !rawLedger.receipts.every(quoteObject) ||
      !Array.isArray(rawLedger.removedOptionIds) || !rawLedger.removedOptionIds.every((id) => typeof id === "string") ||
      !Array.isArray(rawLedger.removedRowIds) || !rawLedger.removedRowIds.every((id) => typeof id === "string"))) return invalid("Saved arrangement receipts are malformed. No systems were changed.");
  const ledger = quoteObject(rawLedger) ? rawLedger : { receipts: [], removedOptionIds: [], removedRowIds: [] };
  const receipts = ledger.receipts as QuoteRecord[];
  const fingerprint = hash({ ...request, saveId: undefined });
  const receipt = receipts.find((entry) => entry.id === request.saveId);
  if (receipt) {
    if (receipt.fingerprint !== fingerprint || !quoteObject(receipt.defHashes) || !quoteObject(receipt.rowHashes) ||
        !Array.isArray(receipt.removedOptionIds) || !Array.isArray(receipt.removedRowIds)) return conflict();
    const defHashes = receipt.defHashes;
    const rowHashes = receipt.rowHashes;
    const patch: Patch = { defs: defs.filter((def) => String(def.id) in defHashes), rows: rows.filter((row) => String(row.id) in rowHashes),
      removedOptionIds: receipt.removedOptionIds as string[], removedRowIds: receipt.removedRowIds as string[], selectedOptionId: String(receipt.selectedOptionId || "") };
    // Never replay an old patch over a subsequent edit/move/delete.
    if (patch.defs.length !== Object.keys(defHashes).length || patch.rows.length !== Object.keys(rowHashes).length ||
        patch.defs.some((def) => hash(def) !== defHashes[String(def.id)]) ||
        patch.rows.some((row) => hash(row) !== rowHashes[String(row.id)]) ||
        patch.removedOptionIds.some((id) => defs.some((def) => def.id === id)) ||
        patch.removedRowIds.some((id) => rows.some((row) => row.id === id))) return conflict();
    return { data, ...patch };
  }
  const source = defs.find((def) => def.id === request.optionId) ||
    (["addOption", "renameCustomer"].includes(action) ? defs.find((def) => def.quoteFamilyId === request.optionId) : undefined);
  if (!source || (ledger.removedOptionIds as unknown[]).includes(source.id)) return conflict();
  const familyId = quoteFamilyId(source);
  const familyDefs = sorted(defs.filter((def) => quoteFamilyId(def) === familyId), "quoteOptionOrder");
  const ids = new Set(familyDefs.map((def) => def.id));
  const familyRows = rows.filter((row) => ids.has(row.optionId));
  if (quoteFamilyLocked(data, source.id)) return conflict();
  if (action === "deleteOption" && familyDefs.length === 1) return invalid("The final option cannot be deleted. Remove its systems instead.");
  const tombstones = quoteParse(data.installerQuoteSyncTombstonesV1);
  if (data.installerQuoteSyncTombstonesV1 !== undefined && (!quoteObject(tombstones) ||
      (tombstones.rows !== undefined && !quoteObject(tombstones.rows)) ||
      (tombstones.options !== undefined && !quoteObject(tombstones.options)))) return invalid("Saved deletion markers are malformed. No systems were changed.");
  if (quoteObject(tombstones) && ((quoteObject(tombstones.options) && familyDefs.some((def) => (tombstones.options as QuoteRecord)[String(def.id)])) ||
      (quoteObject(tombstones.rows) && familyRows.some((row) => (tombstones.rows as QuoteRecord)[String(row.id)])))) return conflict();
  if (snapshot(familyDefs, financialsVisible) !== snapshot(request.expected.defs as QuoteRecord[], financialsVisible) ||
      snapshot(familyRows, financialsVisible) !== snapshot(request.expected.rows as QuoteRecord[], financialsVisible)) return conflict();
  const targetId = request.targetOptionId ?? source.id;
  if (!ids.has(targetId)) return conflict();
  const selected = rows.find((row) => row.id === request.rowId);
  if (rowAction && (!selected || selected.optionId !== source.id)) return conflict();
  if (request.beforeRowId !== undefined && !rows.some((row) => row.id === request.beforeRowId && row.optionId === targetId)) return conflict();
  if (action === "moveRow" && request.beforeRowId === request.rowId) return invalid("A system cannot be placed before itself.");
  const version = Math.max(now, ...[...familyDefs, ...familyRows].map((record) => Number(record.syncUpdatedAt || record.timestamp || 0) + 1));
  if (!Number.isSafeInteger(version) || version <= 0) return invalid("Invalid saved quote version.");
  let nextDefs = familyDefs.map((def, index) => ({ ...def, quoteFamilyId: familyId,
    quoteOptionName: String(def.quoteOptionName || `Option ${index + 1}`), quoteOptionOrder: index } as QuoteRecord));
  let nextRows: QuoteRecord[] = familyDefs.flatMap((def) => sorted(familyRows.filter((row) => row.optionId === def.id), "quotePosition").map((row, index) => ({ ...row, quotePosition: index })));
  const removedOptionIds: string[] = [];
  const removedRowIds: string[] = [];
  let selectedOptionId = String(targetId);
  const name = typeof request.name === "string" ? request.name.trim() : "";
  if (action === "addOption" || action === "duplicateOption") {
    const id = `option_${randomUUID()}`;
    selectedOptionId = id;
    const def: QuoteRecord = { ...copyQuoteWithoutLifecycle(source), id, quoteFamilyId: familyId, quoteOptionName: name || `Option ${nextDefs.length + 1}`, quoteOptionOrder: nextDefs.length };
    nextDefs.push(def);
    if (action === "duplicateOption") nextRows.push(...nextRows.filter((row) => row.optionId === source.id).map((row) => ({ ...copyQuoteWithoutLifecycle(row), id: `quote_${randomUUID()}`, optionId: id })));
  } else if (action === "renameOption") {
    nextDefs = nextDefs.map((def) => def.id === source.id ? { ...def, quoteOptionName: name } : def);
  } else if (action === "renameCustomer") {
    nextDefs = nextDefs.map((def) => ({ ...def, name }));
    nextRows = nextRows.map((row) => ({ ...row, optionName: name }));
  } else if (action === "deleteOption") {
    removedOptionIds.push(String(source.id));
    removedRowIds.push(...familyRows.filter((row) => row.optionId === source.id).map((row) => String(row.id)));
    nextDefs = nextDefs.filter((def) => def.id !== source.id);
    nextRows = nextRows.filter((row) => row.optionId !== source.id);
    selectedOptionId = String(nextDefs[0]?.id || "");
  } else if (action === "removeRow") {
    removedRowIds.push(String(selected!.id));
    nextRows = nextRows.filter((row) => row.id !== selected!.id);
  } else {
    const row: QuoteRecord = { ...(action === "copyRow" ? copyQuoteWithoutLifecycle(selected!) : selected!), optionId: targetId, ...(action === "copyRow" ? { id: `quote_${randomUUID()}` } : {}) };
    if (action === "moveRow") nextRows = nextRows.filter((entry) => entry.id !== row.id);
    const targetRows = sorted(nextRows.filter((entry) => entry.optionId === targetId), "quotePosition");
    const index = request.beforeRowId === undefined ? targetRows.length : targetRows.findIndex((entry) => entry.id === request.beforeRowId);
    targetRows.splice(index, 0, row);
    nextRows = [...nextRows.filter((entry) => entry.optionId !== targetId), ...targetRows];
  }
  nextDefs = nextDefs.map((def, index) => ({ ...def, quoteOptionOrder: index }));
  nextRows = nextDefs.flatMap((def) => nextRows.filter((row) => row.optionId === def.id).map((row, index) => ({ ...row, quotePosition: index })));
  const changed = (record: QuoteRecord, prior: QuoteRecord[]) => {
    const original = prior.find((entry) => entry.id === record.id);
    return !original || quoteCanonical(original) !== quoteCanonical(record) ? { ...record, syncUpdatedAt: version } : record;
  };
  nextDefs = nextDefs.map((def) => changed(def, defs));
  nextRows = nextRows.map((row) => changed(row, rows));
  const patch: Patch = { defs: nextDefs.filter((def) => quoteCanonical(def) !== quoteCanonical(defs.find((entry) => entry.id === def.id))),
    rows: nextRows.filter((row) => quoteCanonical(row) !== quoteCanonical(rows.find((entry) => entry.id === row.id))), removedOptionIds, removedRowIds, selectedOptionId };
  const next = { ...data };
  for (const [keys, all, replacements, removed] of [[QUOTE_DEF_KEYS, defs, nextDefs, removedOptionIds], [QUOTE_ROW_KEYS, rows, nextRows, removedRowIds]] as const) {
    const replacementMap = new Map(replacements.map((record) => [record.id, record]));
    const values = all.filter((record) => !removed.includes(String(record.id))).map((record) => replacementMap.get(record.id) || record);
    for (const record of replacements) if (!all.some((entry) => entry.id === record.id)) values.push(record);
    const existingKeys = keys.filter((key) => key in data);
    for (const key of existingKeys.length ? existingKeys : [keys[0]]) next[key] = quoteSerialize(data[key], values);
  }
  next[QUOTE_ARRANGEMENT_KEY] = quoteSerialize(data[QUOTE_ARRANGEMENT_KEY], { ...ledger,
    removedOptionIds: [...new Set([...(ledger.removedOptionIds as string[]), ...removedOptionIds])],
    removedRowIds: [...new Set([...(ledger.removedRowIds as string[]), ...removedRowIds])],
    receipts: [...receipts, { id: request.saveId, fingerprint, selectedOptionId,
      defHashes: Object.fromEntries(patch.defs.map((def) => [String(def.id), hash(def)])),
      rowHashes: Object.fromEntries(patch.rows.map((row) => [String(row.id), hash(row)])), removedOptionIds, removedRowIds }],
  });
  const priorTombstones = quoteObject(tombstones) ? tombstones : {};
  if (removedRowIds.length || removedOptionIds.length) next.installerQuoteSyncTombstonesV1 = quoteSerialize(data.installerQuoteSyncTombstonesV1, {
    ...priorTombstones,
    rows: { ...(quoteObject(priorTombstones.rows) ? priorTombstones.rows : {}), ...Object.fromEntries(removedRowIds.map((id) => [id, version])) },
    options: { ...(quoteObject(priorTombstones.options) ? priorTombstones.options : {}), ...Object.fromEntries(removedOptionIds.map((id) => [id, version])) },
  });
  return { data: next, ...patch };
}
