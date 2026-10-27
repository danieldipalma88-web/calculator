import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { mergeCalculatorData } from "../lib/quote-sync.ts";
import { applyStoredQuoteAdminUnlocks, quoteFamilySnapshotViolation, quoteFamilySnapshotConflict, quoteFamilyUnlockRequested } from "../lib/quote-family.ts";
import { applyQuoteLibraryCopy, applyQuoteLibraryEdit, quoteLibraryResponseRow, quoteLibraryVisibleRow } from "../lib/quote-library-edit.ts";
import { canManageUsers, canSeeCommissionDetails, canSeeProfitDetails, isOwnerEmail } from "../lib/admin.ts";

const rowsKey = "installerMasterQuoteLogV1";
const optionsKey = "installerQuoteOptionDefsV1";
const backupsKey = "installerSavedQuoteSetsV1";
const tombstonesKey = "installerQuoteSyncTombstonesV1";
const clone = value => JSON.parse(JSON.stringify(value));
const original = {
  id: "row-a", optionId: "quote-a", model: "EXACT-MODEL", brand: "Brand", type: "Split",
  timestamp: 100, syncUpdatedAt: 100, unitInc: 1100, finalInc: 3300, labour: 200,
  materialsInc: 110, miscInc: 22, powerCost: 80, labourTreatment: "Retained", rebate: 123.456789,
  commissionType: "agency", agencyCommissionRate: 25, salespersonCommissionRate: 50,
  salespersonGstRegistered: false, privateExtension: { keep: [1, 2] },
  state: { model: "EXACT-MODEL", postcode: "2208", rebate: "123.456789", businessId: "original-business",
    commissionType: "agency", agencyCommissionRate: 25, salespersonCommissionRate: 50, rebatesEnabled: true },
};
function snapshot(row = original) {
  return { [rowsKey]: JSON.stringify([row, { ...original, id: "unrelated" }]),
    [optionsKey]: JSON.stringify([{ id: "quote-a", name: "Customer", syncUpdatedAt: 100 }]), unknownStorage: "unchanged" };
}
function request(row = original, changes = { finalInc: 4400 }, visible = true) {
  const expectedRow = clone(quoteLibraryVisibleRow(row, visible));
  return { rowId: row.id, optionId: row.optionId, expectedRow, row: { ...clone(expectedRow), ...changes } };
}
function success(result) {
  assert.ok(!("error" in result), result.error);
  return result;
}

for (const key of [backupsKey, "greenEnergySavedQuoteSetsV1", "SavedQuoteSetsV1"]) {
  const a = { id: "a", quotes: [{ id: "old", wonAt: "2026-01-01" }], unknown: true };
  const b = { id: "b", quotes: [{ id: "new" }] };
  let data = { [key]: JSON.stringify([a]) };
  data = mergeCalculatorData(data, { [key]: JSON.stringify([b]) });
  data = mergeCalculatorData(data, { [key]: JSON.stringify([{ ...a, quotes: [] }]) });
  data = mergeCalculatorData(data, { [key]: "[]" });
  data = mergeCalculatorData(data, { [key]: "malformed" });
  assert.deepEqual(JSON.parse(data[key]), [a, b], "Old clients cannot delete or replace immutable backups");
  const many = Array.from({ length: 150 }, (_, id) => ({ id: `backup-${id}` }));
  assert.equal(JSON.parse(mergeCalculatorData(data, { [key]: JSON.stringify(many) })[key]).length, 152);
  const legacy = { quotes: [{ id: "legacy" }] };
  const legacyData = mergeCalculatorData({ [key]: JSON.stringify([legacy]) }, { [key]: JSON.stringify([legacy, b]) });
  assert.deepEqual(JSON.parse(legacyData[key]), [legacy, b]);
}

const data = snapshot();
const wonData = {
  [rowsKey]: JSON.stringify([{ ...original, wonAt: "2026-01-01", syncUpdatedAt: 200 }]),
  [optionsKey]: JSON.stringify([{ id: "quote-a", wonAt: "2026-01-01", syncUpdatedAt: 200 }]),
};
const restoreTombstones = { [rowsKey]: "[]", [optionsKey]: "[]", [tombstonesKey]: JSON.stringify({
  rows: { "row-a": 300 }, options: { "quote-a": 300 },
}) };
const preservedWon = mergeCalculatorData(wonData, restoreTombstones);
assert.equal(JSON.parse(preservedWon[rowsKey])[0].wonAt, "2026-01-01");
assert.equal(JSON.parse(preservedWon[optionsKey])[0].wonAt, "2026-01-01", "Legacy restore cannot tombstone a won definition");
const staleRemoval = mergeCalculatorData(wonData, { ...restoreTombstones, [rowsKey]: JSON.stringify([original]),
  [optionsKey]: JSON.stringify([{ id: "quote-a", syncUpdatedAt: 100 }]) });
