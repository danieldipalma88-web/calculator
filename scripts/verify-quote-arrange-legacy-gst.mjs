import assert from "node:assert/strict";
import vm from "node:vm";
import { applyQuoteArrange } from "../lib/quote-arrange.ts";
import { visibleCalculatorData } from "../lib/quote-data-visibility.ts";
import { QUOTE_ARRANGEMENT_KEY, QUOTE_DEF_KEYS, QUOTE_ROW_KEYS, quoteFamilySnapshotViolation } from "../lib/quote-family.ts";
import { mergeCalculatorData } from "../lib/quote-sync.ts";
import { declaration } from "./verify-business-configuration.mjs";

const browser = vm.createContext({
  normalizeCommissionRate: Number,
  commissionRatePercent: (kind) => kind === "agency" ? 20 : 50,
  effectiveCommissionType: () => "agency",
});
const helpers = [
  "quoteFamilyId", "quoteFamilyDefs", "quoteChoiceSnapshot", "normalizeQuoteLocation",
  "savedMiscInc", "savedMaterialsInc", "finiteMoneyNumber", "savedPowerOrElectricianEx",
  "quoteStateDisablesRebates", "savedQuoteStoredRebate", "quoteUsesPowerCost",
  "savedQuoteCommissionType", "savedQuoteAgencyCommissionRate", "savedQuoteSalespersonCommissionRate",
  "salespersonGstRegistered", "recomputeSavedQuote",
];
vm.runInContext(helpers.map((name) => declaration(name)).join("\n"), browser);

const [defKey] = QUOTE_DEF_KEYS;
const [rowKey] = QUOTE_ROW_KEYS;
const optionId = "legacy_option";
const firstId = "legacy_system_one";
const secondId = "legacy_system_two";
const def = { id: optionId, name: "Fixture quote", syncUpdatedAt: 100 };
const legacyRows = [firstId, secondId].map((id, index) => {
  const row = browser.recomputeSavedQuote(browser.normalizeQuoteLocation({
    id, optionId, optionName: def.name, type: "Split", model: `Fixture model ${index + 1}`, install: "New",
    unitInc: 550, finalInc: 1100 + index * 100, labour: 90, materialsInc: 44, miscInc: 22, powerCost: 30,
    rebate: 50, timestamp: 200 + index, syncUpdatedAt: 200 + index,
    salespersonCommission: 10, salespersonCommissionGst: 0,
    state: { ess: { postcode: "2000" }, rebate: "50", ...(index ? { salespersonGstRegistered: false } : {}) },
  }));
  delete row.salespersonGstRegistered;
  return row;
});
const stored = { [defKey]: JSON.stringify([def]), [rowKey]: JSON.stringify(legacyRows) };
const parsedRows = (data) => JSON.parse(data[rowKey]);
const editRows = (data, edit) => ({
  ...data, [rowKey]: JSON.stringify(parsedRows(data).map((row, index) => index ? row : edit(row))),
});

