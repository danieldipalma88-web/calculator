import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import {
  isWonBatchId, isWonBatchKind, parseWonBatchIds, resolveWonBatchJobs, runWonBatch,
  sameWonBatchSelection, wonBatchJobId, wonPaymentReviewFingerprint, WON_BATCH_MAX_JOBS,
} from "../lib/won-batches.ts";
import { wonReportAmounts } from "../lib/won-reporting.ts";

const [page, schema, panels] = await Promise.all([
  readFile(new URL("../app/admin/users/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../supabase/won_job_batches_upgrade.sql", import.meta.url), "utf8"),
  readFile(new URL("../app/admin/users/won-panels.tsx", import.meta.url), "utf8"),
]);
const ast = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const find = (tree, name) => {
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    if (!found) ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(found, name);
  return found.getText(tree);
};
const js = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const plain = (value) => JSON.parse(JSON.stringify(value));

const admin = "admin@example.test";
const token = "a712be75-1147-44a1-9be0-56b635b5cfd2";
const job = (optionId, overrides = {}) => ({
  optionId, optionName: optionId, userEmail: "rep@example.test", userName: "Rep",
  dataUserId: "snapshot-owner", dataOwnerEmail: "owner@example.test", sourceId: "current",
  wonAt: "2026-11-02T00:00:00Z", recoveredFromBackup: false, ...overrides,
});
const jobs = [job("First"), job("Second", { paidInAt: "already" }), job("Third")].map((job, index) => ({
  ...job, review: { fingerprint: String(index + 1).repeat(64) },
}));
const ids = jobs.map(wonBatchJobId);
const reviews = jobs.map((job) => job.review.fingerprint);
const form = (mode, selected = ids, reviewed = reviews) => {
  const body = new FormData();
  body.set("bulkMode", mode);
  body.set("wonBatchToken", token);
  body.set("wonBatchIds", JSON.stringify(selected));
  body.set("wonBatchReviews", JSON.stringify(reviewed));
  body.set("wonBatchName", " Earlier group ");
  body.set("wonBatchIncludeBackups", "1");
  body.set("selectedWonOptions", JSON.stringify([{ userEmail: "forged@example.test", agencyCommissionTotal: 1000000 }]));
  return body;
};
const log = [];
let denied = false;
let startStatus = "created";
let stored;
let storedOutcomes = [];
let lostOutcome = false;
let existingBatch = null;
const context = vm.createContext({
  URLSearchParams, isWonBatchId, isWonBatchKind, parseWonBatchIds, resolveWonBatchJobs, runWonBatch, sameWonBatchSelection, WON_BATCH_MAX_JOBS,
  WON_PAYMENT_ALREADY_RECORDED: "already recorded",
  requireAdmin: async () => {
    if (denied) throw new Error("not admin");
    log.push("auth");
    return { supabase: {}, email: admin };
  },
  listApprovedUsers: async () => ({ data: [], errorMessage: "" }),
  getWonBatch: async () => ({ batch: existingBatch, error: null }),
  listWonOptions: async (_supabase, _users, includeBackups) => {
    assert.equal(includeBackups, true);
    log.push("resolve");
    return { data: jobs, errorMessage: "" };
  },
  startWonBatch: async (_supabase, intent, email) => {
    assert.equal(email, admin);
    log.push("intent");
    stored = plain(intent);
    return startStatus;
  },
  recordWonBatchOutcomes: async (_supabase, id, outcomes) => {
    assert.equal(id, token);
    log.push(`record ${outcomes.length}`);
    if (lostOutcome) return false;
    storedOutcomes = plain(outcomes);
    return true;
  },
  updateWonOptionState: async (_supabase, email, optionId, mode, actor, sourceId, ownerId, ownerEmail, wonAt, review) => {
    log.push(`update ${optionId}`);
    assert.equal(email, "rep@example.test", "Use the server-resolved salesperson, not submitted fields");
    assert.equal(ownerId, "snapshot-owner");
    assert.equal(ownerEmail, "owner@example.test");
    assert.equal(actor, admin);
    assert.equal(mode, "paid_in");
    assert.equal(sourceId, "current");
    assert.equal(wonAt, jobs[0].wonAt);
    assert.equal(review.fingerprint, jobs.find((job) => job.optionId === optionId).review.fingerprint);
    return optionId === "First" ? "Quote changed" : "";
  },
  revalidatePath: () => log.push("refresh"),
  redirect: (location) => { throw Object.assign(new Error("redirect"), { location }); },
});
vm.runInContext(js(["submitWonBatch", "bulkUpdateWonOptions"].map((name) => find(ast, name)).join("\n")), context);
async function submit(body) {
  try { await context.bulkUpdateWonOptions(body); }
  catch (error) {
    if (!error.location) throw error;
    return new URL(error.location, "https://example.test");
  }
  assert.fail("Expected a redirect");
}
const first = await submit(form("paid_in"));
assert.equal(first.hash, "#won-options");
assert.equal(first.searchParams.get("wonBatch"), token);
assert.equal(first.searchParams.get("checkBackups"), "1");
assert.match(first.searchParams.get("error"), /1 updated, 1 already recorded, 1 failed/);
assert.deepEqual(log.splice(0), ["auth", "resolve", "intent", "update First", "record 1", "record 2", "update Third", "record 3", "refresh"]);
assert.deepEqual(stored.items.map(({ id }) => id), ids, "Persist all selected jobs, including ineligible ones");
assert.deepEqual(storedOutcomes.map(({ status }) => status), ["failed", "already_recorded", "confirmed"]);
assert.deepEqual(Object.keys(stored.items[0]).sort(), ["id", "quote", "recovered", "salesperson"]);
existingBatch = { ...stored, actor_email: admin };
assert.match((await submit(form("paid_in", ids, ["9".repeat(64), ...reviews.slice(1)]))).searchParams.get("message"), /already submitted/);
assert.deepEqual(log.splice(0), ["auth"], "A matching token can reopen its existing batch without replaying stale reviews");
existingBatch = null;
const changed = await submit(form("paid_in", ids, ["9".repeat(64), ...reviews.slice(1)]));
assert.match(changed.searchParams.get("error"), /quote changed/);
assert.deepEqual(log.splice(0), ["auth", "resolve"]);
jobs[2].recoveredFromBackup = true;
assert.match((await submit(form("paid_in"))).searchParams.get("error"), /read-only/);
assert.deepEqual(log.splice(0), ["auth", "resolve"], "Recovered payment selections cannot create an intent or update any jobs");

