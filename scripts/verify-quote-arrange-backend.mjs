import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { applyQuoteArrange } from '../lib/quote-arrange.ts';
import { applyQuoteLibraryCopy, applyQuoteLibraryEdit, quoteLibraryResponseRow, quoteLibraryVisibleRow } from '../lib/quote-library-edit.ts';
import { QUOTE_ARRANGEMENT_KEY, QUOTE_DEF_KEYS, QUOTE_ROW_KEYS, applyStoredQuoteAdminUnlocks, quoteFamilyId, quoteFamilySnapshotViolation, quoteFamilySnapshotConflict, quoteFamilyUnlockRequested } from '../lib/quote-family.ts';
import { mergeCalculatorData } from '../lib/quote-sync.ts';
import { validateNewWonJobTransitions, wonJobValidationMessage } from '../lib/won-job-validation.ts';
import { canManageUsers, canSeeCommissionDetails, canSeeProfitDetails, isOwnerEmail } from '../lib/admin.ts';
import { visibleCalculatorData } from '../lib/quote-data-visibility.ts';
import { CERTIFICATE_VALUES_STORAGE_KEYS, PLATFORM_CERTIFICATE_VALUES_ID, overlayPlatformCertificateValues, platformCertificateValuesFromRow } from '../lib/certificate-values.ts';
import { validatedBusinessConfigurationData, withoutBusinessConfiguration } from '../lib/business-calculator-configuration.ts';

const clone = value => structuredClone(value);
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const defs = data => parse(data[QUOTE_DEF_KEYS[0]]);
const rows = data => parse(data[QUOTE_ROW_KEYS[0]]);
const def = { id: 'a', name: 'Customer', extraDef: { preserve: true }, syncUpdatedAt: 100 };
const row = { id: 'r1', optionId: 'a', optionName: 'Customer', quotePosition: undefined,
  type: 'Split', model: 'Original', unitInc: 1100, finalInc: 3300, labour: 200, materialsInc: 110,
  miscInc: 22, powerCost: 80, labourTreatment: 'Retained', rebate: 123.456789,
  agencyCommission: 222, agencyCommissionRate: 25, salespersonCommissionRate: 50,
  salespersonGstRegistered: false, timestamp: 100, syncUpdatedAt: 100,
  privateExtension: { deeply: ['unchanged', { n: 2 }] },
  state: { postcode: '2208', rebate: '123.456789', commissionType: 'agency', agencyCommissionRate: 25,
    salespersonCommissionRate: 50, commissionModelOn: true, model: 'Original', rebatesEnabled: true, custom: ['keep'] } };
delete row.quotePosition;
function baseline() {
  const data = { unrelatedStorage: { keep: true } };
  for (const [index, key] of QUOTE_DEF_KEYS.entries()) data[key] = index === 1 ? [clone(def)] : JSON.stringify([def]);
  for (const [index, key] of QUOTE_ROW_KEYS.entries()) data[key] = index === 1 ? [clone(row), { ...clone(row), id: 'r2' }] : JSON.stringify([row, { ...row, id: 'r2' }]);
  return data;
}
let counter = 0;
function expected(data, optionId = 'a', visible = true) {
  const source = defs(data).find(value => value.id === optionId);
  const familyDefs = defs(data).filter(value => quoteFamilyId(value) === quoteFamilyId(source));
  const ids = new Set(familyDefs.map(value => value.id));
  return { defs: familyDefs.map(value => quoteLibraryVisibleRow(clone(value), visible)),
    rows: rows(data).filter(value => ids.has(value.optionId)).map(value => quoteLibraryVisibleRow(clone(value), visible)) };
}
function request(data, action, fields = {}, visible = true) {
  const optionId = fields.optionId || 'a';
  return { action, optionId, expected: expected(data, optionId, visible), saveId: `arrange_${++counter}`, ...fields };
}
function success(data, payload, visible = true) {
  const before = clone(data);
  const result = applyQuoteArrange(data, payload, visible, 1000 + counter);
  assert.deepEqual(data, before, 'mutations never change their input, even on success');
  assert.ok(!('error' in result), result.error);
  for (const keys of [QUOTE_DEF_KEYS, QUOTE_ROW_KEYS]) for (const key of keys) assert.deepEqual(parse(result.data[key]), parse(result.data[keys[0]]), `coherent alias ${key}`);
  return result;
}
function fail(data, payload, status = 409) {
  const before = clone(data);
  const result = applyQuoteArrange(data, payload, true, 2000);
  assert.equal(result.status, status, result.error);
  assert.deepEqual(data, before, 'failures cannot lose or duplicate systems');
  return result;
}
function unchangedContents(actual, original) {
  const a = clone(actual), b = clone(original);
  for (const key of ['id', 'optionId', 'quotePosition', 'syncUpdatedAt']) { delete a[key]; delete b[key]; }
  assert.deepEqual(a, b, 'prices, rebates, state and all unknown metadata survive');
}

const initial = baseline();
const addRequest = request(initial, 'addOption', { name: 'Daikin' });
let added = success(initial, addRequest);
assert.equal(added.defs.length, 2);
assert.equal(rows(added.data).length, 2);
assert.equal(added.defs[0].name, 'Customer');
assert.equal(added.defs[0].quoteOptionName, 'Option 1');
assert.equal(added.defs[1].quoteOptionName, 'Daikin');
const b = added.selectedOptionId;
assert.equal(defs(added.data).find(value => value.id === b).quoteFamilyId, 'a');
assert.deepEqual(success(added.data, addRequest).data, added.data, 'lost-response retry does not add an option twice');
fail(added.data, { ...addRequest, name: 'Changed retry' });
const ledger = parse(added.data[QUOTE_ARRANGEMENT_KEY]);
assert.ok(!JSON.stringify(ledger).includes('agencyCommission'), 'receipts never copy hidden financial records into general storage');
assert.ok(!JSON.stringify(ledger).includes('privateExtension'));

const moveRequest = request(added.data, 'moveRow', { rowId: 'r1', targetOptionId: b });
let moved = success(added.data, moveRequest);
assert.equal(rows(moved.data).find(value => value.id === 'r1').optionId, b);
unchangedContents(rows(moved.data).find(value => value.id === 'r1'), row);
assert.equal(rows(moved.data).length, 2);
// An identical retry after no subsequent writes is accepted.
assert.deepEqual(success(moved.data, moveRequest).data, moved.data);

const reorderSource = success(initial, request(initial, 'renameOption', { name: 'First' })).data;
let reordered = success(reorderSource, request(reorderSource, 'moveRow', { rowId: 'r2', beforeRowId: 'r1' }));
assert.deepEqual(rows(reordered.data).map(value => value.id), ['r1', 'r2'], 'storage array order is not the row ordering contract');
assert.equal(rows(reordered.data).find(value => value.id === 'r2').quotePosition, 0);
assert.equal(rows(reordered.data).find(value => value.id === 'r1').quotePosition, 1);
fail(reordered.data, request(reordered.data, 'moveRow', { rowId: 'r1', beforeRowId: 'r1' }), 422);
fail(reordered.data, request(reordered.data, 'moveRow', { rowId: 'r1', beforeRowId: 'missing' }));
fail(initial, request(initial, 'deleteOption'), 422);

let copied = success(moved.data, request(moved.data, 'copyRow', { optionId: b, rowId: 'r1', targetOptionId: 'a', beforeRowId: 'r2' }));
assert.equal(rows(copied.data).length, 3);
const copiedRow = copied.rows.find(value => !['r1', 'r2'].includes(value.id));
assert.ok(copiedRow);
unchangedContents(copiedRow, row);
assert.equal(copiedRow.optionId, 'a');
assert.equal(copiedRow.quotePosition, 0);
const duplicateRequest = request(copied.data, 'duplicateOption', { name: 'Alternative' });
let duplicated = success(copied.data, duplicateRequest);
assert.equal(rows(duplicated.data).filter(value => value.optionId === duplicated.selectedOptionId).length, 2);
assert.equal(new Set(rows(duplicated.data).map(value => value.id)).size, 5);
assert.deepEqual(success(duplicated.data, duplicateRequest).data, duplicated.data);
let renamed = success(duplicated.data, request(duplicated.data, 'renameCustomer', { name: 'New Customer' }));
assert.ok(defs(renamed.data).every(value => value.name === 'New Customer'));
assert.ok(rows(renamed.data).every(value => value.optionName === 'New Customer'));
assert.equal(defs(renamed.data).find(value => value.id === b).quoteOptionName, 'Daikin');
const staleRetry = fail(renamed.data, duplicateRequest);
assert.equal(staleRetry.currentFamily.defs.length, 3);
assert.ok(staleRetry.currentFamily.defs.every(value => value.name === 'New Customer'));