assert.equal(JSON.parse(staleRemoval[rowsKey])[0].wonAt, "2026-01-01", "A stale client removal cannot erase a newer won system");
assert.equal(JSON.parse(staleRemoval[optionsKey])[0].wonAt, "2026-01-01");
const unlocked = mergeCalculatorData(preservedWon, {
  [rowsKey]: JSON.stringify([{ ...original, syncUpdatedAt: 400 }]),
  [optionsKey]: JSON.stringify([{ id: "quote-a", syncUpdatedAt: 400 }]),
});
const deletedAfterUnlock = mergeCalculatorData(unlocked, { [rowsKey]: "[]", [optionsKey]: "[]",
  [tombstonesKey]: JSON.stringify({ rows: { "row-a": 500 }, options: { "quote-a": 500 } }),
});
assert.deepEqual(JSON.parse(deletedAfterUnlock[rowsKey]), []);
assert.deepEqual(JSON.parse(deletedAfterUnlock[optionsKey]), [], "An explicitly unlocked quote can subsequently be deleted");
const parentOnlyWon = { ...snapshot(),
  [rowsKey]: JSON.stringify([original]),
  [optionsKey]: JSON.stringify([{ id: "quote-a", wonAt: "2026-10-01", syncUpdatedAt: 200 }]),
};
for (const incoming of [restoreTombstones, Object.fromEntries(Object.entries(restoreTombstones).reverse()),
  { [rowsKey]: "[]", [tombstonesKey]: JSON.stringify({ rows: { "row-a": 300 } }) },
]) {
  const preserved = mergeCalculatorData(parentOnlyWon, incoming);
  assert.equal(JSON.parse(preserved[rowsKey]).length, 1, "A parent-only won lock protects its system from a newer tombstone");
  assert.equal(JSON.parse(preserved[optionsKey])[0].wonAt, "2026-10-01");
}
const parentOnlyPreserved = mergeCalculatorData(parentOnlyWon, restoreTombstones);
const parentOnlyUnlocked = mergeCalculatorData(parentOnlyPreserved, {
  [rowsKey]: JSON.stringify([{ ...original, syncUpdatedAt: 400 }]),
  [optionsKey]: JSON.stringify([{ id: "quote-a", syncUpdatedAt: 400 }]),
});
const parentOnlyDeleted = mergeCalculatorData(parentOnlyUnlocked, { [rowsKey]: "[]", [optionsKey]: "[]",
  [tombstonesKey]: JSON.stringify({ rows: { "row-a": 500 }, options: { "quote-a": 500 } }),
});
assert.deepEqual(JSON.parse(parentOnlyDeleted[rowsKey]), []);
assert.deepEqual(JSON.parse(parentOnlyDeleted[optionsKey]), []);
const concurrentParentWon = mergeCalculatorData(snapshot(), {
  [rowsKey]: JSON.stringify([original]),
  [tombstonesKey]: JSON.stringify({ rows: { "row-a": 300 } }),
  [optionsKey]: JSON.stringify([{ id: "quote-a", wonAt: "2026-10-01", syncUpdatedAt: 200 }]),
});
assert.ok(JSON.parse(concurrentParentWon[rowsKey]).some(row => row.id === original.id), "An incoming parent win must protect rows before processing deletions");
const before = clone(data);
const edited = success(applyQuoteLibraryEdit(data, request(), true, 1000));
assert.deepEqual(data, before, "Pure edit must not mutate input data");
assert.equal(edited.row.finalInc, 4400);
assert.equal(edited.row.syncUpdatedAt, 1000);
assert.equal(edited.row.quoteLibraryEditVersion, undefined);
assert.equal(edited.row.rebate, original.rebate);
for (const key of Object.keys(original.state)) assert.deepEqual(edited.row.state[key], original.state[key], `Protected state field: ${key}`);
assert.equal(edited.row.state.finalInc, "4400");
assert.deepEqual(edited.row.privateExtension, original.privateExtension);
assert.deepEqual(JSON.parse(edited.data[rowsKey])[1], JSON.parse(data[rowsKey])[1]);
assert.equal(edited.data.unknownStorage, data.unknownStorage);
assert.equal(applyQuoteLibraryEdit(edited.data, request(), true).status, 409);
assert.equal(success(applyQuoteLibraryEdit(data, request(), true, 1)).row.syncUpdatedAt, 101, "Versions cannot go backwards");
assert.equal(applyQuoteLibraryEdit(data, request(original, { finalInc: 4400, netProfit: 999999 }), true).status, 422,
  "Client derived money cannot be changed");

for (const changes of [
  { model: "OTHER" }, { brand: "OTHER" }, { rebate: 0 }, { agencyCommissionRate: 99 },
  { wonAt: "2026-01-01" }, { syncUpdatedAt: 9999999 }, { optionId: "another" },
  { state: { ...original.state, postcode: "2000" } }, { state: { ...original.state, rebate: "0" } },
  { state: { ...original.state, businessId: "another" } }, { privateExtension: {} },
  { labourTreatment: "Anything" }, { labourTreatment: ["Retained"] }, { unitInc: -1 }, { finalInc: Infinity }, { miscInc: "5" },
]) assert.equal(applyQuoteLibraryEdit(data, request(original, changes), true).status, 422, JSON.stringify(changes));
const missingExpectedField = request();
delete missingExpectedField.expectedRow.privateExtension;
assert.equal(applyQuoteLibraryEdit(data, missingExpectedField, true).status, 409);
assert.equal(applyQuoteLibraryEdit({}, request(), true).status, 409);
for (const change of [
  { [rowsKey]: JSON.stringify([{ ...original, wonAt: "2026-01-01" }]) },
  { [optionsKey]: JSON.stringify([{ id: "quote-a", wonAt: "2026-01-01" }]) },
  { [optionsKey]: "[]" },
  { [tombstonesKey]: JSON.stringify({ rows: { "row-a": 999 }, options: {} }) },
  { [tombstonesKey]: JSON.stringify({ rows: {}, options: { "quote-a": 999 } }) },
  { greenEnergyMasterQuoteLogV1: JSON.stringify([{ ...original, finalInc: 999 }]) },
]) assert.equal(applyQuoteLibraryEdit({ ...data, ...change }, request(), true).status, 409);
const sanitized = success(applyQuoteLibraryEdit(data, request(original, { finalInc: 4400 }, false), false));
const visible = quoteLibraryVisibleRow(sanitized.row, false);
assert.equal(visible.agencyCommission, undefined);
assert.equal(visible.state.agencyCommissionRate, undefined);
assert.equal(visible.netProfit, undefined);
assert.equal(sanitized.row.agencyCommissionRate, original.agencyCommissionRate);