const manual = await submit(form("manual"));
assert.match(manual.searchParams.get("message"), /manual group.*No payment statuses changed/);
assert.equal(stored.label, "Earlier group");
assert.equal(stored.items[2].recovered, true, "Manual groups may contain recovered backups");
assert.deepEqual(log.splice(0), ["auth", "resolve", "intent", "refresh"]);
jobs[2].recoveredFromBackup = false;
const missing = await submit(form("paid_in", [ids[0], "f".repeat(64)], reviews.slice(0, 2)));
assert.match(missing.searchParams.get("error"), /no longer available/);
assert.deepEqual(log.splice(0), ["auth", "resolve"]);
for (const status of ["unavailable", "replayed", "conflict"]) {
  startStatus = status;
  const result = await submit(form("paid_in"));
  assert.ok(result.searchParams.get(status === "replayed" ? "message" : "error"));
  assert.deepEqual(log.splice(0), ["auth", "resolve", "intent"]);
}
startStatus = "created";
lostOutcome = true;
const interrupted = await submit(form("paid_in"));
assert.match(interrupted.searchParams.get("error"), /3 unconfirmed/);
assert.deepEqual(log.splice(0), ["auth", "resolve", "intent", "update First", "record 1", "refresh"]);
denied = true;
await assert.rejects(submit(form("paid_in")), /not admin/);
assert.deepEqual(log, []);