const staleSnapshot = baseline();
for (const key of QUOTE_ROW_KEYS) staleSnapshot[key] = JSON.stringify(parse(staleSnapshot[key]).map(value => ({ ...value, finalInc: 7777, syncUpdatedAt: 999999,
  optionId: 'a', quotePosition: -55, quoteFamilyId: 'forged', privateExtension: undefined })));
for (const key of QUOTE_DEF_KEYS) staleSnapshot[key] = JSON.stringify([{ ...def, name: 'Old client customer', quoteFamilyId: 'forged', quoteOptionName: 'forged', syncUpdatedAt: 999999 }]);
staleSnapshot[QUOTE_ARRANGEMENT_KEY] = JSON.stringify({ receipts: [], removedRowIds: ['r1'], removedOptionIds: ['a'] });
staleSnapshot.installerQuoteSyncTombstonesV1 = JSON.stringify({ rows: { r1: 99999999 }, options: { a: 99999999 } });
const fenced = mergeCalculatorData(renamed.data, staleSnapshot);
assert.equal(rows(fenced).find(value => value.id === 'r1').optionId, b);
assert.equal(rows(fenced).find(value => value.id === 'r1').finalInc, 7777, 'ordinary totals edits survive the topology fence');
assert.equal(rows(fenced).find(value => value.id === 'r1').quotePosition, rows(renamed.data).find(value => value.id === 'r1').quotePosition);
assert.equal(defs(fenced).find(value => value.id === 'a').quoteFamilyId, 'a');
assert.equal(defs(fenced).find(value => value.id === 'a').name, 'New Customer');
assert.equal(rows(fenced).length, 5, 'legacy removal cannot delete any arranged systems');
assert.deepEqual(parse(fenced[QUOTE_ARRANGEMENT_KEY]), parse(renamed.data[QUOTE_ARRANGEMENT_KEY]));
for (const key of QUOTE_ROW_KEYS) assert.deepEqual(parse(fenced[key]), rows(fenced));

const newRow = { ...clone(row), id: 'native-new', optionId: 'a', quotePosition: -1000, syncUpdatedAt: 2000000 };
const nativeAppend = mergeCalculatorData(reordered.data, { [QUOTE_ROW_KEYS[0]]: JSON.stringify([...rows(reordered.data), newRow]) });
assert.equal(rows(nativeAppend).find(value => value.id === 'native-new').quotePosition, 2);
for (const key of QUOTE_ROW_KEYS) assert.ok(parse(nativeAppend[key]).some(value => value.id === 'native-new'));
const mixedPositions = clone(reordered.data);
for (const key of QUOTE_ROW_KEYS) mixedPositions[key] = JSON.stringify([...rows(reordered.data), { ...row, id: 'absent-position' }]);
const normalized = success(mixedPositions, request(mixedPositions, 'renameOption', { name: 'Normalized' }));
assert.equal(rows(normalized.data).find(value => value.id === 'absent-position').quotePosition, 2);

const removed = success(moved.data, request(moved.data, 'removeRow', { optionId: b, rowId: 'r1' }));
assert.deepEqual(removed.removedRowIds, ['r1']);
const deleted = success(removed.data, request(removed.data, 'deleteOption', { optionId: b }));
assert.deepEqual(deleted.removedOptionIds, [b]);
assert.equal(deleted.selectedOptionId, 'a');
const resurrection = {};
for (const key of QUOTE_DEF_KEYS) resurrection[key] = JSON.stringify(defs(moved.data).map(value => ({ ...value, syncUpdatedAt: 1e12 })));
for (const key of QUOTE_ROW_KEYS) resurrection[key] = JSON.stringify(rows(moved.data).map(value => ({ ...value, syncUpdatedAt: 1e12 })));
resurrection.installerQuoteSyncTombstonesV1 = '{}';
const cannotResurrect = mergeCalculatorData(deleted.data, resurrection);
assert.ok(!defs(cannotResurrect).some(value => value.id === b));
assert.ok(!rows(cannotResurrect).some(value => value.id === 'r1'));
const orphanPush = { [QUOTE_ROW_KEYS[0]]: JSON.stringify([{ ...row, id: 'new-in-deleted-option', optionId: b }]) };
assert.equal(quoteFamilySnapshotViolation(deleted.data, orphanPush), true, 'new systems cannot target a deleted option');
assert.ok(!rows(mergeCalculatorData(deleted.data, orphanPush)).some(value => value.id === 'new-in-deleted-option'));
const duplicatedSnapshot = mergeCalculatorData(moved.data, { [QUOTE_ROW_KEYS[0]]: JSON.stringify([...rows(moved.data), ...rows(moved.data)]) });
assert.equal(rows(duplicatedSnapshot).length, 2, 'duplicate incoming IDs cannot duplicate managed systems');
const rootDeleted = success(moved.data, request(moved.data, 'deleteOption'));
assert.equal(defs(rootDeleted.data)[0].quoteFamilyId, 'a', 'root family identity survives deleting the original option');
success(rootDeleted.data, request(rootDeleted.data, 'addOption', { optionId: b }));

const foreign = baseline();
for (const key of QUOTE_DEF_KEYS) foreign[key] = JSON.stringify([...parse(foreign[key]), { id: 'foreign', name: 'Other' }]);
fail(foreign, request(foreign, 'moveRow', { rowId: 'r1', targetOptionId: 'foreign' }));
const malformed = baseline(); malformed[QUOTE_ROW_KEYS[2]] = JSON.stringify([{ ...row, finalInc: 1 }]);
fail(malformed, request(baseline(), 'addOption'), 422);
for (const bad of [{ expected: { defs: [], rows: [] } }, { saveId: 'bad' }, { unexpected: 1 }, { action: 'unsupported' }]) {
  fail(initial, { ...request(initial, 'addOption'), ...bad }, bad.expected ? 409 : 422);
}

const wonDetails = { installationAddress: '4 Example Street', googlePlaceId: 'google-place', proposedInstallationDate: '2026-10-28', wonAt: '2026-10-27T00:00:00Z' };
for (const mode of ['parent', 'row']) {
  const locked = clone(moved.data);
  for (const key of mode === 'parent' ? QUOTE_DEF_KEYS : QUOTE_ROW_KEYS) locked[key] = JSON.stringify(parse(locked[key]).map(value =>
    value.id === (mode === 'parent' ? b : 'r1') ? { ...value, ...wonDetails } : value));
  fail(locked, request(locked, 'renameOption', { name: 'Blocked' }));
  const current = rows(locked).find(value => value.id === 'r2');
  assert.equal(applyQuoteLibraryEdit(locked, { rowId: 'r2', optionId: 'a', expectedRow: current, row: { ...current, finalInc: 4400 } }, true).status, 409);
  assert.equal(quoteFamilySnapshotViolation(locked, { [QUOTE_ROW_KEYS[0]]: JSON.stringify([newRow]) }), true);
  const dropped = mergeCalculatorData(locked, { [QUOTE_ROW_KEYS[0]]: JSON.stringify([newRow]) });
  assert.ok(!rows(dropped).some(value => value.id === 'native-new'));
  const secondWon = clone(locked);
  for (const key of QUOTE_ROW_KEYS) secondWon[key] = JSON.stringify(rows(locked).map(value => value.id === 'r2' ? { ...value, ...wonDetails } : value));
  const validation = validateNewWonJobTransitions(locked, secondWon);
  assert.equal(validation.valid, false);
  assert.equal(validation.familyConflict, true);
  assert.match(wonJobValidationMessage(validation), /Only one option/);
  assert.equal(quoteFamilySnapshotViolation(locked, secondWon), true);
}
const legacyWon = { [QUOTE_DEF_KEYS[0]]: JSON.stringify([{ id: 'legacy-one', ...wonDetails }, { id: 'legacy-two', ...wonDetails }]) };
assert.equal(validateNewWonJobTransitions({}, legacyWon).valid, true, 'independent legacy groups remain independent');
const noSiblingRows = clone(moved.data);
for (const key of QUOTE_DEF_KEYS) noSiblingRows[key] = JSON.stringify(defs(noSiblingRows).map(value => ({ ...value, ...wonDetails })));
assert.equal(validateNewWonJobTransitions(moved.data, noSiblingRows).familyConflict, true, 'parent-only siblings cannot both be won');

