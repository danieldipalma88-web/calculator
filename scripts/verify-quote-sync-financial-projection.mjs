import assert from "node:assert/strict";
import { test } from "node:test";
import { applyQuoteLibraryEdit, quoteLibraryResponseRow } from "../lib/quote-library-edit.ts";
import { mergeCalculatorData } from "../lib/quote-sync.ts";
import { visibleCalculatorData } from "../lib/quote-data-visibility.ts";

const rowKeys = ["installerMasterQuoteLogV1", "greenEnergyMasterQuoteLogV1", "MasterQuoteLogV1"];
const defsKey = "installerQuoteOptionDefsV1";
const backupsKey = "installerSavedQuoteSetsV1";
const clone = value => structuredClone(value);
const rows = (data, key = rowKeys[0]) => typeof data[key] === "string" ? JSON.parse(data[key]) : data[key];
const source = {
  id: "rinnai-system", optionId: "customer-quote", type: "Split", model: "Fixture Rinnai",
  timestamp: 100, syncUpdatedAt: 100, unitInc: 1100, finalInc: 3300, labour: 200,
  materialsInc: 110, miscInc: 22, powerCost: 80, rebate: 123.456789, labourTreatment: "Retained",
  commissionType: "agency", commissionModelOn: true, commissionRate: 25, agencyCommissionRate: 25,
  salespersonCommissionRate: 50, salespersonGstRegistered: false,
  state: { systemType: "split", model: "Fixture Rinnai", postcode: "2208", businessId: "original-business",
    rebate: "123.456789", rebatesEnabled: true, commissionType: "agency", commissionModelOn: true,
    agencyCommissionRate: 25, salespersonCommissionRate: 50, salespersonGstRegistered: false },
};
const initial = {
  [rowKeys[0]]: JSON.stringify([source]),
  [defsKey]: JSON.stringify([{ id: source.optionId, name: "Fixture customer", syncUpdatedAt: 100 }]),
};
function edit(data, prior, finalInc, now, saveId) {
  const expectedRow = quoteLibraryResponseRow(prior, false, true);
  const result = applyQuoteLibraryEdit(data, {
    rowId: prior.id, optionId: prior.optionId, expectedRow, row: { ...clone(expectedRow), finalInc }, saveId,
  }, false, now);
  assert.ok(!("error" in result), result.error);
  return result;
}
const edited = edit(initial, source, 4400, 1000, "fixture-edit-save-0001");
const projected = quoteLibraryResponseRow(edited.row, false, true);
const wonFields = {
  wonAt: "2026-11-26T04:00:00.000Z", wonByEmail: "fixture@example.test", wonByName: "Fixture salesperson",
  installationAddress: "Fixture NSW address", googlePlaceId: "fixture-place",
  installationLatitude: -33, installationLongitude: 151, proposedInstallationDate: "2026-12-10",
};
function mergeRow(storedRow, incomingRow) {
  return rows(mergeCalculatorData({ [rowKeys[0]]: JSON.stringify([storedRow]) }, {
    [rowKeys[0]]: JSON.stringify([incomingRow]),
  }))[0];
}
function assertFinancials(actual, expected) {
  for (const [left, right] of [[actual, expected], [actual.state, expected.state]]) {
    for (const key of Object.keys(right).filter(key => /commission|profit|margin/i.test(key))) {
      assert.deepEqual(left[key], right[key], `Stored financial field survives projection: ${key}`);
    }
  }
}

test("real limited edit response survives a newer first-win snapshot", () => {
  assert.equal(projected.quoteLibraryEditSaveId, edited.row.quoteLibraryEditSaveId);
  assert.equal(projected.quoteLibraryEditFingerprint, edited.row.quoteLibraryEditFingerprint);
  assert.equal(projected.agencyCommissionInc, undefined);
  assert.equal(projected.state.commissionType, undefined);
  assert.equal(projected.state.agencyCommissionRate, undefined);
  assert.equal(projected.netProfit, edited.row.netProfit);
  assert.equal(projected.salespersonCommissionInc, edited.row.salespersonCommissionInc);
  const incoming = { ...clone(projected), ...wonFields, syncUpdatedAt: 2000 };
  const before = clone(incoming);
  const result = mergeRow(edited.row, incoming);
  assertFinancials(result, edited.row);
  assert.deepEqual(result, { ...edited.row, ...wonFields, syncUpdatedAt: 2000 },
    "The actual restricted edit response loses only private financials, not saved pricing or edit metadata");
  for (const [key, value] of Object.entries(wonFields)) assert.deepEqual(result[key], value);
  assert.equal(result.syncUpdatedAt, 2000);
  assert.deepEqual(incoming, before, "Do not mutate the client projection");
});

test("complete snapshots skip financial context canonicalization", () => {
  const pricingContext = Object.defineProperty({}, "value", {
    enumerable: true,
    get() { assert.fail("Complete financial snapshots must not traverse pricing context"); },
  });
  const stored = { ...edited.row, state: { ...edited.row.state, pricingContext } };
  const incoming = { ...stored, syncUpdatedAt: 2000 };
  const result = mergeCalculatorData({ [rowKeys[0]]: [stored] }, { [rowKeys[0]]: [incoming] });
  assert.equal(result[rowKeys[0]][0].syncUpdatedAt, 2000);
  assert.equal(result[rowKeys[0]][0].state.pricingContext, pricingContext);
});

test("draft projections need no edit receipt and support both visibility levels", () => {
  const stored = clone(edited.row);
  delete stored.quoteLibraryEditSaveId;
  delete stored.quoteLibraryEditFingerprint;
  for (const canSeeSales of [false, true]) {
    const incoming = { ...quoteLibraryResponseRow(stored, false, canSeeSales), syncUpdatedAt: 2000 };
    const result = mergeRow(stored, incoming);
    assertFinancials(result, stored);
    assert.equal(result.wonAt, undefined);
  }
});