const snapshotContext = vm.createContext({
  wonReportAmounts, wonPaymentReviewFingerprint, dbMessage: (error) => error.message,
});
const constants = [
  "CURRENT_WON_SOURCE_ID", "WON_PAYMENT_ALREADY_RECORDED", "WON_PAYMENT_KEYS", "OPTION_DEF_STORAGE_KEYS",
  "QUOTE_STORAGE_KEYS", "SAVED_QUOTE_SET_STORAGE_KEYS", "DELETED_WON_OPTIONS_STORAGE_KEYS", "WON_OPTION_ADMIN_STATE_STORAGE_KEYS",
];
for (const name of constants) {
  const declaration = ast.statements.find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((decl) => decl.name.getText(ast) === name));
  assert.ok(declaration, name);
  vm.runInContext(js(declaration.getText(ast)), snapshotContext);
}
vm.runInContext(js([
  "lookupText", "displayNameFor", "parseStoredJson", "storedJsonKey", "serializeLikeStoredValue", "moneyValue",
  "optionalMoneyValue", "optionRowLabel", "quotePowerOrElectricianEx", "quoteMaterialsInc", "quoteRebateValue",
  "quoteStateDisablesRebates", "quoteAgencyProfitAfterSalesInc", "wonPaymentStatus", "wonPaymentStatusLabel",
  "wonOptionId", "wonOptionKey", "deletedWonOptionKey", "deletedWonOptionKeysFromData", "wonAdminStateKey",
  "normalizeWonAdminStateRecord", "wonAdminStateRecordsFromData", "newerAdminStateRecord", "addWonOptionsFromSnapshot",
  "wonReadableStorageKey", "wonSnapshotReader", "savedQuoteSetSourceId", "backupSourceParts", "clearWonPaymentFields",
  "applyWonPaymentFields", "wonOptionPaymentAlreadyRecorded", "wonAdminPaymentAlreadyRecorded", "upsertWonAdminState",
  "saveWonCalculatorSnapshot", "updateWonOptionState",
].map((name) => find(ast, name)).join("\n")), snapshotContext);

const defsKey = "installerQuoteOptionDefsV1";
const rowsKey = "installerMasterQuoteLogV1";
const setsKey = "installerSavedQuoteSetsV1";
const stateKey = "installerWonOptionAdminStateV1";
const wonAt = "2026-11-02T00:00:00Z";
const reqAt = "2026-11-03T00:00:00Z";
const receiptAt = "2026-11-04T00:00:00Z";
const payoutAt = "2026-11-05T00:00:00Z";
const snapshot = (fields = {}) => ({
  user_id: "owner-id", email: "owner@example.test", updated_at: "2026-11-06T00:00:00Z",
  data: {
    [defsKey]: [{ id: "case", name: "Fixture case", wonByEmail: "rep@example.test", wonAt, ...fields }],
    [rowsKey]: [{ id: "system", optionId: "case", wonAt, finalInc: 100, agencyCommissionInc: 80, salespersonCommissionInc: 50, netProfit: 20 }],
  },
});
const currentJob = (row, sourceId) => {
  const reader = snapshotContext.wonSnapshotReader([]);
  reader.collectState(row);
  reader.scan(row, row.updated_at, "", sourceId);
  return [...reader.wonOptions.values()][0];
};
function mockDatabase(initial, casConflict = false) {
  const state = { row: structuredClone(initial), writes: 0, commits: 0, reads: 0, compared: [] };
  return {
    state, db: { from(table) {
      assert.equal(table, "user_calculator_data", "No recovered backup access for payment writes");
      let pending;
      let expectedVersion;
      const query = {
        select() {
          if (!pending) return query;
          state.writes++;
          if (casConflict || expectedVersion !== state.row.updated_at) return { status: 200, data: [], error: null };
          state.row = { ...state.row, ...structuredClone(pending) };
          state.commits++;
          return { status: 200, data: [{ user_id: state.row.user_id }], error: null };
        },
        eq(column, value) {
          if (pending && column === "updated_at") {
            expectedVersion = value;
            state.compared.push(value);
          }
          return query;
        },
        update(payload) { pending = payload; return query; },
        maybeSingle() { state.reads++; return { data: structuredClone(state.row), error: null }; },
      };
      return query;
    } },
  };
}
function changePayment(database, mode, review, source = "current") {
  return snapshotContext.updateWonOptionState(database.db, "rep@example.test", "case", mode, admin, source,
    "owner-id", "owner@example.test", wonAt, review && { fingerprint: review.review.fingerprint, users: [] });
}
for (const [mode, prior, at, by, expected] of [
  ["paid_out", { agencyPaidInAt: receiptAt, agencyPaidInByEmail: "receiver@example.test" }, "paidInAt", "paidInByEmail", receiptAt],
  ["paid_in", { salespersonPaidOutAt: payoutAt, salespersonPaidOutByEmail: "payer@example.test" }, "paidOutAt", "paidOutByEmail", payoutAt],
]) {
  const initial = snapshot({ ...prior, paymentRequestedAt: reqAt, paymentRequestedByEmail: "requester@example.test" });
  const db = mockDatabase(initial);
  assert.equal(await changePayment(db, mode, currentJob(initial)), "");
  assert.equal(db.state.writes, 1);
  assert.deepEqual(db.state.compared, [initial.updated_at]);
  const effective = currentJob(db.state.row);
  assert.equal(effective.paymentStatus, "payment_complete");
  assert.equal(effective[at], expected);
  assert.equal(effective.paymentFields[by], Object.values(prior)[1]);
  assert.equal(effective.paymentRequestedAt, reqAt);
  assert.equal(effective.paymentFields.paymentRequestedByEmail, "requester@example.test");
  assert.equal(db.state.row.data[defsKey][0][Object.keys(prior)[0]], expected);
}