for (const incoming of [original, { ...original, syncUpdatedAt: 999, finalInc: 1 }]) {
  const merged = mergeCalculatorData(edited.data, { [rowsKey]: JSON.stringify([incoming]) });
  assert.deepEqual(JSON.parse(merged[rowsKey])[0], edited.row, "Stale autosave cannot undo an explicit edit");
  assert.equal(JSON.parse(merged[rowsKey]).length, 2);
}
const deliberateLegacyWon = { ...original, syncUpdatedAt: 1001, wonAt: "2026-01-01", finalInc: 4400 };
assert.equal(JSON.parse(mergeCalculatorData(edited.data, { [rowsKey]: JSON.stringify([deliberateLegacyWon]) })[rowsKey])[0].wonAt,
  deliberateLegacyWon.wonAt, "Newer deliberate legacy actions retain existing merge semantics");
const secondEdit = success(applyQuoteLibraryEdit(edited.data, request(edited.row, { labour: 500 }), true, 1001));
assert.deepEqual(JSON.parse(mergeCalculatorData(secondEdit.data, edited.data)[rowsKey])[0], secondEdit.row);

const idempotentRequest = { ...request(), saveId: "test-save-12345678" };
const first = success(applyQuoteLibraryEdit(data, idempotentRequest, true, 1000));
assert.deepEqual(success(applyQuoteLibraryEdit(first.data, idempotentRequest, true, 2000)).row, first.row);
assert.equal(applyQuoteLibraryEdit(first.data, { ...idempotentRequest, row: { ...idempotentRequest.row, finalInc: 5500 } }, true).status, 409);
assert.equal(applyQuoteLibraryEdit(data, { ...request(), saveId: "bad" }, true).status, 422);
const afterAnotherEdit = success(applyQuoteLibraryEdit(first.data, request(first.row, { finalInc: 5500 }), true, 2000));
assert.equal(applyQuoteLibraryEdit(afterAnotherEdit.data, idempotentRequest, true).status, 409);

for (const type of ["Split", "Ducted", "Multi-head Split"]) {
  const multi = type === "Multi-head Split";
  const row = { ...clone(original), type, addonLabour: multi ? 0 : 40, addonMaterialsInc: multi ? 0 : 11 };
  const changes = { unitInc: multi ? row.unitInc : 2200, finalInc: 4400, labour: 400, materialsInc: 220, miscInc: 55, powerCost: 90, labourTreatment: "Expense" };
  const result = success(applyQuoteLibraryEdit(snapshot(row), request(row, changes), true));
  const state = result.row.state;
  assert.equal(Number(state.unitPriceInc), changes.unitInc);
  assert.equal(Number(state.finalInc), changes.finalInc);
  assert.equal(Number(state.labour) + row.addonLabour, changes.labour, `${type}: load/add must not double count add-on labour`);
  assert.equal(Number(state.materials) + row.addonMaterialsInc, changes.materialsInc, `${type}: load/add must not double count add-on materials`);
  assert.equal(Number(state.misc), changes.miscInc);
  assert.equal(Number(state[multi ? "multiPower" : type === "Split" ? "powerCircuit" : "electrician"]), changes.powerCost);
  assert.equal(state.installerRetainsLabour, false);
  if (multi) assert.equal(Number(state.powerCircuit), changes.powerCost);
  else assert.equal(state[type === "Split" ? "splitInstallerRetainsLabour" : "ductedInstallerRetainsLabour"], false);
  if (type === "Split") assert.equal(state.powerMode, "on");
  const mirrored = request(row, { ...changes, state: clone(state), installerRetainsLabour: false });
  assert.equal(applyQuoteLibraryEdit(snapshot(row), mirrored, true).status, 422, "Even correct client-side derived aliases must remain untouched in the request");
  const mismatched = request(row, { ...changes, state: { ...state, labour: "99999" } });
  assert.equal(applyQuoteLibraryEdit(snapshot(row), mismatched, true).status, 422);
}
const addonRow = { ...original, addonLabour: 300, addonMaterialsInc: 200 };
assert.equal(applyQuoteLibraryEdit(snapshot(addonRow), request(addonRow), true).status, 422);
for (const [type, systemType] of [["Multi-head Split", undefined], ["Multi Split", undefined], ["Multi_head", undefined], ["Split", "multi_split"]]) {
  const row = { ...clone(original), type, unitInc: 2200,
    state: { ...original.state, ...(systemType ? { systemType } : {}), unitPriceInc: "2200" } };
  const source = snapshot(row);
  const sourceBefore = clone(source);
  const rejected = applyQuoteLibraryEdit(source, request(row, { unitInc: 2300 }), true);
  assert.equal(rejected.status, 422, `${type}/${systemType}: aggregate equipment edits must be rejected`);
  assert.match(rejected.error, /Multi-head equipment-price edits/);
  const accepted = success(applyQuoteLibraryEdit(source, request(row, { finalInc: 4400, labour: 400,
    materialsInc: 220, miscInc: 55, powerCost: 90, labourTreatment: "Expense" }), true));
  assert.equal(accepted.row.unitInc, 2200, "An unchanged multi-head equipment total stays exact while other costs change");
  assert.equal(accepted.row.finalInc, 4400);
  assert.deepEqual(source, sourceBefore);
}

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).sort((a, b) => b.length - a.length)[0];
const uiAst = ts.createSourceFile("ui.js", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const recomputeNode = uiAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "recomputeSavedQuote");
assert.ok(recomputeNode);
const client = {
  savedMaterialsInc: row => row.materialsInc, savedMiscInc: row => row.miscInc,
  quoteUsesPowerCost: row => row.type !== "Ducted", savedPowerOrElectricianEx: row => row.powerCost,
  savedQuoteStoredRebate: row => Number(row.rebate), quoteStateDisablesRebates: () => false,
  savedQuoteCommissionType: row => row.commissionType,
  savedQuoteAgencyCommissionRate: row => row.agencyCommissionRate,
  savedQuoteSalespersonCommissionRate: row => row.salespersonCommissionRate,
  salespersonGstRegistered: row => row.salespersonGstRegistered,
};
vm.runInNewContext(recomputeNode.getText(uiAst), client);
for (const type of ["Split", "Ducted", "Multi-head Split"]) {
  for (const commissionType of ["none", "standard", "agency"]) {
    for (const registered of [true, false]) {
      const row = { ...clone(original), type, commissionType, salespersonGstRegistered: registered,
        state: { ...original.state, commissionType, airtouch: "yes", sensors: 2, zones: 4 } };
      const server = success(applyQuoteLibraryEdit(snapshot(row), request(row), true)).row;
      const local = client.recomputeSavedQuote({ ...clone(row), finalInc: 4400 });
      for (const field of ["matsEx", "otherEx", "trueCost", "cashProfit", "agencyCommissionInc", "salespersonCommissionInc", "commissionInc", "netProfit", "netMargin"]) {
        assert.ok(Math.abs(server[field] - local[field]) < 1e-9, `${type}/${commissionType}/${registered}: ${field}`);
      }
    }
  }
}