for (const fromBackup of [false, true]) {
  const source = clone(renamed.data);
  if (fromBackup) source.installerSavedQuoteSetsV1 = JSON.stringify([{ id: 'backup', quotes: rows(source), optionDefs: defs(source), extra: true }]);
  const result = applyQuoteLibraryCopy(source, { optionId: 'a', name: 'Detached customer', saveId: `copy_detached_${fromBackup}`, ...(fromBackup ? { backupId: 'backup' } : {}) }, 5000);
  assert.ok(!('error' in result), result.error);
  assert.equal(result.def.name, 'Detached customer');
  for (const record of [result.def, ...result.rows]) for (const key of ['quoteFamilyId', 'quoteOptionName', 'quoteOptionOrder', 'quotePosition']) assert.ok(!(key in record));
  assert.deepEqual(result.def.extraDef, def.extraDef);
  assert.deepEqual(result.rows[0].privateExtension, row.privateExtension);
  for (const key of QUOTE_DEF_KEYS) assert.ok(parse(result.data[key]).some(value => value.id === result.def.id));
  for (const key of QUOTE_ROW_KEYS) assert.ok(parse(result.data[key]).some(value => value.id === result.rows[0].id));
}

const legacy = { [QUOTE_ROW_KEYS[0]]: JSON.stringify([{ id: 'unrelated', optionId: 'legacy', finalInc: 100, timestamp: 1 }]),
  [QUOTE_DEF_KEYS[0]]: JSON.stringify([{ id: 'legacy', name: 'Legacy' }]) };
const combined = clone(moved.data);
for (const key of QUOTE_ROW_KEYS) combined[key] = JSON.stringify([...rows(moved.data), ...parse(legacy[QUOTE_ROW_KEYS[0]])]);
for (const key of QUOTE_DEF_KEYS) combined[key] = JSON.stringify([...defs(moved.data), ...parse(legacy[QUOTE_DEF_KEYS[0]])]);
const legacyEdit = mergeCalculatorData(combined, { [QUOTE_ROW_KEYS[0]]: JSON.stringify([{ id: 'unrelated', optionId: 'legacy', finalInc: 200, timestamp: 2 }]) });
assert.equal(rows(legacyEdit).find(value => value.id === 'unrelated').finalInc, 200);
const legacyDelete = mergeCalculatorData(combined, { installerQuoteSyncTombstonesV1: JSON.stringify({ rows: { unrelated: 500 } }), [QUOTE_ROW_KEYS[0]]: '[]' });
assert.ok(!rows(legacyDelete).some(value => value.id === 'unrelated'), 'unarranged legacy deletion remains supported');

// Exercise the actual route CAS loop with an in-memory Supabase query double.
const routeText = fs.readFileSync(new URL('../app/api/calculator-data/route.ts', import.meta.url), 'utf8');
const routeAst = ts.createSourceFile('route.ts', routeText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const saveFunction = routeAst.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === 'saveMergedUserData');
assert.ok(saveFunction);
const context = { applyQuoteArrange, applyQuoteLibraryCopy, applyQuoteLibraryEdit, quoteLibraryResponseRow, quoteLibraryVisibleRow,
  mergeCalculatorData, applyStoredQuoteAdminUnlocks, quoteFamilySnapshotViolation, quoteFamilySnapshotConflict, quoteFamilyUnlockRequested, validateNewWonJobTransitions, wonJobValidationMessage,
  calculatorDataHasData: data => Object.keys(data || {}).length > 0 };