const legacyBlank = snapshot({ agencyPaidInAt: receiptAt });
legacyBlank.data[rowsKey][0].agencyPaidInAt = receiptAt;
legacyBlank.data[rowsKey][0].agencyPaidInByEmail = "row-actor@example.test";
legacyBlank.data[stateKey] = [{
  userEmail: "rep@example.test", optionId: "case", wonAt, paidInAt: "", paidOutAt: payoutAt,
}];
assert.equal(currentJob(legacyBlank).paidInAt, receiptAt, "A non-reset admin blank must not hide a snapshot timestamp");
assert.equal(currentJob(legacyBlank).paymentFields.paidInByEmail, "row-actor@example.test");

const reset = snapshot({ paymentRequestedAt: reqAt, paidInAt: receiptAt, paidInByEmail: "old@example.test", paidOutAt: payoutAt });
reset.data[setsKey] = [{ id: "stale-copy", optionDefs: structuredClone(reset.data[defsKey]), quotes: structuredClone(reset.data[rowsKey]) }];
const resetDb = mockDatabase(reset);
assert.equal(await changePayment(resetDb, "reset_payment"), "");
assert.equal(currentJob(resetDb.state.row).paidInAt, "");
assert.equal(currentJob(resetDb.state.row, "saved:stale-copy").paidInAt, "");
assert.equal(await changePayment(resetDb, "paid_out", currentJob(resetDb.state.row)), "");
for (const source of ["current", "saved:stale-copy"]) {
  const effective = currentJob(resetDb.state.row, source);
  assert.ok(effective.paidOutAt && effective.paidOutAt !== payoutAt);
  assert.ok(effective.paymentFields.paymentResetAt, "Keep a reset fence after recording a new status");
  assert.equal(effective.paymentFields.paidOutByEmail, admin);
  assert.equal(effective.paymentRequestedAt, "");
  assert.equal(effective.paidInAt, "");
  assert.equal(effective.paymentFields.paidInByEmail, "");
}

const beforeReview = snapshot();
const reviewedJob = currentJob(beforeReview);
for (const mutate of [
  (row) => { row.data[rowsKey][0].agencyCommissionInc++; },
  (row) => { row.data[defsKey][0].wonByEmail = "different-rep@example.test"; },
  (row) => { row.email = "different-owner@example.test"; },
  (row) => { row.data[defsKey][0].wonAt = row.data[rowsKey][0].wonAt = "2026-11-07T00:00:00Z"; },
  (row) => {
    row.data[setsKey] = [{ id: "moved", optionDefs: row.data[defsKey], quotes: row.data[rowsKey] }];
    delete row.data[defsKey]; delete row.data[rowsKey];
  },
]) {
  const changedRow = structuredClone(beforeReview);
  mutate(changedRow);
  const db = mockDatabase(changedRow);
  assert.match(await changePayment(db, "paid_in", reviewedJob), /changed before saving/);
  assert.equal(db.state.writes, 0, "Final-row changes must be rejected before writing");
}
const raced = mockDatabase(beforeReview, true);
assert.match(await changePayment(raced, "paid_in", reviewedJob), /changed during the update/);
assert.deepEqual(raced.state.compared, [beforeReview.updated_at]);