const api = await readFile(new URL("../app/api/calculator-data/route.ts", import.meta.url), "utf8");
const raw = await readFile(new URL("../app/calculator/raw/route.ts", import.meta.url), "utf8");
const rawAst = ts.createSourceFile("raw.ts", raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const injection = rawAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "injectCloudStorageSync");
assert.ok(injection);
const syncUrlSource = injection.body.statements.slice(0, 2).map(node => node.getText(rawAst)).join("\n");
for (const [userContext, expectedUrl] of [
  [{ email: "admin@test", viewingEmail: "sales+one@test", businessId: "business one", isPreviewMode: true },
    "/api/calculator-data?as=sales%2Bone%40test&businessId=business%20one&preview=1"],
  [{ email: "admin@test", viewingEmail: "sales@test", businessId: "business", isPreviewMode: false },
    "/api/calculator-data?as=sales%40test&businessId=business"],
  [{ email: "sales@test", viewingEmail: "sales@test", businessId: null, isPreviewMode: false }, "/api/calculator-data"],
]) {
  const sandbox = { userContext };
  vm.runInNewContext(ts.transpile(`${syncUrlSource}\nglobalThis.result = syncUrl;`, { target: ts.ScriptTarget.ES2020 }), sandbox);
  assert.equal(sandbox.result, expectedUrl, "Raw mutation URL preserves server-derived preview, profile and business context");
}
assert.ok(raw.includes("var calculatorSyncUrl = ${safeScriptJson(syncUrl)};"));
const ast = ts.createSourceFile("route.ts", api, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const context = { mergeCalculatorData, applyStoredQuoteAdminUnlocks, quoteFamilySnapshotViolation, quoteFamilySnapshotConflict, quoteFamilyUnlockRequested, applyQuoteLibraryCopy, applyQuoteLibraryEdit, quoteLibraryResponseRow, quoteLibraryVisibleRow,
  validateNewWonJobTransitions: () => ({ valid: true }), wonJobValidationMessage: () => "Invalid won job",
};
for (const name of ["storedValueHasData", "calculatorDataHasData", "saveMergedUserData"]) {
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(fn, name);
  vm.runInNewContext(ts.transpile(fn.getText(ast), { target: ts.ScriptTarget.ES2020 }), context);
}
function mockProfile(initial, race) {
  let stored = { user_id: "user-1", data: clone(initial), updated_at: "2026-01-01T00:00:00.000Z" };
  let writes = 0, attempts = 0;
  return {
    from(table) {
      assert.equal(table, "user_calculator_data");
      let expectedVersion, candidate;
      return {
        select() { return this; },
        eq(key, value) { if (key === "updated_at") expectedVersion = value; return this; },
        is(key, value) { if (key === "updated_at") expectedVersion = value; return this; },
        async maybeSingle() { return { data: clone(stored), error: null }; },
        update(value) {
          candidate = clone(value);
          return { eq: this.eq.bind(this), is: this.is.bind(this), select: async () => {
            attempts++;
            if (attempts === 1 && race) stored = race(clone(stored));
            if (expectedVersion !== stored.updated_at) return { data: [], error: null };
            assert.ok(Date.parse(candidate.updated_at) > Date.parse(stored.updated_at));
            stored = { ...stored, ...candidate }; writes++;
            return { data: [{ user_id: stored.user_id }], error: null };
          } };
        },
      };
    },
    get stored() { return stored; }, get writes() { return writes; },
  };
}
// The update mock must keep fluent filters on the update builder.
function profile(initial, race) {
  const db = mockProfile(initial, race);
  const from = db.from.bind(db);
  db.from = table => {
    const query = from(table);
    const update = query.update.bind(query);
    query.update = value => {
      const builder = update(value);
      const eq = builder.eq, is = builder.is;
      builder.eq = (...args) => { eq(...args); return builder; };
      builder.is = (...args) => { is(...args); return builder; };
      return builder;
    };
    return query;
  };
  return db;
}
const clean = profile(data);
const saved = await context.saveMergedUserData(clean, "user@example.test", "user-1", {}, false, request(), true);
assert.ok(saved.row, saved.error);
assert.equal(clean.writes, 1);
assert.equal(saved.row.finalInc, 4400);
const changed = profile(data, stored => ({ ...stored, updated_at: "2026-01-02T00:00:00.000Z",
  data: snapshot({ ...original, finalInc: 9999, syncUpdatedAt: 500 }) }));
assert.equal((await context.saveMergedUserData(changed, "u", "user-1", {}, false, request(), true)).status, 409);
assert.equal(changed.writes, 0, "Concurrent edits must not be overwritten");
const wonRace = profile(data, stored => ({ ...stored, updated_at: "2026-01-02T00:00:00.000Z", data: {
  ...stored.data, [optionsKey]: JSON.stringify([{ id: "quote-a", wonAt: "2026-01-02" }]),
} }));
assert.equal((await context.saveMergedUserData(wonRace, "u", "user-1", {}, false, request(), true)).status, 409);
assert.equal(wonRace.writes, 0);
const unrelatedRace = profile(data, stored => ({ ...stored, updated_at: "2026-01-02T00:00:00.000Z",
  data: { ...stored.data, anotherKey: "concurrent-value" } }));
assert.ok((await context.saveMergedUserData(unrelatedRace, "u", "user-1", {}, false, request(), true)).row);
assert.equal(unrelatedRace.stored.data.anotherKey, "concurrent-value");
const deleteRace = profile(data, stored => ({ ...stored, updated_at: "2026-01-02T00:00:00.000Z", data: {
  ...stored.data, [rowsKey]: "[]", [tombstonesKey]: JSON.stringify({ rows: { "row-a": 500 }, options: {} }),
} }));
assert.equal((await context.saveMergedUserData(deleteRace, "u", "user-1", {}, false, request(), true)).status, 409);
assert.equal(deleteRace.writes, 0);
const normalSave = profile(edited.data);
assert.equal((await context.saveMergedUserData(normalSave, "u", "user-1", snapshot(original), false)).ok, true);
assert.equal(JSON.parse(normalSave.stored.data[rowsKey])[0].finalInc, 4400);
assert.match(api, /if \(approvedUser\.is_locked\)/);
assert.match(api, /const viewingEmail = targetEmailFromRequest/);
assert.match(api, /sanitizeIncomingCalculatorData\(/);
assert.match(api, /Send quote mutations separately from each other and calculator snapshots/);

function endpointHarness({ role = "admin", targetRole = "user", email = "admin@example.test", targetError = null, initial = data } = {}) {
  const db = profile(initial);
  db.auth = { getUser: async () => ({ data: { user: { id: "user-1", email } } }) };
  const endpoint = {
    URL, canManageUsers, canSeeCommissionDetails, canSeeProfitDetails, isOwnerEmail,
    NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) },
    createSupabaseServerClient: async () => db,
    currentApprovedUser: async (_db, requested) => requested === email
      ? { data: { role }, error: null } : { data: { role: targetRole }, error: targetError },
    resolveBusinessId: async () => null,
    sanitizeIncomingCalculatorData: value => value,
    stripCertificateValueKeys: value => value,
    splitCalculatorDataByScope: value => ({ userData: value, businessData: {} }),
    calculatorDataHasData: context.calculatorDataHasData,
    saveMergedUserData: context.saveMergedUserData,
  };
  for (const name of ["targetEmailFromRequest", "mutationFinancialsVisible", "saveCalculatorData"]) {
    const node = ast.statements.find(entry => ts.isFunctionDeclaration(entry) && entry.name?.text === name);
    assert.ok(node, name);
    vm.runInNewContext(ts.transpile(node.getText(ast), { target: ts.ScriptTarget.ES2020 }), endpoint);
  }
  return { db, call: (body, query = "") => endpoint.saveCalculatorData(new Request(`https://test.invalid/api/calculator-data${query}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })) };
}
for (const action of ["quoteEdit", "quoteCopy"]) {
  for (const extraData of [{ unrelated: "overwritten" }, snapshot(), { installerManagedPricesV1: "changed" }]) {
    const harness = endpointHarness();
    const response = await harness.call({ [action]: action === "quoteEdit" ? request() : { optionId: "quote-a", name: "Copy", saveId: "copy-12345678" }, data: extraData });
    assert.equal(response.status, 422, `${action} cannot smuggle an unrelated snapshot`);
    assert.equal(harness.db.writes, 0);
    assert.deepEqual(harness.db.stored.data, data);
  }
}
for (const [settings, query, full] of [
  [{ role: "admin", targetRole: "user" }, "?as=sales@example.test&preview=1", false],
  [{ role: "admin", targetRole: "user" }, "?as=sales@example.test", true],
  [{ role: "admin", targetRole: "business_owner" }, "?as=owner@example.test&preview=1", true],
  [{ role: "admin" }, "?preview=1", true],
  [{ role: "user" }, "?as=sales@example.test&preview=1", false],
  [{ role: "user", email: "danieldipalma88@gmail.com", targetRole: "user" }, "?as=sales@example.test&preview=1", false],
]) {
  const harness = endpointHarness(settings);
  const response = await harness.call({ quoteEdit: request(original, { finalInc: 4400 }, full) }, query);
  assert.equal(response.status, 200, `${query}: ${response.body.error}`);
  assert.equal("agencyCommissionRate" in response.body.row, full, "Response matches raw profile visibility");
  assert.equal(response.body.row.finalInc, 4400);
  assert.equal(JSON.parse(harness.db.stored.data[rowsKey])[0].agencyCommissionRate, original.agencyCommissionRate);
}
const failedVisibility = endpointHarness({ targetError: { message: "unavailable" } });
assert.equal((await failedVisibility.call({ quoteEdit: request() }, "?as=sales@example.test&preview=1")).status, 503);
assert.equal(failedVisibility.db.writes, 0);
assert.match(raw, /canSeeSalespersonCommission:\s*true/, "Mutation responses must follow the raw approved-profile display capability");
const publicOnly = quoteLibraryResponseRow(sanitized.row, false, false);
assert.equal(publicOnly.salespersonCommissionInc, undefined);
assert.equal(publicOnly.netProfit, undefined);
for (const value of [undefined, null, "", "invalid", NaN, Infinity, -Infinity]) {
  const response = quoteLibraryResponseRow({ salespersonCommissionInc: value, netProfit: value }, false, true);
  assert.equal(response.salespersonCommissionInc, undefined, "Missing or non-finite display amounts must not become fake zeroes");
  assert.equal(response.netProfit, undefined);
}
assert.equal(quoteLibraryResponseRow({ netProfit: 0, salespersonCommissionInc: 0 }, false, true).netProfit, 0);
assert.equal(quoteLibraryResponseRow(original, true, true), original, "Full-financial responses remain unchanged");
assert.equal(quoteLibraryVisibleRow(sanitized.row, false).netProfit, undefined, "Expected-row comparison projection remains strict");
assert.equal(quoteLibraryVisibleRow(sanitized.row, false).salespersonCommissionInc, undefined);
const responseSource = { ...original, salespersonCommissionInc: 88.25, netProfit: -15.75,
  agencyCommissionInc: 199, agencyProfitAfterSalesInc: 110.75,
  state: { ...original.state, netProfit: 123, salespersonCommissionInc: 88.25, agencyProfitAfterSalesInc: 110.75 } };
function assertSalesResponse(row, authoritative) {
  assert.equal(row.salespersonCommissionInc, authoritative.salespersonCommissionInc, "Approved salesperson sees their exact payable");
  assert.equal(row.netProfit, authoritative.netProfit, "Approved salesperson sees installer profit, including losses");
  for (const field of ["commissionType", "agencyCommissionRate", "salespersonCommissionRate", "commissionRate",
    "agencyCommission", "agencyCommissionInc", "commissionInc", "agencyProfitAfterSalesInc", "cashProfit"]) {
    assert.equal(row[field], undefined, `Private response field remains hidden: ${field}`);
    assert.equal(row.state?.[field], undefined, `Nested private response field remains hidden: ${field}`);
  }
  assert.equal(row.state.netProfit, undefined, "Only authorized top-level display amounts are added");
  assert.equal(row.state.salespersonCommissionInc, undefined);
  const comparisonMask = quoteLibraryVisibleRow(authoritative, false);
  for (const [key, value] of Object.entries(comparisonMask)) {
    if (!["salespersonCommissionInc", "netProfit"].includes(key)) assert.deepEqual(row[key], value, `Existing mask output stays unchanged: ${key}`);
  }
  assert.ok(Object.keys(row).filter(key => !(key in comparisonMask)).every(key => ["salespersonCommissionInc", "netProfit"].includes(key)),
    "The response can add only the two authorized top-level display amounts");
}
assertSalesResponse(quoteLibraryResponseRow(responseSource, false, true), responseSource);
for (const [settings, query] of [
  [{ role: "user", email: "sales@example.test" }, ""],
  [{ role: "admin", targetRole: "user" }, "?as=sales@example.test&preview=1"],
]) {
  const example = { ...clone(original), rebate: 500, state: { ...original.state, rebate: "500" } };
  const initialRow = success(applyQuoteLibraryEdit(snapshot(example), request(example, { finalInc: 3300 }), true, 1000)).row;
  const initial = { ...snapshot(initialRow), [rowsKey]: JSON.stringify([initialRow]) };
  const editing = endpointHarness({ ...settings, initial });
  const editRequest = { ...request(initialRow, { finalInc: 4400 }, false), saveId: "sales-edit-12345678" };
  const response = await editing.call({ quoteEdit: editRequest }, query);
  assert.equal(response.status, 200, response.body.error);
  const authoritative = JSON.parse(editing.db.stored.data[rowsKey])[0];
  assertSalesResponse(response.body.row, authoritative);
  assert.ok(Math.abs(response.body.row.salespersonCommissionInc - 412.5) < 1e-9);
  assert.ok(Math.abs(response.body.row.netProfit - 2475) < 1e-9);
  const retried = await editing.call({ quoteEdit: editRequest }, query);
  assert.equal(retried.status, 200, retried.body.error);
  assert.deepEqual(retried.body.row, response.body.row, "Identical edit retries retain exact authorized response amounts");
  // Returned display amounts do not weaken subsequent optimistic comparison or the pricing whitelist.
  const next = { ...request(response.body.row, { finalInc: 5500 }), saveId: "sales-next-12345678" };
  const second = await editing.call({ quoteEdit: next }, query);
  assert.equal(second.status, 200, second.body.error);
  assertSalesResponse(second.body.row, JSON.parse(editing.db.stored.data[rowsKey])[0]);
  const forged = request(second.body.row, { state: { ...second.body.row.state, agencyCommissionRate: 99 } });
  assert.equal((await editing.call({ quoteEdit: forged }, query)).status, 422, "Rates remain immutable even when the original is a response row");
  assert.equal((await editing.call({ quoteEdit: editRequest }, query)).status, 409, "Old original rows remain stale after a second edit");
  const copyInitial = { ...initial, [rowsKey]: JSON.stringify([authoritative]),
    [optionsKey]: JSON.stringify([{ id: "quote-a", name: "Original", salespersonCommissionInc: 777, netProfit: 888, agencyProfitAfterSalesInc: 999 }]) };
  const copying = endpointHarness({ ...settings, initial: copyInitial });
  const copiedResponse = await copying.call({ quoteCopy: { optionId: "quote-a", name: "Public copy", saveId: "response-copy-12345678" } }, query);
  assert.equal(copiedResponse.status, 200, copiedResponse.body.error);
  assert.equal(copiedResponse.body.def.salespersonCommissionInc, undefined, "Copied definitions retain their original strict mask");
  assert.equal(copiedResponse.body.def.netProfit, undefined);
  assert.equal(copiedResponse.body.def.agencyProfitAfterSalesInc, undefined);
  for (const row of copiedResponse.body.rows) {
    const stored = JSON.parse(copying.db.stored.data[rowsKey]).find(item => item.id === row.id);
    assertSalesResponse(row, stored);
    assert.ok(Math.abs(row.salespersonCommissionInc - 412.5) < 1e-9);
    assert.ok(Math.abs(row.netProfit - 2475) < 1e-9);
  }
  const copyRetry = await copying.call({ quoteCopy: { optionId: "quote-a", name: "Public copy", saveId: "response-copy-12345678" } }, query);
  assert.equal(copyRetry.status, 200, copyRetry.body.error);
  assert.deepEqual(copyRetry.body, copiedResponse.body, "Copy retries return the same IDs and authorized amounts");
}

const admin = await readFile(new URL("../app/admin/users/page.tsx", import.meta.url), "utf8");
const paymentKeys = [...admin.match(/const WON_PAYMENT_KEYS = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
const lifecycleKeys = [...paymentKeys, "wonAt", "wonByEmail", "wonByName", "wonSourceId", "wonState",
  "paymentResetAt", "paymentResetByEmail", "unlockedAt", "unlockedByEmail", "resetAt", "resetByEmail", "resetWonAt",
  "paymentStatus", "agencyPaymentStatus", "salespersonPaymentEvidence", "commissionPaidAt", "commissionPaymentId",
  "installationAddress", "installationLatitude", "installationLongitude", "proposedInstallationDate",
  "googlePlaceId", "googleAddressComponents", "googleAddressSelectedAt", "archivedAt",
  "quoteLibraryEditSaveId", "quoteLibraryEditFingerprint", "quoteLibraryCopySaveId"];
const evidence = Object.fromEntries(lifecycleKeys.map(key => [key, "historical-evidence"]));
const unknownMetadata = { paymentTerms: "net30", wonWarrantyNotes: "retain", delivery: { paymentTerms: "net60", wonAt: "metadata-not-job-status" } };
const wonSourceRow = { ...clone(original), ...evidence, ...unknownMetadata, state: { ...original.state, ...evidence, ...unknownMetadata },
  unknownNonLifecycle: { preserved: true, nested: { ...evidence, ...unknownMetadata, rebate: 123.456789 } } };
const wonSourceDef = { id: "quote-a", name: "Original", ...evidence, ...unknownMetadata, unknown: { preserve: 3 } };
const anotherRow = { ...clone(original), id: "another-system", optionId: "quote-b" };
const copyData = {
  [rowsKey]: JSON.stringify([wonSourceRow, anotherRow]),
  [optionsKey]: JSON.stringify([wonSourceDef, { id: "quote-b", name: "Other" }]),
  preservedStorage: "keep", [tombstonesKey]: JSON.stringify({ rows: { "row-a": 500 }, options: { "quote-a": 500 } }),
};
const copyBefore = clone(copyData);
const copyRequest = { optionId: "quote-a", name: "New customer", saveId: "copy-test-12345678" };
const copied = success(applyQuoteLibraryCopy(copyData, copyRequest, 1000));
assert.deepEqual(copyData, copyBefore, "Source records must not be mutated");
assert.equal(copied.rows.length, 1, "Copy only the selected group, not other customers");
assert.notEqual(copied.def.id, wonSourceDef.id);
assert.notEqual(copied.rows[0].id, wonSourceRow.id);
assert.equal(copied.rows[0].optionId, copied.def.id);
assert.equal(copied.rows[0].optionName, copyRequest.name);
assert.equal(copied.def.name, copyRequest.name);
for (const target of [copied.def, copied.rows[0], copied.rows[0].state]) {
  for (const key of lifecycleKeys) assert.equal(target[key], undefined, `Copy must reset ${key}`);
  for (const [key, value] of Object.entries(unknownMetadata)) assert.deepEqual(target[key], value, `Copy preserves unknown ${key}`);
}
assert.deepEqual(copied.rows[0].unknownNonLifecycle, wonSourceRow.unknownNonLifecycle, "Lifecycle-like keys outside record/state positions are unknown metadata and must remain exact");
for (const key of ["model", "brand", "unitInc", "finalInc", "rebate", "agencyCommissionRate", "salespersonCommissionRate", "salespersonGstRegistered"]) {
  assert.deepEqual(copied.rows[0][key], wonSourceRow[key], `Copy preserves ${key}`);
}
assert.equal(copied.rows[0].state.businessId, original.state.businessId);
assert.equal(copied.rows[0].state.rebate, original.state.rebate);
assert.deepEqual(copied.def.unknown, wonSourceDef.unknown);
assert.equal(copied.rows[0].unknownNonLifecycle.preserved, true);
assert.equal(copied.rows[0].unknownNonLifecycle.nested.rebate, original.rebate);
assert.deepEqual(JSON.parse(copied.data[rowsKey]).slice(0, 2), JSON.parse(copyData[rowsKey]));
assert.deepEqual(JSON.parse(copied.data[optionsKey]).slice(0, 2), JSON.parse(copyData[optionsKey]));
assert.deepEqual(success(applyQuoteLibraryCopy(copied.data, copyRequest, 2000)), copied, "An identical retry returns the committed records without new IDs");
assert.equal(applyQuoteLibraryCopy(copied.data, { ...copyRequest, name: "Different" }).status, 409);
assert.equal(applyQuoteLibraryCopy(copied.data, { ...copyRequest, optionId: "quote-b" }).status, 409);
const receiptsKey = "installerQuoteLibraryCopyReceiptsV1";
assert.deepEqual(JSON.parse(mergeCalculatorData(copied.data, { [receiptsKey]: "[]" })[receiptsKey]), JSON.parse(copied.data[receiptsKey]));
const removedCopy = { ...copied.data, [rowsKey]: copyData[rowsKey], [optionsKey]: copyData[optionsKey] };
assert.equal(applyQuoteLibraryCopy(removedCopy, copyRequest).status, 409, "A receipt prevents recreating a copy that was later removed");

const backups = Array.from({ length: 150 }, (_, index) => ({ id: `backup-${index}`, quotes: [wonSourceRow, anotherRow],
  optionDefs: [wonSourceDef, { id: "quote-b", name: "Other" }] }));
const backupData = { ...snapshot(), [backupsKey]: JSON.stringify(backups) };
const backupCopy = success(applyQuoteLibraryCopy(backupData, { ...copyRequest, backupId: "backup-149" }));
assert.equal(backupCopy.rows.length, 1);
assert.equal(backupCopy.data[backupsKey], backupData[backupsKey], "Copy neither replaces nor prunes any backup");
assert.deepEqual(JSON.parse(backupCopy.data[rowsKey]).slice(0, 2), JSON.parse(backupData[rowsKey]));
for (const input of [
  {}, { ...copyRequest, saveId: "bad" }, { ...copyRequest, name: " " },
  { ...copyRequest, row: original }, { ...copyRequest, backupId: 2 },
]) assert.equal(applyQuoteLibraryCopy(copyData, input).status, 422);
for (const input of [
  {}, { ...copyData, [rowsKey]: "[]" }, { ...copyData, [optionsKey]: "[]" },
]) assert.equal(applyQuoteLibraryCopy(input, copyRequest).status, 409);
for (const broken of [
  { ...copyData, [rowsKey]: "malformed" }, { ...copyData, [rowsKey]: JSON.stringify([null, wonSourceRow]) },
  { ...copyData, [optionsKey]: "{}" }, { ...copyData, [receiptsKey]: "broken" },
  { ...copyData, [rowsKey]: JSON.stringify([{ ...wonSourceRow, id: "" }]) },
]) assert.equal(applyQuoteLibraryCopy(broken, copyRequest).status, 422);
assert.equal(applyQuoteLibraryCopy(backupData, { ...copyRequest, backupId: "missing" }).status, 409);
assert.equal(applyQuoteLibraryCopy({ [backupsKey]: JSON.stringify([{ id: "broken", optionDefs: [wonSourceDef] }]) },
  { ...copyRequest, backupId: "broken" }).status, 422);
const copying = profile(copyData);
const copySaved = await context.saveMergedUserData(copying, "u", "user-1", {}, false, undefined, true, copyRequest);
assert.ok(copySaved.def, copySaved.error);
assert.equal(copySaved.rows.length, 1);
const copyRetry = await context.saveMergedUserData(copying, "u", "user-1", {}, false, undefined, true, copyRequest);
assert.equal(copyRetry.def.id, copySaved.def.id);
assert.equal(JSON.parse(copying.stored.data[rowsKey]).length, 3);
const copyRace = profile(copyData, stored => ({ ...stored, updated_at: "2026-01-02T00:00:00.000Z",
  data: { ...stored.data, concurrentCopyMetadata: "keep" } }));
assert.ok((await context.saveMergedUserData(copyRace, "u", "user-1", {}, false, undefined, true, copyRequest)).def);
assert.equal(copyRace.stored.data.concurrentCopyMetadata, "keep");
assert.equal(JSON.parse(copyRace.stored.data[rowsKey]).length, 3);
const removedSourceRace = profile(copyData, stored => ({ ...stored, updated_at: "2026-01-02T00:00:00.000Z", data: snapshot() }));
// A changed but still present source is deliberately resolved afresh after a failed CAS.
assert.ok((await context.saveMergedUserData(removedSourceRace, "u", "user-1", {}, false, undefined, true, copyRequest)).def);
const missingSourceRace = profile(copyData, stored => ({ ...stored, updated_at: "2026-01-02T00:00:00.000Z", data: {
  ...stored.data, [rowsKey]: "[]", [optionsKey]: "[]",
} }));
assert.equal((await context.saveMergedUserData(missingSourceRace, "u", "user-1", {}, false, undefined, true, copyRequest)).status, 409);
assert.equal(missingSourceRace.writes, 0);
const privateCopy = profile(copyData);
const privateResult = await context.saveMergedUserData(privateCopy, "u", "user-1", {}, false, undefined, false, copyRequest);
assert.equal(privateResult.rows[0].agencyCommissionRate, undefined);
assert.equal(privateResult.rows[0].state.agencyCommissionRate, undefined);
assert.equal(JSON.parse(privateCopy.stored.data[rowsKey]).at(-1).agencyCommissionRate, original.agencyCommissionRate);
console.log("Quote library sync: immutable backups; strict pricing edits, aliases, exact rebate, privacy and idempotency; won/deletion guards; atomic copy, lifecycle reset and CAS races passed.");