test("changed or incomplete pricing/context cannot revive omitted financials", () => {
  const changes = [
    ...["unitInc", "finalInc", "labour", "materialsInc", "miscInc", "powerCost", "rebate"].map(key => row => { row[key] += 1; }),
    row => { row.labourTreatment = "Expense"; }, row => { row.model = "Other model"; },
    row => { row.optionId = "another-quote"; }, row => { row.state.postcode = "2000"; },
    row => { row.state.businessId = "another-business"; }, row => { row.state.rebatesEnabled = false; },
    row => { row.state.unitPriceInc = "9999"; }, row => { row.state.airtouch = "yes"; },
    row => { delete row.unitInc; }, row => { delete row.state; }, row => { row.state = "malformed"; },
    row => { row.netProfit += 1; }, row => { row.salespersonCommissionInc += 1; },
    row => { row.agencyCommissionRate = 99; }, row => { row.state.commissionType = "none"; },
  ];
  for (const change of changes) {
    const incoming = { ...clone(projected), syncUpdatedAt: 2000 };
    change(incoming);
    assert.deepEqual(mergeRow(edited.row, incoming), incoming, "Nonmatching context keeps ordinary versioned merge behavior");
  }
  const incomplete = clone(edited.row);
  delete incomplete.unitInc;
  assert.equal(mergeRow(incomplete, { ...quoteLibraryResponseRow(incomplete, false, true), syncUpdatedAt: 2000 }).agencyCommissionInc,
    undefined, "Incomplete stored pricing is not an authoritative restoration context");
});

test("authorized pricing and financial edits remain authoritative", () => {
  const second = edit(edited.data, edited.row, 5500, 3000, "fixture-edit-save-0002");
  assert.notEqual(second.row.agencyCommissionInc, edited.row.agencyCommissionInc);
  assert.deepEqual(mergeRow(edited.row, second.row), second.row);
  assertFinancials(mergeRow(second.row, { ...quoteLibraryResponseRow(second.row, false, true), syncUpdatedAt: 4000 }), second.row);
  assert.deepEqual(mergeRow(second.row, { ...clone(projected), syncUpdatedAt: 2000 }), second.row);
  const changedSavedAmount = { ...clone(projected), ...wonFields, syncUpdatedAt: 4000 };
  assert.deepEqual(mergeRow(second.row, changedSavedAmount), changedSavedAmount,
    "A newer win with older saved amounts must not attach financials from different stored pricing");
  const authorized = { ...clone(edited.row), agencyCommissionRate: 30, syncUpdatedAt: 2000 };
  assert.deepEqual(mergeRow(edited.row, authorized), authorized);
});

test("won commission lock and explicit unlock semantics remain unchanged", () => {
  const locked = { ...clone(edited.row), ...wonFields, syncUpdatedAt: 2000 };
  const incoming = { ...clone(locked), finalInc: 9999, agencyCommissionInc: 1, salespersonCommissionInc: 2,
    state: { ...locked.state, agencyCommissionRate: 99 }, syncUpdatedAt: 3000 };
  const result = mergeRow(locked, incoming);
  assert.equal(result.agencyCommissionInc, locked.agencyCommissionInc);
  assert.equal(result.salespersonCommissionInc, locked.salespersonCommissionInc);
  assert.equal(result.state.agencyCommissionRate, locked.state.agencyCommissionRate);
  assert.equal(result.finalInc, 9999, "Do not broaden the existing won commission lock to prices");
  const unlocked = { ...clone(projected), syncUpdatedAt: 4000 };
  assert.deepEqual(mergeRow(locked, unlocked), unlocked, "Do not reapply locked financials across an unlock");
});

test("aliases, immutable backups, and response secrecy remain intact", () => {
  for (const asString of [true, false]) {
    const store = value => asString ? JSON.stringify(value) : value;
    const backup = { id: "intact-backup", quotes: [clone(edited.row)] };
    const data = { [defsKey]: store([{ id: source.optionId, name: "Fixture customer", syncUpdatedAt: 100 }]),
      [backupsKey]: store([backup]) };
    const incoming = { [backupsKey]: store([{ id: backup.id, quotes: [] }]) };
    for (const key of rowKeys) {
      data[key] = store([edited.row]);
      incoming[key] = store([{ ...clone(projected), ...wonFields, syncUpdatedAt: 2000 }]);
    }
    const before = clone(data);
    const result = mergeCalculatorData(data, incoming);
    for (const key of rowKeys) assertFinancials(rows(result, key)[0], edited.row);
    assert.deepEqual(rows(result, backupsKey), [backup]);
    assert.deepEqual(data, before, "Preservation does not mutate stored rows or backups");
    for (const canSeeSales of [false, true]) {
      const restricted = visibleCalculatorData(result, false, canSeeSales);
      assert.ok(!JSON.stringify(restricted).includes("agencyCommission"));
      for (const key of rowKeys) {
        const publicRow = rows(restricted, key)[0];
        assert.equal(publicRow.state.commissionType, undefined);
        assert.equal(publicRow.netMargin, undefined);
        assert.equal(publicRow.salespersonCommissionInc, canSeeSales ? edited.row.salespersonCommissionInc : undefined);
        assert.equal(publicRow.netProfit, canSeeSales ? edited.row.netProfit : undefined);
      }
      assert.deepEqual(quoteLibraryResponseRow(rows(result)[0], false, canSeeSales),
        { ...quoteLibraryResponseRow(edited.row, false, canSeeSales), ...wonFields, syncUpdatedAt: 2000 });
    }
  }
});