for (const financialsVisible of [false, true]) {
  const bootstrapped = visibleCalculatorData(stored, financialsVisible, true);
  browser.quoteOptionDefs = JSON.parse(bootstrapped[defKey]);
  browser.quotes = parsedRows(bootstrapped).map((row) => browser.recomputeSavedQuote(browser.normalizeQuoteLocation(row)));
  const expected = structuredClone(browser.quoteChoiceSnapshot(optionId));
  assert.deepEqual(expected.rows.map((row) => row.salespersonGstRegistered), [!financialsVisible, false],
    "The masked browser cannot infer from hidden commission fields, but both modes see the saved state flag");
  assert.deepEqual(expected.rows.map((row) => row.syncUpdatedAt), legacyRows.map((row) => row.syncUpdatedAt));

  const incoming = { [defKey]: JSON.stringify(expected.defs), [rowKey]: JSON.stringify(expected.rows) };
  assert.equal(quoteFamilySnapshotViolation(stored, incoming), false);
  const afterFlush = mergeCalculatorData(stored, incoming);
  assert.deepEqual(parsedRows(afterFlush), parsedRows(stored), "The equal-revision preflush keeps the authoritative rows");

  const request = { action: "removeRow", optionId, rowId: firstId, saveId: "legacy_gst_remove", expected };
  const before = structuredClone(request);
  const remove = applyQuoteArrange(afterFlush, request, financialsVisible, 1000);
  assert.ok(!("error" in remove), remove.error);
  assert.deepEqual(request, before, "Comparison must not rewrite the request or receipt input");
  assert.deepEqual(remove.removedRowIds, [firstId]);
  assert.deepEqual(parsedRows(remove.data), [{ ...legacyRows[1], quotePosition: 0, syncUpdatedAt: 1000 }],
    "The survivor's prices, commission, and state stay intact; the inferred root flag is not saved");
  assert.equal(JSON.parse(remove.data[QUOTE_ARRANGEMENT_KEY]).receipts.length, 1);
  const replay = applyQuoteArrange(remove.data, request, financialsVisible, 1100);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.data, remove.data, "An identical retry cannot remove another row");

  const changeExpectedRow = (edit) => ({ ...request, expected: { ...expected, rows: [edit(expected.rows[0]), expected.rows[1]] } });
  const wrongFlag = changeExpectedRow((row) => ({ ...row, salespersonGstRegistered: !row.salespersonGstRegistered }));
  const noFlag = changeExpectedRow(({ salespersonGstRegistered, ...row }) => row);
  const explicit = editRows(afterFlush, (row) => ({ ...row, salespersonGstRegistered: !expected.rows[0].salespersonGstRegistered }));
  for (const [data, payload, label] of [
    [afterFlush, wrongFlag, "wrong inferred flag"],
    [afterFlush, changeExpectedRow((row) => ({ ...row, salespersonGstRegistered: String(row.salespersonGstRegistered) })), "non-boolean flag"],
    [explicit, request, "changed explicit flag"],
    [explicit, noFlag, "omitted explicit flag"],
    [afterFlush, changeExpectedRow((row) => ({ ...row, state: { ...row.state, salespersonGstRegistered: true } })), "nested state GST edit"],
    [editRows(afterFlush, (row) => ({ ...row, finalInc: row.finalInc + 1 })), request, "same-revision price change"],
    [editRows(afterFlush, (row) => ({ ...row, syncUpdatedAt: row.syncUpdatedAt + 1 })), request, "newer revision"],
    [editRows(afterFlush, (row) => ({ ...row, quotePosition: 1 })), request, "changed position"],
    [{ ...afterFlush, [defKey]: JSON.stringify([{ ...def, wonAt: "2026-01-01T00:00:00Z" }]) }, request, "won option lock"],
    [editRows(afterFlush, (row) => ({ ...row, wonAt: "2026-01-01T00:00:00Z" })), request, "won row lock"],
    [{ ...afterFlush, installerQuoteSyncTombstonesV1: JSON.stringify({ rows: { [firstId]: 900 } }) }, request, "row tombstone"],
    [remove.data, noFlag, "same receipt token with a changed request"],
  ]) {
    const untouched = structuredClone(data);
    assert.equal(applyQuoteArrange(data, payload, financialsVisible, 1100).status, 409, label);
    assert.deepEqual(data, untouched, label);
  }

  for (const action of ["addOption", "moveRow", "duplicateOption"]) {
    const fields = action === "moveRow" ? { rowId: secondId, beforeRowId: firstId } : {};
    const arranged = applyQuoteArrange(afterFlush, { action, optionId, saveId: `legacy_${action}`, expected, ...fields }, financialsVisible, 1000);
    assert.ok(!("error" in arranged), arranged.error);
    const arrangedRows = parsedRows(arranged.data);
    assert.ok(arrangedRows.every((row) => !Object.hasOwn(row, "salespersonGstRegistered")));
    assert.equal(arrangedRows.length, action === "duplicateOption" ? 4 : 2);
    if (action === "moveRow") assert.equal(arrangedRows.find((row) => row.id === secondId).quotePosition, 0);
  }
}

console.log("Legacy GST arrange verified in both visibility modes: real browser normalization, strict conflicts, and idempotent removal.");
