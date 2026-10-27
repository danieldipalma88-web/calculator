// @ts-ignore Explicit TS extension is required by the direct Node regression runners.
import { QUOTE_ARRANGEMENT_KEY, QUOTE_DEF_KEYS, QUOTE_ROW_KEYS, quoteObject, quoteParse, quoteSerialize, type QuoteRecord } from "./quote-family.ts";
// @ts-ignore Explicit TS extension is required by the direct Node regression runners.
import { quoteLibraryResponseRow } from "./quote-library-edit.ts";

function sensitive(key: string) {
  return /commission|profit|margin/i.test(key);
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (quoteObject(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !sensitive(key)).map(([key, item]) => [key, strip(item)]));
  if (typeof value === "string") {
    const parsed = quoteParse(value);
    if (quoteObject(parsed) || Array.isArray(parsed)) return JSON.stringify(strip(parsed));
  }
  return value;
}

function visibleRows(value: unknown, canSeeSalespersonCommission: boolean): unknown {
  if (!Array.isArray(value)) return strip(value);
  return value.map((row) => {
    if (!quoteObject(row)) return strip(row);
    const projected = strip(row) as QuoteRecord;
    const response = quoteLibraryResponseRow(row, false, canSeeSalespersonCommission);
    for (const key of ["salespersonCommissionInc", "netProfit"]) if (key in response) projected[key] = response[key];
    return projected;
  });
}

export function visibleCalculatorData(data: QuoteRecord, financialsVisible: boolean, canSeeSalespersonCommission: boolean): QuoteRecord {
  const output: QuoteRecord = {};
  for (const [key, value] of Object.entries(data)) {
    // Receipts are server-only, including historical full-record receipts and unknown payloads.
    if (key === QUOTE_ARRANGEMENT_KEY) continue;
    if (financialsVisible) { output[key] = value; continue; }
    if (sensitive(key)) continue;
    const parsed = quoteParse(value);
    const rowCollection = QUOTE_ROW_KEYS.includes(key);
    const backupCollection = ["installerSavedQuoteSetsV1", "greenEnergySavedQuoteSetsV1", "SavedQuoteSetsV1"].includes(key);
    if ((rowCollection || backupCollection || QUOTE_DEF_KEYS.includes(key)) && !Array.isArray(parsed)) continue;
    if (/(?:ManagedPrices|DefaultCostRules)V1$/.test(key) && !quoteObject(parsed) && !Array.isArray(parsed)) continue;
    let projected = strip(parsed);
    if (rowCollection) projected = visibleRows(parsed, canSeeSalespersonCommission);
    if (backupCollection && Array.isArray(parsed)) projected = parsed.map((backup) => {
      if (!quoteObject(backup)) return strip(backup);
      const result = strip(backup) as QuoteRecord;
      if (Array.isArray(backup.quotes)) result.quotes = visibleRows(backup.quotes, canSeeSalespersonCommission);
      return result;
    });
    // Ordinary non-JSON text is not transformed into null.
    output[key] = typeof value === "string" && parsed === null && value !== "null" ? value : quoteSerialize(value, projected);
  }
  return output;
}