const duplicateSource = snapshot();
duplicateSource.data[setsKey] = [
  { id: "same-id", optionDefs: duplicateSource.data[defsKey], quotes: duplicateSource.data[rowsKey] },
  { id: "same-id", optionDefs: [{ ...duplicateSource.data[defsKey][0], wonByEmail: "different-rep@example.test" }],
    quotes: structuredClone(duplicateSource.data[rowsKey]) },
];
delete duplicateSource.data[defsKey];
delete duplicateSource.data[rowsKey];
const savedSource = "saved:same-id";
const firstSavedReview = currentJob(duplicateSource, savedSource);
duplicateSource.data[setsKey][1].quotes[0].salespersonCommissionInc = 777;
assert.equal(currentJob(duplicateSource, savedSource).review.fingerprint, firstSavedReview.review.fingerprint);
for (const mode of ["payment_requested", "paid_in", "paid_out", "reset_payment"]) {
  const duplicateDb = mockDatabase(duplicateSource);
  assert.match(await changePayment(duplicateDb, mode, mode === "reset_payment" ? undefined : firstSavedReview, savedSource),
    /Multiple saved quote groups/);
  assert.equal(duplicateDb.state.writes, 0);
  assert.deepEqual(duplicateDb.state.row, duplicateSource);
}
const uniqueSource = structuredClone(duplicateSource);
uniqueSource.data[setsKey][1].id = "separate";
const uniqueDb = mockDatabase(uniqueSource);
assert.equal(await changePayment(uniqueDb, "paid_out", firstSavedReview, savedSource), "");
assert.deepEqual(uniqueDb.state.row.data[setsKey][1], uniqueSource.data[setsKey][1]);

const duplicateOption = snapshot();
duplicateOption.data[defsKey].push({ ...duplicateOption.data[defsKey][0], wonByEmail: "different-rep@example.test" });
const duplicateOptionDb = mockDatabase(duplicateOption);
assert.match(await changePayment(duplicateOptionDb, "paid_out", currentJob(duplicateOption)), /Multiple options/);
assert.equal(duplicateOptionDb.state.writes, 0);

const sameMillisecond = snapshot();
sameMillisecond.updated_at = "2026-11-06T00:00:00.000Z";
const frozenDb = mockDatabase(sameMillisecond);
const originalNow = vm.runInContext("Date.now", snapshotContext);
for (const now of ["2026-11-06T00:00:00.000Z", "2026-11-05T23:59:59.999Z"]) {
  const versionDb = now === sameMillisecond.updated_at ? frozenDb : mockDatabase(sameMillisecond);
  try {
    vm.runInContext(`Date.now = () => Date.parse(${JSON.stringify(now)})`, snapshotContext);
    assert.equal(await changePayment(versionDb, "paid_in", currentJob(sameMillisecond)), "");
    assert.equal(versionDb.state.row.updated_at, "2026-11-06T00:00:00.001Z");
    const savedData = structuredClone(versionDb.state.row.data);
    assert.match(await snapshotContext.saveWonCalculatorSnapshot(versionDb.db, "user_id", sameMillisecond.user_id,
      sameMillisecond.data, sameMillisecond.updated_at, true), /changed during the update/);
    assert.equal(versionDb.state.commits, 1, "The stale CAS must affect zero rows");
    assert.deepEqual(versionDb.state.row.data, savedData);
    assert.deepEqual(versionDb.state.compared, [sameMillisecond.updated_at, sameMillisecond.updated_at]);
  } finally {
    vm.runInContext("Date", snapshotContext).now = originalNow;
  }
}
const unrelated = structuredClone(beforeReview);
unrelated.updated_at = "2026-11-06T10:00:00Z";
unrelated.data[defsKey].push({ id: "second-case", wonAt, paidInAt: receiptAt });
unrelated.data[rowsKey].push({ id: "second-system", optionId: "second-case", wonAt, finalInc: 400 });
const unrelatedDb = mockDatabase(unrelated);
assert.equal(await changePayment(unrelatedDb, "paid_in", reviewedJob), "", "An unrelated change to the same owner's snapshot does not invalidate this job's review");
assert.deepEqual(unrelatedDb.state.compared, [unrelated.updated_at]);
assert.deepEqual(unrelatedDb.state.row.data[defsKey][1], unrelated.data[defsKey][1]);
const readOnly = mockDatabase(beforeReview);
for (const mode of ["payment_requested", "paid_in", "paid_out", "reset_payment"]) {
  assert.match(await changePayment(readOnly, mode, reviewedJob, "backup:snapshot:current"), /read-only/);
}
assert.equal(readOnly.state.reads + readOnly.state.writes, 0);