vm.createContext(context);
vm.runInContext(ts.transpileModule(saveFunction.getText(routeAst), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
function database(data, collision) {
  const state = { record: { user_id: 'user', data: clone(data), updated_at: '2026-10-27T00:00:00Z' }, writes: 0, reads: 0 };
  const db = { from(table) {
    assert.equal(table, 'user_calculator_data');
    let update, filters = {};
    const query = {
      select() {
        if (!update) return query;
        state.writes++;
        if (collision && state.writes === 1) {
          state.record.data = collision(state.record.data);
          state.record.updated_at = '2026-10-27T00:00:01Z';
        }
        if (filters.updated_at !== state.record.updated_at) return Promise.resolve({ data: [], error: null });
        state.record = { ...state.record, ...clone(update) };
        return Promise.resolve({ data: [{ user_id: 'user' }], error: null });
      },
      eq(key, value) { filters[key] = value; return query; },
      is(key, value) { filters[key] = value; return query; },
      update(value) { update = value; return query; },
      maybeSingle() { state.reads++; return Promise.resolve({ data: clone(state.record), error: null }); },
    };
    return query;
  } };
  return { db, state };
}
const save = (db, payload, visible = false, incoming = {}) => context.saveMergedUserData(db, 'user@example.test', 'user', incoming, false, undefined, visible, undefined, false, payload);
const casPayload = request(initial, 'addOption', { name: 'CAS new' }, false);
const unrelatedRace = database(initial, data => ({ ...data, preference: 'concurrently saved' }));
const saved = await save(unrelatedRace.db, casPayload);
assert.equal(saved.ok, true);
assert.equal(unrelatedRace.state.writes, 2);
assert.equal(unrelatedRace.state.record.data.preference, 'concurrently saved');
assert.equal(defs(unrelatedRace.state.record.data).length, 2);
assert.ok(saved.rows.every(value => !('agencyCommission' in value) && !('agencyCommissionRate' in value.state)), 'success patches are role masked');
const again = await save(unrelatedRace.db, casPayload);
assert.equal(again.selectedOptionId, saved.selectedOptionId);
assert.equal(defs(unrelatedRace.state.record.data).length, 2);
const familyRace = database(initial, data => {
  const next = clone(data);
  for (const key of QUOTE_ROW_KEYS) next[key] = JSON.stringify(parse(next[key]).map(value => ({ ...value, finalInc: 9999, syncUpdatedAt: 300 })));
  return next;
});
const conflict = await save(familyRace.db, casPayload);
assert.equal(conflict.status, 409);
assert.equal(familyRace.state.writes, 1);
assert.equal(defs(familyRace.state.record.data).length, 1);
assert.equal(conflict.currentFamily.rows[0].finalInc, 9999);
assert.ok(conflict.currentFamily.rows.every(value => !('agencyCommission' in value) && !('agencyCommissionRate' in value.state)), 'conflict snapshots are role masked');
const wonSnapshot = clone(moved.data);
for (const key of QUOTE_DEF_KEYS) wonSnapshot[key] = JSON.stringify(defs(wonSnapshot).map(value => value.id === b ? { ...value, ...wonDetails } : value));
const lockedDb = database(wonSnapshot);
assert.equal((await save(lockedDb.db, undefined, false, { [QUOTE_ROW_KEYS[0]]: JSON.stringify([newRow]) })).status, 409);
assert.equal(lockedDb.state.writes, 0);

function endpoint({ role = 'user', locked = false, targetRole = 'user', initialData = initial } = {}) {
  const { db, state } = database(initialData);
  db.auth = { getUser: async () => ({ data: { user: { id: 'user', email: 'actor@example.test' } } }) };
  const sandbox = { URL, canManageUsers, canSeeCommissionDetails, canSeeProfitDetails, isOwnerEmail,
    NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) },
    createSupabaseServerClient: async () => db,
    currentApprovedUser: async (_db, email) => ({ data: { role: email === 'actor@example.test' ? role : targetRole, is_locked: locked }, error: null }),
    resolveBusinessId: async () => null, sanitizeIncomingCalculatorData: value => value,
    stripCertificateValueKeys: value => value, splitCalculatorDataByScope: value => ({ userData: value, businessData: {} }),
    calculatorDataHasData: context.calculatorDataHasData, saveMergedUserData: context.saveMergedUserData };
  for (const name of ['targetEmailFromRequest', 'mutationFinancialsVisible', 'saveCalculatorData']) {
    const fn = routeAst.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === name);
    assert.ok(fn, name);
    vm.runInNewContext(ts.transpileModule(fn.getText(routeAst), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  }
  return { state, call: (body, query = '', method = 'PUT') => sandbox.saveCalculatorData(new Request(`https://test.invalid/api/calculator-data${query}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })) };
}
for (const [settings, query, full] of [
  [{ role: 'admin' }, '?as=sales@example.test&preview=1', false],
  [{ role: 'admin' }, '?as=sales@example.test', true],
  [{ role: 'user' }, '?as=sales@example.test&preview=1', false],
  [{ role: 'admin', targetRole: 'business_owner' }, '?as=owner@example.test&preview=1', true],
]) {
  const harness = endpoint(settings);
  const response = await harness.call({ quoteArrange: request(initial, 'addOption', {}, full) }, query);
  assert.equal(response.status, 200, response.body.error);
  assert.equal('agencyCommission' in response.body.rows[0], full, 'arrangement honours existing preview visibility');
  const stale = await harness.call({ quoteArrange: request(initial, 'renameOption', { name: 'Stale' }, full) }, query);
  assert.equal(stale.status, 409);
  assert.equal('agencyCommission' in stale.body.currentFamily.rows[0], full, 'conflict family honours existing preview visibility');
}
for (const body of [
  { quoteArrange: casPayload, data: { preferences: 'not allowed' } },
  { quoteArrange: casPayload, quoteCopy: { optionId: 'a', name: 'Copy', saveId: 'copy_mixed_request' } },
  { quoteArrange: casPayload, quoteEdit: {} },
]) {
  const harness = endpoint();
  assert.equal((await harness.call(body)).status, 422);
  assert.equal(harness.state.writes, 0, 'mutations cannot smuggle snapshots or additional mutations');
}
const lockedActor = endpoint({ locked: true });
assert.equal((await lockedActor.call({ quoteArrange: casPayload })).status, 403);
assert.equal(lockedActor.state.writes, 0);

const raw = fs.readFileSync(new URL('../app/calculator/raw/route.ts', import.meta.url), 'utf8');
assert.match(raw, /kind !== 'quoteArrange'/);
assert.match(raw, /error\.currentFamily = result\.currentFamily/);

// Regression: an omission-based, authorised unlock must survive the metadata fence.
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const uiSource = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n');
const uiAst = ts.createSourceFile('index.js', uiSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const unlockFn = uiAst.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === 'unlockWonOption');
assert.ok(unlockFn);
let selectedWon = clone(moved.data);
for (const key of QUOTE_DEF_KEYS) selectedWon[key] = JSON.stringify(defs(selectedWon).map(value => value.id === 'a' ? { ...value, ...wonDetails, wonByEmail: 'admin@test', wonByName: 'Admin', paidInAt: 'old-payment' } : value));
for (const key of QUOTE_ROW_KEYS) selectedWon[key] = JSON.stringify(rows(selectedWon).map(value => value.id === 'r2' ? { ...value, ...wonDetails, wonByEmail: 'admin@test', wonByName: 'Admin', finalInc: 9900, agencyCommissionInc: 9999,
  state: { ...value.state, wonAt: wonDetails.wonAt, paidOutAt: 'old-payment' } } : { ...value, agencyCommissionInc: 222 }));
function uiUnlock(allowed) {
  const sandbox = { quoteOptionDefs: clone(defs(selectedWon)), quotes: clone(rows(selectedWon)),
    ensureOptionDefs() {}, canUnlockWonOptions: () => allowed, confirm: () => true, alert() {},
    touchOptionDef: value => { value.syncUpdatedAt = 10000; }, touchQuoteRow: value => { value.syncUpdatedAt = 10000; },
    persistOptionDefs() {}, persistQuotes() {}, renderQuotes() {} };
  sandbox.optionDefById = id => sandbox.quoteOptionDefs.find(value => value.id === id);
  vm.createContext(sandbox); vm.runInContext(unlockFn.getText(uiAst), sandbox); sandbox.unlockWonOption('a');
  return sandbox;
}
const deniedUi = uiUnlock(false);
assert.equal(deniedUi.quoteOptionDefs[0].wonAt, wonDetails.wonAt, 'existing frontend unlock permission is unchanged');
const unlockedUi = uiUnlock(true);
const unlockSnapshot = {};
for (const key of QUOTE_DEF_KEYS) unlockSnapshot[key] = JSON.stringify(unlockedUi.quoteOptionDefs);
for (const key of QUOTE_ROW_KEYS) unlockSnapshot[key] = JSON.stringify(unlockedUi.quotes);
// The raw admin clearWonFields flow removes payment fields too.
const rawAst = ts.createSourceFile('raw.ts', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const rawContext = { visibleCalculatorData };
for (const name of ['clearWonFields', 'sanitizeCalculatorData']) {
  const fn = rawAst.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === name);
  vm.runInNewContext(ts.transpileModule(fn.getText(rawAst), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, rawContext);
}
for (const key of QUOTE_DEF_KEYS) unlockSnapshot[key] = JSON.stringify(parse(unlockSnapshot[key]).map(value => value.id === 'a' ? rawContext.clearWonFields(value) : value));
for (const key of QUOTE_ROW_KEYS) unlockSnapshot[key] = JSON.stringify(parse(unlockSnapshot[key]).map(value => value.id === 'r2' ? { ...rawContext.clearWonFields(value), state: { postcode: '2208', custom: ['keep'] } } : value));
const restrictedUnlock = endpoint({ initialData: selectedWon });
assert.equal((await restrictedUnlock.call({ data: unlockSnapshot })).status, 403);
assert.equal(restrictedUnlock.state.writes, 0, 'restricted omission cannot unlock a managed won quote');
const previewUnlock = endpoint({ role: 'admin', initialData: selectedWon });
assert.equal((await previewUnlock.call({ data: unlockSnapshot }, '?as=sales@example.test&preview=1')).status, 403);
const adminUnlock = endpoint({ role: 'admin', initialData: selectedWon });
assert.equal((await adminUnlock.call({ data: unlockSnapshot })).status, 200);
const unlockedData = adminUnlock.state.record.data;
for (const key of [...QUOTE_DEF_KEYS, ...QUOTE_ROW_KEYS]) for (const value of parse(unlockedData[key])) {
  assert.ok(!value.wonAt && !value.wonByEmail && !value.wonByName && !value.paidInAt);
  if (value.id === 'r2') {
    assert.ok(!value.state.wonAt && !value.state.paidOutAt, 'nested lifecycle omission is not inherited');
    assert.deepEqual(value.privateExtension, row.privateExtension, 'unknown metadata survives unlock omissions');
  }
}
success(unlockedData, request(unlockedData, 'renameOption', { optionId: b, name: 'Now unlocked' }));
const staleAfterUnlock = mergeCalculatorData(unlockedData, selectedWon);
assert.ok(!defs(staleAfterUnlock).some(value => value.wonAt), 'older pre-unlock snapshots cannot re-lock the family');
const acceptAlternate = {};
for (const key of QUOTE_DEF_KEYS) acceptAlternate[key] = JSON.stringify(defs(unlockedData).map(value => value.id === b ? { ...value, ...wonDetails, syncUpdatedAt: 11000 } : value));
for (const key of QUOTE_ROW_KEYS) acceptAlternate[key] = JSON.stringify(rows(unlockedData).map(value => value.optionId === b ? { ...value, ...wonDetails, syncUpdatedAt: 11000 } : value));
assert.equal((await adminUnlock.call({ data: acceptAlternate })).status, 200, 'an alternate may be accepted after a persisted unlock');
const alternateData = adminUnlock.state.record.data;
assert.deepEqual(defs(alternateData).filter(value => value.wonAt).map(value => value.id), [b]);
assert.deepEqual(rows(alternateData).filter(value => value.wonAt).map(value => value.id), ['r1']);
// First-alias-only admin updates must propagate without restoring stale won aliases.
const firstAliasUnlocked = { ...selectedWon, [QUOTE_DEF_KEYS[0]]: unlockSnapshot[QUOTE_DEF_KEYS[0]], [QUOTE_ROW_KEYS[0]]: unlockSnapshot[QUOTE_ROW_KEYS[0]] };
const coherentUnlock = mergeCalculatorData(firstAliasUnlocked, {});
for (const key of [...QUOTE_DEF_KEYS, ...QUOTE_ROW_KEYS]) assert.ok(!parse(coherentUnlock[key]).some(value => value.wonAt));
for (const parentOnly of [false, true]) {
  const singleAlias = { [QUOTE_DEF_KEYS[0]]: selectedWon[QUOTE_DEF_KEYS[0]], [QUOTE_ROW_KEYS[0]]: JSON.stringify(rows(selectedWon).map(value => {
    const record = clone(value); if (parentOnly) delete record.wonAt; return record;
  })) };
  const singleAdmin = endpoint({ role: 'admin', initialData: singleAlias });
  assert.equal((await singleAdmin.call({ data: { [QUOTE_DEF_KEYS[0]]: unlockSnapshot[QUOTE_DEF_KEYS[0]], [QUOTE_ROW_KEYS[0]]: unlockSnapshot[QUOTE_ROW_KEYS[0]] } })).status, 200);
  assert.ok(!defs(singleAdmin.state.record.data).some(value => value.wonAt));
  assert.ok(!rows(singleAdmin.state.record.data).some(value => value.wonAt || value.state?.wonAt));
}

// Exercise the actual admin grouping/financial sums, not a family-level approximation.
const adminSource = fs.readFileSync(new URL('../app/admin/users/page.tsx', import.meta.url), 'utf8');
const adminAst = ts.createSourceFile('admin.tsx', adminSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const groupFn = adminAst.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === 'addWonOptionsFromSnapshot');
const adminContext = { wonOptionId: value => String(value.id), lookupText: value => String(value || '').toLowerCase(),
  wonOptionKey: (...values) => values.join('|'), moneyValue: value => Number(value) || 0, optionRowLabel: value => value.model,
  quoteRebateValue: value => Number(value.rebate) || 0, quoteMaterialsInc: value => Number(value.materialsInc) || 0,
  quotePowerOrElectricianEx: value => Number(value.powerCost) || 0, quoteAgencyProfitAfterSalesInc: () => 0,
  wonPaymentStatus: () => 'not_requested', wonPaymentStatusLabel: () => 'Not requested', displayNameFor: value => value.email };
vm.runInNewContext(ts.transpileModule(groupFn.getText(adminAst), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, adminContext);
const wonOptions = new Map();
adminContext.addWonOptionsFromSnapshot({ wonOptions, deletedWonOptions: new Set(), adminWonStates: new Map(), usersByEmail: new Map(), usersByName: new Map(),
  fallbackEmail: 'user@test', dataUserId: 'user', optionDefs: defs(alternateData), quotes: rows(alternateData), sourceId: 'current', updatedAt: wonDetails.wonAt });
assert.equal(wonOptions.size, 1);
const wonAggregate = [...wonOptions.values()][0];
assert.equal(wonAggregate.systemCount, 1);
assert.equal(wonAggregate.customerTotal, 3300, 'unselected $9900 system is excluded');
assert.equal(wonAggregate.agencyCommissionTotal, 222, 'unselected $9999 commission cannot become payable');
assert.equal(wonAggregate.paidInAt, '', 'old selected-option payment state cannot transfer to an alternate');

// Existing legacy rows cannot enter any managed destination through a snapshot.
const withForeign = clone(selectedWon);
for (const key of QUOTE_DEF_KEYS) withForeign[key] = JSON.stringify([...defs(selectedWon), { id: 'legacy-x', name: 'Other' }]);
for (const key of QUOTE_ROW_KEYS) withForeign[key] = JSON.stringify([...rows(selectedWon), { ...row, id: 'foreign', optionId: 'legacy-x', finalInc: 9900 }]);
for (const target of ['a', b]) {
  const injection = { [QUOTE_ROW_KEYS[0]]: JSON.stringify([{ ...row, id: 'foreign', optionId: target, syncUpdatedAt: 12000, finalInc: 9900 }]) };
  assert.equal(quoteFamilySnapshotViolation(withForeign, injection), true);
  const injected = endpoint({ role: 'admin', initialData: withForeign });
  assert.equal((await injected.call({ data: injection })).status, 409);
  assert.equal(injected.state.writes, 0);
  assert.equal(rows(mergeCalculatorData(withForeign, injection)).find(value => value.id === 'foreign').optionId, 'legacy-x');
}
const openForeign = clone(withForeign);
for (const key of QUOTE_DEF_KEYS) openForeign[key] = JSON.stringify(defs(openForeign).map(value => rawContext.clearWonFields(value)));
for (const key of QUOTE_ROW_KEYS) openForeign[key] = JSON.stringify(rows(openForeign).map(value => rawContext.clearWonFields(value)));
assert.equal(quoteFamilySnapshotViolation(openForeign, { [QUOTE_ROW_KEYS[0]]: JSON.stringify([{ ...row, id: 'foreign', optionId: b }]) }), true, 'even open managed destinations require arrange');
assert.equal(quoteFamilySnapshotViolation(openForeign, { [QUOTE_ROW_KEYS[0]]: JSON.stringify([{ ...row, id: 'r1', optionId: 'legacy-x' }]) }), true, 'managed source cannot be moved out by snapshot');

// Native unshift batches retain append positions and match the next exact expected snapshot.
const batchBase = clone(reorderSource);
const oldRows = rows(batchBase);
const firstNative = { ...row, id: 'batch-first', optionId: 'a', quotePosition: 2, syncUpdatedAt: 13000 };
const secondNative = { ...row, id: 'batch-second', optionId: 'a', quotePosition: 3, syncUpdatedAt: 14000 };
const batchRows = [secondNative, firstNative, ...oldRows];
const batchIncoming = { [QUOTE_ROW_KEYS[0]]: JSON.stringify(batchRows) };
assert.equal(quoteFamilySnapshotViolation(batchBase, batchIncoming), false);
const batchSaved = mergeCalculatorData(batchBase, batchIncoming);
assert.equal(rows(batchSaved).find(value => value.id === 'batch-first').quotePosition, 2);
assert.equal(rows(batchSaved).find(value => value.id === 'batch-second').quotePosition, 3);
const batchRequest = request(batchSaved, 'renameOption', { name: 'Batch ready' });
batchRequest.expected.rows = batchRows;
success(batchSaved, batchRequest);
const batchApi = endpoint({ role: 'admin', initialData: batchBase });
assert.equal((await batchApi.call({ data: batchIncoming })).status, 200);
assert.equal((await batchApi.call({ quoteArrange: batchRequest })).status, 200, 'native batch followed by actual arrange API matches the client expected snapshot');
for (const invalidRows of [
  [{ ...firstNative, quotePosition: 0 }], [{ ...firstNative, quotePosition: 2.5 }],
  [firstNative, { ...secondNative, quotePosition: 2 }], [{ ...firstNative, quotePosition: Number.MAX_SAFE_INTEGER + 1 }],
]) assert.equal(quoteFamilySnapshotViolation(batchBase, { [QUOTE_ROW_KEYS[0]]: JSON.stringify(invalidRows) }), true);
const copyOrder = applyQuoteLibraryCopy(reordered.data, { optionId: 'a', name: 'Ordered detached copy', saveId: 'copy_reordered_regression' });
assert.ok(!('error' in copyOrder), copyOrder.error);
assert.deepEqual(copyOrder.rows.map(value => value.timestamp - copyOrder.rows[0].timestamp), [0, 1]);
assert.equal(copyOrder.rows[0].model, rows(reordered.data).find(value => value.id === 'r2').model);
// Distinguish two otherwise identical fixture systems to prove the source order.
const distinctOrder = clone(reordered.data);
for (const key of QUOTE_ROW_KEYS) distinctOrder[key] = JSON.stringify(rows(distinctOrder).map(value => ({ ...value, originalSystemId: value.id })));
const orderedCopy = applyQuoteLibraryCopy(distinctOrder, { optionId: 'a', name: 'Ordered copy', saveId: 'copy_ordered_distinct' });
assert.deepEqual(orderedCopy.rows.map(value => value.originalSystemId), ['r2', 'r1']);

// Actual GET and actual raw sanitizer projection, including historic ledger receipts.
const secretRow = { ...row, salespersonCommissionInc: 42, netProfit: 84, agencyProfitAfterSalesInc: 999, netMargin: 0.8,
  nested: { wonAt: wonDetails.wonAt, salespersonCommissionInc: 555, netProfit: 666, agencyCommissionRate: 25 },
  encoded: JSON.stringify({ agencyCommissionRate: 25, agencyProfitAfterSalesInc: 123 }) };
const privateData = {};
for (const [index, key] of QUOTE_ROW_KEYS.entries()) privateData[key] = index % 2 ? [clone(secretRow)] : JSON.stringify([secretRow]);
for (const [index, key] of QUOTE_DEF_KEYS.entries()) privateData[key] = index % 2 ? [{ ...def, agencyCommissionRate: 25 }] : JSON.stringify([{ ...def, agencyCommissionRate: 25 }]);
for (const [index, key] of ['installerSavedQuoteSetsV1', 'greenEnergySavedQuoteSetsV1', 'SavedQuoteSetsV1'].entries()) {
  const backup = [{ id: 'private-backup', quotes: [secretRow], optionDefs: [{ ...def, agencyCommissionRate: 25 }] }];
  privateData[key] = index % 2 ? backup : JSON.stringify(backup);
}
privateData[QUOTE_ARRANGEMENT_KEY] = JSON.stringify({ receipts: [{ patch: { rows: [secretRow] } }], unknown: { secret: secretRow } });
privateData.greenEnergyCommissionSettingsV1 = JSON.stringify({ agencyCommissionRate: 25 });
const privateBusiness = { installerCommissionSettingsV1: JSON.stringify({ agencyCommissionRate: 25 }),
  greenEnergyManagedPricesV1: JSON.stringify({ model: { unitPriceInc: 100, agencyCommissionRate: 25, agencyProfitAfterSalesInc: 123 } }),
  installerDefaultCostRulesV1: { powerCost: 100, agencyCommissionRate: 25 } };
function assertRestricted(data) {
  assert.ok(!(QUOTE_ARRANGEMENT_KEY in data));
  for (const key of QUOTE_ROW_KEYS) {
    const value = parse(data[key])[0];
    assert.equal(value.salespersonCommissionInc, 42);
    assert.equal(value.netProfit, 84);
    assert.ok(!('agencyCommissionRate' in value) && !('agencyProfitAfterSalesInc' in value) && !('netMargin' in value));
    assert.deepEqual(Object.keys(value.nested), ['wonAt']);
    assert.deepEqual(JSON.parse(value.encoded), {});
  }
  for (const key of QUOTE_DEF_KEYS) assert.ok(!('agencyCommissionRate' in parse(data[key])[0]));
  assert.ok(!('installerCommissionSettingsV1' in data) && !('greenEnergyCommissionSettingsV1' in data));
  assert.ok(!JSON.stringify(data).includes('agencyCommissionRate') && !JSON.stringify(data).includes('agencyProfitAfterSalesInc'));
  assert.equal(parse(data.greenEnergySavedQuoteSetsV1)[0].quotes[0].salespersonCommissionInc, 42);
}
assertRestricted(rawContext.sanitizeCalculatorData({ ...privateData, ...privateBusiness }, { canSeeCommissionDetails: false, canSeeProfitDetails: false, canSeeSalespersonCommission: true }));
assert.ok(!(QUOTE_ARRANGEMENT_KEY in rawContext.sanitizeCalculatorData(privateData, { canSeeCommissionDetails: true, canSeeProfitDetails: true })));
for (const ledger of [{ receipts: [{ patch: { rows: [secretRow] } }] }, [secretRow], JSON.stringify({ unknown: secretRow })]) {
  assert.ok(!(QUOTE_ARRANGEMENT_KEY in visibleCalculatorData({ [QUOTE_ARRANGEMENT_KEY]: ledger }, false, true)));
}
const maskedMutation = quoteLibraryResponseRow(secretRow, false, true);
assert.deepEqual(Object.keys(maskedMutation.nested), ['wonAt']);
assert.ok(!('netMargin' in maskedMutation));
function readEndpoint({ role = 'user', targetRole = 'user', locked = false, approved = true, initialData = privateData } = {}) {
  const db = { auth: { getUser: async () => ({ data: { user: { id: 'user', email: 'actor@example.test' } } }) }, from(table) {
    const query = { select() { return query; }, eq() { return query; }, async maybeSingle() {
      return { data: table === 'user_calculator_data' ? { data: clone(initialData) } : table === 'business_calculator_data' ? { data: clone(privateBusiness) } : null, error: null };
    } }; return query;
  } };
  const sandbox = { URL, canManageUsers, isOwnerEmail, canSeeCommissionDetails, canSeeProfitDetails, visibleCalculatorData, applyStoredQuoteAdminUnlocks,
    validatedBusinessConfigurationData, withoutBusinessConfiguration,
    CERTIFICATE_VALUES_STORAGE_KEYS, PLATFORM_CERTIFICATE_VALUES_ID, overlayPlatformCertificateValues, platformCertificateValuesFromRow,
    DCCEEW_CONTRACT_RATE: 30, DCCEEW_ELIGIBLE_POSTCODES: [], DCCEEW_ELIGIBLE_PRODUCT_KEYS: [],
    NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) }, createSupabaseServerClient: async () => db,
    currentApprovedUser: async (_db, email) => ({ data: approved ? { role: email === 'actor@example.test' ? role : targetRole, is_locked: locked } : null, error: null }),
    resolveBusinessId: async () => 'business', stripCertificateValueKeys: data => data };
  for (const name of ['targetEmailFromRequest', 'mutationFinancialsVisible', 'GET']) {
    const fn = routeAst.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === name);
    vm.runInNewContext(ts.transpileModule(fn.getText(routeAst).replace(/^export /, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  }
  return query => sandbox.GET(new Request(`https://test.invalid/api/calculator-data${query || ''}`));
}
for (const [settings, query, full] of [
  [{}, '', false], [{ role: 'admin' }, '?as=sales@test&preview=1', false],
  [{ role: 'user' }, '?as=admin@test', false], [{ role: 'admin' }, '?as=sales@test', true],
  [{ role: 'business_owner' }, '', true], [{ role: 'admin', targetRole: 'business_owner' }, '?as=owner@test&preview=1', true],
]) {
  const result = await readEndpoint(settings)(query);
  assert.equal(result.status, 200);
  assert.ok(!(QUOTE_ARRANGEMENT_KEY in result.body.data), 'GET never returns server receipts');
  if (full) assert.equal(parse(result.body.data[QUOTE_ROW_KEYS[0]])[0].agencyCommissionRate, 25);
  else assertRestricted(result.body.data);
}
assert.equal((await readEndpoint({ locked: true })()).status, 403);
assert.equal((await readEndpoint({ approved: false })()).status, 403);

// Permanent snapshot conflicts carry a masked, scoped recovery patch without writes.
const recoveryData = clone(withForeign);
const unaffectedDef = { id: 'unaffected', name: 'Unrelated', quoteFamilyId: 'unaffected', quoteOptionName: 'Option 1', quoteOptionOrder: 0 };
const unaffectedRow = { ...row, id: 'unaffected-row', optionId: 'unaffected', quotePosition: 0 };
for (const key of QUOTE_DEF_KEYS) recoveryData[key] = JSON.stringify([...defs(withForeign), unaffectedDef]);
for (const key of QUOTE_ROW_KEYS) recoveryData[key] = JSON.stringify([...rows(withForeign), unaffectedRow]);
const recoveryInput = {
  [QUOTE_ROW_KEYS[0]]: JSON.stringify([
    { ...row, id: 'foreign', optionId: 'a', finalInc: 9900, syncUpdatedAt: 25000 },
    { ...row, id: 'conflicting-new', optionId: 'a', quotePosition: 1 },
    { ...unaffectedRow, finalInc: 7000, syncUpdatedAt: 25000 },
    { ...unaffectedRow, id: 'unaffected-new', quotePosition: 1 },
  ]),
  unrelatedDraft: 'preserve this local edit',
};
const recovering = endpoint({ initialData: recoveryData });
const recoveryResponse = await recovering.call({ data: recoveryInput });
assert.equal(recoveryResponse.status, 409);
assert.equal(recoveryResponse.body.code, 'QUOTE_OPTION_CONFLICT');
assert.equal(recovering.state.writes, 0);
const recoveryPatch = recoveryResponse.body.currentFamily;
assert.equal(recoveryPatch.rows.find(value => value.id === 'foreign').optionId, 'legacy-x', 'foreign-source row is restored to its actual stored membership');
assert.ok(recoveryPatch.defs.every(value => value.quoteFamilyId === 'a'));
assert.ok(!recoveryPatch.rows.some(value => value.optionId === 'unaffected'));
assert.ok(recoveryPatch.removedRowIds.includes('conflicting-new'));
assert.ok(!recoveryPatch.removedRowIds.includes('unaffected-new'));
assert.ok(recoveryPatch.rows.every(value => !('agencyCommissionRate' in value) && !('agencyCommissionRate' in value.state)), 'recovery patches retain preview/role masking');
const localById = new Map(parse(recoveryInput[QUOTE_ROW_KEYS[0]]).map(value => [value.id, value]));
for (const id of recoveryPatch.removedRowIds) localById.delete(id);
for (const value of recoveryPatch.rows) localById.set(value.id, value);
const resolvedInput = { ...recoveryInput, [QUOTE_ROW_KEYS[0]]: JSON.stringify([...localById.values()]) };
assert.equal((await recovering.call({ data: resolvedInput })).status, 200);
assert.equal(rows(recovering.state.record.data).find(value => value.id === 'unaffected-row').finalInc, 7000);
assert.ok(rows(recovering.state.record.data).some(value => value.id === 'unaffected-new'));
assert.equal(recovering.state.record.data.unrelatedDraft, 'preserve this local edit');

const staleMoveApi = endpoint({ initialData: moved.data });
const staleMove = await staleMoveApi.call({ data: { [QUOTE_ROW_KEYS[0]]: JSON.stringify([row]) } });
assert.equal(staleMove.body.code, 'QUOTE_OPTION_CONFLICT');
assert.equal(staleMove.body.currentFamily.rows.find(value => value.id === 'r1').optionId, b);
const deletedApi = endpoint({ initialData: deleted.data });
const deletedConflict = await deletedApi.call({ data: {
  [QUOTE_DEF_KEYS[0]]: JSON.stringify(defs(moved.data)),
  [QUOTE_ROW_KEYS[0]]: JSON.stringify([{ ...row, id: 'local-after-delete', optionId: b, quotePosition: 0 }]),
} });
assert.equal(deletedConflict.body.code, 'QUOTE_OPTION_CONFLICT');
assert.ok(deletedConflict.body.currentFamily.removedOptionIds.includes(b));
assert.ok(deletedConflict.body.currentFamily.removedRowIds.includes('local-after-delete'));
assert.ok(deletedConflict.body.currentFamily.defs.some(value => value.id === 'a'), 'deleted-option receipt resolves its surviving family');
const collisionApi = endpoint({ initialData: batchBase });
const collisionConflict = await collisionApi.call({ data: { [QUOTE_ROW_KEYS[0]]: JSON.stringify([{ ...firstNative, quotePosition: 0 }]) } });
assert.equal(collisionConflict.body.code, 'QUOTE_OPTION_CONFLICT');
assert.ok(collisionConflict.body.currentFamily.removedRowIds.includes('batch-first'));
const neverWins = { from() {
  let updating = false;
  const query = { select() { return updating ? Promise.resolve({ data: [], error: null }) : query; },
    eq() { return query; }, is() { return query; }, update() { updating = true; return query; },
    maybeSingle: async () => ({ data: { user_id: 'user', updated_at: '2026-10-27T00:00:00Z', data: initial }, error: null }) };
  return query;
} };
const exhaustedCas = await save(neverWins, request(initial, 'addOption'));
assert.equal(exhaustedCas.status, 409);
assert.equal(exhaustedCas.code, undefined, 'CAS exhaustion remains transient, distinct from topology recovery');

// P1: execute the actual admin update, preserving its first-alias-only, unbumped output.
function installFunctions(ast, names, sandbox) {
  for (const name of names) {
    const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(fn, name);
    vm.runInNewContext(ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  }
}
const actualAdmin = { dbMessage: error => error.message };
for (const name of ['CURRENT_WON_SOURCE_ID', 'WON_PAYMENT_KEYS', 'OPTION_DEF_STORAGE_KEYS', 'QUOTE_STORAGE_KEYS', 'SAVED_QUOTE_SET_STORAGE_KEYS', 'WON_OPTION_ADMIN_STATE_STORAGE_KEYS', 'DELETED_WON_OPTIONS_STORAGE_KEYS', 'WON_PAYMENT_ALREADY_RECORDED']) {
  const statement = adminAst.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(value => value.name.getText(adminAst) === name));
  assert.ok(statement, name);
  vm.runInNewContext(ts.transpileModule(statement.getText(adminAst), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, actualAdmin);
}
installFunctions(adminAst, ['lookupText', 'parseStoredJson', 'storedJsonKey', 'serializeLikeStoredValue', 'wonOptionId', 'wonOptionKey', 'wonAdminStateKey', 'normalizeWonAdminStateRecord',
  'clearWonPaymentFields', 'backupSourceParts', 'wonOptionPaymentAlreadyRecorded', 'wonAdminPaymentAlreadyRecorded', 'upsertWonAdminState', 'saveWonCalculatorSnapshot', 'updateWonOptionState'], actualAdmin);
const rawUnlock = { applyStoredQuoteAdminUnlocks };
for (const name of ['CURRENT_WON_SOURCE_ID', 'OPTION_DEF_STORAGE_KEYS', 'QUOTE_STORAGE_KEYS', 'SAVED_QUOTE_SET_STORAGE_KEYS', 'WON_OPTION_ADMIN_STATE_STORAGE_KEYS']) {
  const statement = rawAst.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(value => value.name.getText(rawAst) === name));
  vm.runInNewContext(ts.transpileModule(statement.getText(rawAst), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, rawUnlock);
}
installFunctions(rawAst, ['parseStoredJson', 'storedJsonKey', 'serializeLikeStoredValue', 'savedQuoteSetSourceId', 'clearWonFields', 'wonAdminUnlockRecords', 'applyWonAdminUnlocks'], rawUnlock);
for (const single of [false, true]) for (const parentOnly of [false, true]) {
  const before = clone(selectedWon);
  if (single) for (const key of [...QUOTE_DEF_KEYS.slice(1), ...QUOTE_ROW_KEYS.slice(1)]) delete before[key];
  if (parentOnly) for (const key of QUOTE_ROW_KEYS.filter(key => key in before)) before[key] = JSON.stringify(parse(before[key]).map(value => {
    const copy = clone(value); delete copy.wonAt; return copy;
  }));
  const adminDb = database(before);
  assert.equal(await actualAdmin.updateWonOptionState(adminDb.db, 'user@test', 'a', 'unlock', 'admin@test', 'current', 'user', 'user@test', wonDetails.wonAt), '');
  const actualOutput = clone(adminDb.state.record.data);
  assert.equal(defs(actualOutput)[0].syncUpdatedAt, defs(before)[0].syncUpdatedAt, 'actual admin action leaves record versions unchanged');
  if (!single) assert.equal(parse(actualOutput[QUOTE_DEF_KEYS[1]])[0].wonAt, wonDetails.wonAt, 'repro retains stale secondary won alias before helper');
  const normalizedOutput = applyStoredQuoteAdminUnlocks(actualOutput);
  assert.deepEqual(applyStoredQuoteAdminUnlocks(normalizedOutput), normalizedOutput, 'trusted unlock normalization is idempotent');
  for (const key of [...QUOTE_DEF_KEYS, ...QUOTE_ROW_KEYS].filter(key => key in before)) for (const value of parse(normalizedOutput[key])) {
    assert.ok(!value.wonAt && !value.paidInAt && !value.paidOutAt);
    if (value.id === 'r2') {
      assert.deepEqual(value.privateExtension, row.privateExtension);
      assert.equal(value.finalInc, 9900);
      assert.ok(!value.state.wonAt && !value.state.paidOutAt);
    }
  }
  const readBack = (await readEndpoint({ initialData: actualOutput })()).body.data;
  for (const key of [...QUOTE_DEF_KEYS, ...QUOTE_ROW_KEYS].filter(key => key in actualOutput)) assert.ok(!parse(readBack[key]).some(value => value.wonAt));
  const bootstrap = rawUnlock.applyWonAdminUnlocks(actualOutput);
  assert.deepEqual(defs(bootstrap), defs(normalizedOutput));
  const append = endpoint({ initialData: actualOutput });
  assert.equal((await append.call({ data: { [QUOTE_ROW_KEYS[0]]: JSON.stringify([{ ...row, id: `post-admin-${single}-${parentOnly}`, optionId: b, quotePosition: 1, syncUpdatedAt: 25000 }]) } })).status, 200,
    'the very first request after actual admin unlock may append without an empty healing save');
  const accept = endpoint({ initialData: actualOutput });
  const newAcceptance = { ...wonDetails, wonAt: new Date(Date.now() + 60000).toISOString() };
  const acceptInput = { [QUOTE_DEF_KEYS[0]]: JSON.stringify(defs(bootstrap).map(value => value.id === b ? { ...value, ...newAcceptance, syncUpdatedAt: Date.now() + 70000 } : value)),
    [QUOTE_ROW_KEYS[0]]: JSON.stringify(rows(bootstrap).map(value => value.optionId === b ? { ...value, ...newAcceptance, syncUpdatedAt: Date.now() + 70000 } : value)) };
  assert.equal((await accept.call({ data: acceptInput })).status, 200, 'alternate acceptance may be the first API request after actual admin unlock');
  assert.deepEqual(defs(accept.state.record.data).filter(value => value.wonAt).map(value => value.id), [b]);
  const stale = clone(before);
  for (const key of [...QUOTE_DEF_KEYS, ...QUOTE_ROW_KEYS].filter(key => key in stale)) stale[key] = JSON.stringify(parse(stale[key]).map(value => ({ ...value, syncUpdatedAt: 4e12, unrelatedEdit: 'must survive' })));
  const staleApi = endpoint({ initialData: actualOutput });
  assert.equal((await staleApi.call({ data: stale })).status, 200);
  assert.ok(!defs(staleApi.state.record.data).some(value => value.wonAt));
  assert.ok(!rows(staleApi.state.record.data).some(value => value.wonAt || value.paidInAt || value.state?.wonAt || value.state?.paidOutAt));
  assert.equal(rows(staleApi.state.record.data)[0].unrelatedEdit, 'must survive');
  const newOnSameOption = clone(normalizedOutput);
  for (const key of QUOTE_DEF_KEYS.filter(key => key in newOnSameOption)) newOnSameOption[key] = JSON.stringify(parse(newOnSameOption[key]).map(value => value.id === 'a' ? { ...value, ...newAcceptance, paidInAt: 'new-payment', syncUpdatedAt: Date.now() + 90000 } : value));
  for (const key of QUOTE_ROW_KEYS.filter(key => key in newOnSameOption)) newOnSameOption[key] = JSON.stringify(parse(newOnSameOption[key]).map(value => value.optionId === 'a' ? { ...value, ...newAcceptance, syncUpdatedAt: Date.now() + 90000 } : value));
  const preservedNew = mergeCalculatorData(newOnSameOption, stale);
  assert.equal(defs(preservedNew).find(value => value.id === 'a').wonAt, newAcceptance.wonAt, 'old marker never erases a genuinely new acceptance');
  assert.equal(defs(preservedNew).find(value => value.id === 'a').paidInAt, 'new-payment');
  const acceptanceRace = database(actualOutput, () => clone(newOnSameOption));
  const racedSave = await save(acceptanceRace.db, undefined, false, { [QUOTE_ROW_KEYS[0]]: JSON.stringify([{ ...row, id: 'cas-race-new', optionId: b, quotePosition: 1 }]) });
  assert.equal(racedSave.code, 'QUOTE_OPTION_CONFLICT', 'CAS retry rechecks the freshly accepted alternative rather than reusing normalized old state');
  assert.equal(defs(acceptanceRace.state.record.data).find(value => value.id === 'a').wonAt, newAcceptance.wonAt);
  const markerKey = 'installerWonOptionAdminStateV1';
  for (const wrong of [{ sourceId: 'saved:other' }, { optionId: 'other' }, { wonAt: 'different-opportunity' }]) {
    const scoped = clone(actualOutput); scoped[markerKey] = JSON.stringify(parse(scoped[markerKey]).map(value => ({ ...value, ...wrong })));
    if (!single) assert.equal(applyStoredQuoteAdminUnlocks(scoped)[QUOTE_DEF_KEYS[1]], scoped[QUOTE_DEF_KEYS[1]], 'nonmatching marker cannot clear working won aliases');
  }
}
for (const key of ['installerWonOptionAdminStateV1', 'greenEnergyWonOptionAdminStateV1', 'WonOptionAdminStateV1']) for (const method of ['PUT', 'POST']) {
  const forged = endpoint({ initialData: selectedWon });
  assert.equal((await forged.call({ data: { ...unlockSnapshot, [key]: JSON.stringify([{ sourceId: 'current', optionId: 'a', wonAt: wonDetails.wonAt, unlockedAt: new Date().toISOString() }]) } }, '', method)).status, 403);
  assert.equal(forged.state.writes, 0);
  assert.ok(!(key in mergeCalculatorData({}, { [key]: '[{"unlockedAt":"forged"}]' })), 'insert/merge cannot adopt a client admin marker');
}

// P1: exact calculator unlock output, without raw clearWonFields post-processing.
selectedWon = clone(selectedWon);
const oldLifecycle = { paymentRequestedAt: 'requested', paidInAt: 'paid-in', paidOutAt: 'paid-out', agencyPaidInAt: 'agency-paid', salespersonPaidOutAt: 'sales-paid',
  paymentStatus: 'payment_complete', archivedAt: 'archive', archived: true, paymentResetAt: 'reset', quoteLibraryEditSaveId: 'old-edit', quoteLibraryEditFingerprint: 'old-hash' };
for (const key of QUOTE_DEF_KEYS) selectedWon[key] = JSON.stringify(defs(selectedWon).map(value => value.id === 'a' ? { ...value, ...oldLifecycle, state: { ...oldLifecycle, customDef: 'keep' } } : value));
for (const key of QUOTE_ROW_KEYS) selectedWon[key] = JSON.stringify(rows(selectedWon).map(value => value.id === 'r2' ? { ...value, ...oldLifecycle, state: { ...value.state, ...oldLifecycle },
  privateExtension: { ...value.privateExtension, invoiceNotes: { paidInAt: 'unknown metadata stays' } } } : value));
const exactUi = uiUnlock(true);
assert.equal(exactUi.quoteOptionDefs[0].paidInAt, 'paid-in', 'the actual UI unlock really retains prior payment fields');
const exactUiApi = endpoint({ role: 'admin', initialData: selectedWon });
const exactUiPayload = { [QUOTE_DEF_KEYS[0]]: JSON.stringify(exactUi.quoteOptionDefs), [QUOTE_ROW_KEYS[0]]: JSON.stringify(exactUi.quotes) };
assert.equal((await exactUiApi.call({ data: exactUiPayload })).status, 200);
const exactSource = exactUiApi.state.record.data;
assert.equal(defs(exactSource)[0].paidInAt, 'paid-in');
installFunctions(adminAst, ['wonPaymentStatus', 'wonPaymentStatusLabel'], adminContext);
for (const action of ['addOption', 'duplicateOption', 'copyRow']) {
  const fields = action === 'copyRow' ? { rowId: 'r2', targetOptionId: b } : {};
  const payload = request(exactSource, action, fields);
  const output = success(exactSource, payload);
  const newDefs = output.defs.filter(value => !defs(exactSource).some(prior => prior.id === value.id));
  const newRows = output.rows.filter(value => !rows(exactSource).some(prior => prior.id === value.id));
  for (const value of [...newDefs, ...newRows]) for (const target of [value, ...(value.state ? [value.state] : [])]) {
    for (const key of ['wonAt', 'wonByEmail', 'wonByName', ...Object.keys(oldLifecycle)]) assert.ok(!(key in target), `${action} new identity must clear ${key}`);
  }
  for (const value of newDefs) assert.equal(value.installationAddress, defs(exactSource)[0].installationAddress, 'same-customer copies retain address/date');
  for (const value of newRows) {
    const original = rows(exactSource).find(value => value.id === 'r2');
    for (const key of ['unitInc', 'finalInc', 'labour', 'materialsInc', 'miscInc', 'powerCost', 'rebate', 'agencyCommissionInc', 'agencyCommissionRate', 'salespersonCommissionRate', 'privateExtension']) assert.deepEqual(value[key], original[key]);
    assert.deepEqual(value.state.custom, original.state.custom);
  }
  assert.equal(defs(output.data).find(value => value.id === 'a').paidInAt, 'paid-in', 'source lifecycle is not rewritten');
  if (action === 'addOption') continue;
  const chosen = output.selectedOptionId;
  const accepted = clone(output.data);
  const copiedWonAt = new Date(Date.now() + 60000).toISOString();
  for (const key of QUOTE_DEF_KEYS) accepted[key] = JSON.stringify(defs(output.data).map(value => value.id === chosen ? { ...value, ...wonDetails, wonAt: copiedWonAt, syncUpdatedAt: Date.now() + 80000 } : value));
  for (const key of QUOTE_ROW_KEYS) accepted[key] = JSON.stringify(rows(output.data).map(value => value.optionId === chosen ? { ...value, ...wonDetails, wonAt: copiedWonAt, syncUpdatedAt: Date.now() + 80000 } : value));
  const copiedAcceptance = endpoint({ role: 'admin', initialData: output.data });
  assert.equal((await copiedAcceptance.call({ data: { [QUOTE_DEF_KEYS[0]]: accepted[QUOTE_DEF_KEYS[0]], [QUOTE_ROW_KEYS[0]]: accepted[QUOTE_ROW_KEYS[0]] } })).status, 200);
  const aggregates = new Map();
  adminContext.addWonOptionsFromSnapshot({ wonOptions: aggregates, deletedWonOptions: new Set(), adminWonStates: new Map(), usersByEmail: new Map(), usersByName: new Map(),
    fallbackEmail: 'user@test', dataUserId: 'user', optionDefs: defs(copiedAcceptance.state.record.data), quotes: rows(copiedAcceptance.state.record.data), sourceId: 'current', updatedAt: wonDetails.wonAt });
  assert.equal(aggregates.size, 1);
  const result = [...aggregates.values()][0];
  assert.equal(result.paymentRequestedAt, ''); assert.equal(result.paidInAt, ''); assert.equal(result.paidOutAt, '');
  assert.notEqual(result.paymentStatus, 'payment_complete', 'a new copied alternative is never settled from the source payment');
}
const movedLifecycle = success(exactSource, request(exactSource, 'moveRow', { rowId: 'r2', targetOptionId: b }));
assert.equal(rows(movedLifecycle.data).find(value => value.id === 'r2').paidInAt, 'paid-in');
assert.deepEqual(rows(movedLifecycle.data).find(value => value.id === 'r2').state, rows(exactSource).find(value => value.id === 'r2').state, 'move preserves lifecycle and exact state for the existing identity');
console.log('Quote arrangement backend checks passed: atomic actions, retries, CAS races, topology fences, aliases, legacy edits, copies, family locks and role masking.');