const runtimeSource = {};
vm.runInNewContext(js(find(ast, "wonExportScript")), runtimeSource);
const runtimeText = runtimeSource.wonExportScript();
const runtime = ts.createSourceFile("runtime.js", runtimeText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const hiddenIds = {};
const backupScope = {};
const selectedTotals = {};
const card = (id, extra = {}) => {
  const box = { checked: false };
  const values = {
    "data-won-batch-job": id, "data-won-profit-total": "23", "data-won-agency-profit-total": "20",
    "data-won-agency-total": "100", "data-won-sales-total": "50", ...extra,
  };
  return { box, querySelector: () => box, getAttribute: (name) => values[name] || null };
};
const cards = [card(ids[0]), card(ids[1], { "data-won-profit-missing": "true", "data-payment-paid-out": "true" }), card(ids[2])];
cards[2].box.checked = true;
const selectionContext = vm.createContext({
  activeWonGroup: null,
  document: {
    querySelector: (selector) => selector === ".won-options-section" ? { getAttribute: () => null, querySelectorAll: () => cards }
      : selector === "[data-won-backup-scope]" ? { getAttribute: () => "1" } : null,
    querySelectorAll: (selector) => ({
      "[data-won-batch-ids]": [hiddenIds], "[data-won-batch-backups]": [backupScope],
      "[data-won-selected-totals]": [selectedTotals],
      ".won-sale-select:checked": cards.filter(({ box }) => box.checked).map(({ box }) => box),
    })[selector] || [],
  },
  numberFromCard: (card, field) => Number(card.getAttribute(field)),
  currency: (number) => `$${number.toFixed(2)}`,
  selectedWonCards: () => cards.filter(({ box }) => box.checked),
  setActiveSalespersonEmails() {}, setActivePaymentFilters() {},
  applyWonSalespersonFilter: () => cards.forEach((card) => { card.hidden = !selectionContext.wonCardInGroup(card); }),
});
vm.runInContext([
  "wonCardInGroup", "clearWonGroupAndChecks", "writeWonBatchInputs", "updateSelectedTotals", "reopenWonBatch",
].map((name) => find(runtime, name)).join("\n"), selectionContext);
const event = { detail: { ids: [ids[0], ids[1], "f".repeat(64)], opened: false } };
selectionContext.reopenWonBatch(event);
assert.equal(event.detail.opened, true);
assert.deepEqual(cards.map(({ box, hidden }) => [box.checked, hidden]), [[true, false], [true, false], [false, true]]);
selectionContext.writeWonBatchInputs(selectionContext.selectedWonCards());
assert.deepEqual(JSON.parse(hiddenIds.value), ids.slice(0, 2));
assert.equal(backupScope.value, "1");
selectionContext.updateSelectedTotals();
assert.match(selectedTotals.textContent, /Commission unpaid \$50.00/);
assert.match(selectedTotals.textContent, /Agency profit inc GST \$40.00/);
assert.match(selectedTotals.textContent, /Installer profit ex GST Incomplete/);
cards[1].box.checked = false;
selectionContext.updateSelectedTotals();
assert.match(selectedTotals.textContent, /Installer profit ex GST \$23.00/);
selectionContext.clearWonGroupAndChecks();
assert.equal(selectionContext.activeWonGroup, null);
assert.ok(cards.every(({ box }) => !box.checked));
assert.match(page, /<WonSelectionScope scope=\{JSON.stringify\(\[\s*includeBackupWonOptions, activeWonBatchId, wonBatchPage, params\?\.wonReport/);
assert.match(runtimeText, /admin:won-selection-scope-changed/);
assert.match(runtimeText, /if \(event.persisted && window\.__adminWonOptionsRuntime\)/);
assert.match(runtimeText, /addEventListener\("submit",[\s\S]+?__adminWonOptionsRuntime\.submit\(event\);\s*\}, true\)/);
assert.match(panels, /<caption>Weekly details<\/caption>/);

assert.match(schema, /enable row level security/);
assert.match(schema, /grant insert \(id, kind, label, items\), update \(outcomes\)/);
assert.match(schema, /actor_id = \(select auth.uid\(\)\) and kind <> 'manual'/);
assert.match(schema, /and approval.is_locked/);
assert.match(schema, /new.outcomes - previous_count <> old.outcomes/);
assert.doesNotMatch(schema, /security definer|user_calculator_data|grant delete/i);
console.log("Won batch action wiring, selected scope, totals, and additive SQL contract passed.");
