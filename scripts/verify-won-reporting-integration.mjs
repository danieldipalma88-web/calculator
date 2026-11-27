import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import {
  isWonBatchId, isWonBatchKind, parseWonBatchIds, resolveWonBatchJobs, runWonBatch,
  sameWonBatchSelection, wonBatchJobId, wonPaymentReviewFingerprint, wonBatchReadyToResume, WON_BATCH_MAX_JOBS,
} from "../lib/won-batches.ts";
import { wonReportAmounts } from "../lib/won-reporting.ts";
import { saveWonPaymentOverlay } from "../lib/won-payment-save.ts";

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
  ...job, review: { fingerprint: String(index + 1).repeat(64), amounts: { agencyCommissionTotal: 100, salespersonCommissionTotal: 50 } },
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
let leaseAvailable = true;
let leaseHeld = false;
let leaseLost = false;
const context = vm.createContext({
  randomUUID: () => "6aef478a-1b2c-4d6e-8899-123456789abc",
  URLSearchParams, isWonBatchId, isWonBatchKind, parseWonBatchIds, resolveWonBatchJobs, runWonBatch, sameWonBatchSelection, wonBatchReadyToResume, WON_BATCH_MAX_JOBS,
  WON_PAYMENT_ALREADY_RECORDED: "already recorded",
  requireAdmin: async () => {
    if (denied) throw new Error("not admin");
    log.push("auth");
    return { supabase: {}, email: admin, actorId: 'admin-uid' };
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
  manageWonBatchLease: async (_supabase, change) => {
    assert.equal(change.batchId, token);
    assert.equal(change.token, "6aef478a-1b2c-4d6e-8899-123456789abc");
    if (change.action === "claim") {
      assert.deepEqual(plain(change.outcomes), existingBatch?.outcomes || []);
      return leaseHeld = leaseAvailable;
    }
    if (change.action === "release") { leaseHeld = false; return true; }
    if (change.action === "check") return leaseHeld && !leaseLost;
    assert.equal(change.action, "record");
    assert.equal(leaseHeld, true);
    const outcomes = change.outcomes;
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
    assert.equal(review.batchLease.batchId, token);
    assert.equal(leaseHeld, true);
    return optionId === "First" ? "Quote changed" : optionId === "Second" ? "already recorded" : "";
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
assert.equal(leaseHeld, false, "Batch lease is released after a completed update");
assert.equal(first.hash, "#won-options");
assert.equal(first.searchParams.get("wonBatch"), token);
assert.equal(first.searchParams.get("checkBackups"), "1");
assert.match(first.searchParams.get("error"), /1 updated, 1 already recorded, 1 failed/);
assert.deepEqual(log.splice(0), ["auth", "resolve", "intent", "update First", "record 1", "update Second", "record 2", "update Third", "record 3", "refresh"]);
assert.deepEqual(stored.items.map(({ id }) => id), ids, "Persist all selected jobs, including ineligible ones");
assert.deepEqual(storedOutcomes.map(({ status }) => status), ["failed", "already_recorded", "confirmed"]);
assert.deepEqual(Object.keys(stored.items[0]).sort(), ["id", "quote", "recovered", "salesperson"]);
existingBatch = { ...stored, actor_email: admin, actor_id: 'admin-uid', created_at: '2026-01-01T00:00:00Z' };
assert.match((await submit(form("paid_in", ids, ["9".repeat(64), ...reviews.slice(1)]))).searchParams.get("message"), /already submitted/);
assert.deepEqual(log.splice(0), ["auth"], "A matching token can reopen its existing batch without replaying stale reviews");
existingBatch.outcomes = [{ id: ids[0], status: "confirmed" }];
startStatus = "replayed";
const resumeForm = form("paid_in");
resumeForm.set("wonBatchResume", "1");
assert.match((await submit(resumeForm)).searchParams.get("message"), /2 updated, 1 already recorded/);
assert.deepEqual(log.splice(0), ["auth", "resolve", "intent", "update Second", "record 2", "update Third", "record 3", "refresh"]);
assert.equal(storedOutcomes[0].status, "confirmed", "The prior batch outcome is immutable on resume");
const reorderedResume = form("paid_in", [...ids].reverse(), [...reviews].reverse());
reorderedResume.set("wonBatchResume", "1");
await submit(reorderedResume);
assert.deepEqual(log.splice(0), ["auth", "resolve", "intent", "update Second", "record 2", "update Third", "record 3", "refresh"], "Stored IDs, not submitted positions, identify resumed jobs");
existingBatch.actor_id = 'different-account-same-email';
assert.match((await submit(resumeForm)).searchParams.get("error"), /already used/);
assert.deepEqual(log.splice(0), ["auth"], "A recreated admin identity cannot resume another account's batch");
existingBatch.actor_id = 'admin-uid';
existingBatch.created_at = new Date().toISOString();
assert.match((await submit(resumeForm)).searchParams.get('error'), /may still be finishing/);
assert.deepEqual(log.splice(0), ['auth']);
existingBatch.created_at = '2026-01-01T00:00:00Z';
const staleResume = form("paid_in", ids, ["9".repeat(64), ...reviews.slice(1)]);
staleResume.set("wonBatchResume", "1");
assert.match((await submit(staleResume)).searchParams.get("error"), /quote changed/);
assert.deepEqual(log.splice(0), ["auth", "resolve"]);
startStatus = "created";
existingBatch = null;
jobs[2].review.amounts.agencyCommissionTotal = null;
assert.match((await submit(form('paid_in'))).searchParams.get('error'), /amount is unavailable/);
assert.deepEqual(log.splice(0), ['auth', 'resolve']);
jobs[2].review.amounts.agencyCommissionTotal = 100;
jobs[2].review.amounts.salespersonCommissionTotal = null;
assert.match((await submit(form('paid_out'))).searchParams.get('error'), /amount is unavailable/);
assert.deepEqual(log.splice(0), ['auth', 'resolve'], 'An incomplete payout batch must not start');
jobs[2].review.amounts.salespersonCommissionTotal = 50;
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
leaseAvailable = false;
assert.match((await submit(form("paid_in"))).searchParams.get("error"), /Could not save the batch/);
assert.deepEqual(log.splice(0), ["auth", "resolve", "intent"], "An active batch owner prevents a second runner from writing");
leaseAvailable = true;
leaseLost = true;
assert.match((await submit(form("paid_in"))).searchParams.get("error"), /3 unconfirmed/);
assert.deepEqual(log.splice(0), ["auth", "resolve", "intent", "refresh"], "An expired lease stops before any payment writes or outcomes");
assert.equal(leaseHeld, false);
leaseLost = false;
lostOutcome = true;
const interrupted = await submit(form("paid_in"));
assert.match(interrupted.searchParams.get("error"), /3 unconfirmed/);
assert.deepEqual(log.splice(0), ["auth", "resolve", "intent", "update First", "record 1", "refresh"]);
assert.equal(leaseHeld, false, "Interrupted runs release their lease");
denied = true;
await assert.rejects(submit(form("paid_in")), /not admin/);
assert.deepEqual(log, []);

const snapshotContext = vm.createContext({
  wonReportAmounts, wonPaymentReviewFingerprint, saveWonPaymentOverlay, dbMessage: (error) => error.message,
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
    state, db: { rpc(name, args) {
      assert.equal(name, "save_won_payment_overlay");
      assert.equal(args.p_owner_id, initial.user_id);
      assert.equal(args.p_owner_email, null);
      assert.equal(args.p_storage_key, stateKey);
      const records = JSON.parse(args.p_overlay);
      const next = new Date(Math.max(Date.parse(records[0].updatedAt), Date.parse(args.p_expected_updated_at) + 1)).toISOString();
      state.writes++;
      state.compared.push(args.p_expected_updated_at);
      const result = casConflict || args.p_expected_updated_at !== state.row.updated_at
        ? { data: { status: "conflict" }, error: null }
        : { data: { status: "saved", updated_at: next }, error: null };
      if (result.data.status === "saved") {
        state.row.data[stateKey] = typeof state.row.data[stateKey] === "string" || !state.row.data[stateKey] ? args.p_overlay : records;
        state.row.updated_at = next;
        state.commits++;
      }
      return { abortSignal: () => Promise.resolve(result) };
    }, from(table) {
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
{
  const partial = snapshot();
  partial.data[rowsKey].push({ id: "incomplete", optionId: "case", wonAt, finalInc: 50 });
  const reviewed = currentJob(partial);
  assert.ok(reviewed.agencyCommissionTotal > 0, "Legacy list can show a positive subtotal");
  assert.equal(reviewed.review.amounts.agencyCommissionTotal, null);
  for (const mode of ["paid_in", "paid_out"]) {
    const db = mockDatabase(partial);
    assert.match(await changePayment(db, mode, reviewed), /payment amount is unavailable/);
    assert.equal(db.state.commits, 0, "Final write rejects an unverified monetary amount");
  }
  const received = snapshot({ paidInAt: receiptAt });
  const db = mockDatabase(received);
  assert.equal(await changePayment(db, "payment_requested", currentJob(received)),
    vm.runInContext("WON_PAYMENT_ALREADY_RECORDED", snapshotContext));
  assert.equal(db.state.commits, 0, "Never stamp a request on a job already received");
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
  assert.deepEqual(db.state.row.data[defsKey], initial.data[defsKey], "Payment save leaves quote definitions unchanged");
  assert.deepEqual(db.state.row.data[rowsKey], initial.data[rowsKey], "Payment save leaves prices and quote rows unchanged");
}

const independentRequest = snapshot({ paidOutAt: payoutAt });
const independentDb = mockDatabase(independentRequest);
assert.equal(await changePayment(independentDb, "payment_requested", currentJob(independentRequest)), "");
assert.ok(currentJob(independentDb.state.row).paymentRequestedAt, "A paid commission does not suppress an agency payment request");
assert.equal(currentJob(independentDb.state.row).paidOutAt, payoutAt);

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
for (const malformed of ['{broken', '{}', 'null', null, 12, {}]) {
  for (const mode of ['reset_payment', 'unlock']) {
    const invalid = structuredClone(reset);
    invalid.data[stateKey] = malformed;
    const invalidDb = mockDatabase(invalid);
    assert.match(await changePayment(invalidDb, mode), /history needs review/);
    assert.equal(invalidDb.state.writes, 0, `${mode} must not write over malformed history`);
    assert.deepEqual(invalidDb.state.row, invalid, `${mode} preserves the full original calculator`);
  }
}
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
const originalDate = vm.runInContext("Date", snapshotContext);
for (const now of ["2026-11-06T00:00:00.000Z", "2026-11-05T23:59:59.999Z"]) {
  const versionDb = now === sameMillisecond.updated_at ? frozenDb : mockDatabase(sameMillisecond);
  try {
    snapshotContext.Date = class extends originalDate {
      constructor(...args) { super(...(args.length ? args : [originalDate.parse(now)])); }
      static now() { return originalDate.parse(now); }
    };
    assert.equal(await changePayment(versionDb, "paid_in", currentJob(sameMillisecond)), "");
    assert.equal(versionDb.state.row.updated_at, "2026-11-06T00:00:00.001Z");
    const savedData = structuredClone(versionDb.state.row.data);
    assert.match(await snapshotContext.saveWonCalculatorSnapshot(versionDb.db, "user_id", sameMillisecond.user_id,
      sameMillisecond.data, sameMillisecond.updated_at, true), /changed during the update/);
    assert.equal(versionDb.state.commits, 1, "The stale CAS must affect zero rows");
    assert.deepEqual(versionDb.state.row.data, savedData);
    assert.deepEqual(versionDb.state.compared, [sameMillisecond.updated_at, sameMillisecond.updated_at]);
  } finally {
    snapshotContext.Date = originalDate;
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

const history = Array.from({ length: 2000 }, (_, index) => ({
  userEmail: 'rep@example.test', dataOwnerEmail: 'owner@example.test', dataUserId: 'owner-id',
  sourceId: 'current', optionId: `historic-${index}`, wonAt, paidOutAt: payoutAt, customNote: `preserve-${index}`,
}));
const fullHistory = { [stateKey]: JSON.stringify(history) };
const refused = snapshotContext.upsertWonAdminState(fullHistory, { ...history[0], optionId: 'new-job' }, 'paid_out', admin);
assert.match(refused.error, /storage limit/);
assert.equal(refused.data[stateKey], fullHistory[stateKey], 'Capacity must not evict any prior payment record');
const existingHistoryUpdate = snapshotContext.upsertWonAdminState(fullHistory, history[0], 'payment_requested', admin);
assert.equal(existingHistoryUpdate.updated, true);
assert.deepEqual(JSON.parse(existingHistoryUpdate.data[stateKey]).slice(1), history.slice(1), 'Unrelated history is preserved verbatim, including additional fields');

const batchDependencies = Object.fromEntries([
  'requireAdmin', 'listWonOptions', 'updateWonOptionState', 'manageWonBatchLease', 'WON_PAYMENT_ALREADY_RECORDED',
].map(name => [name, context[name]]));
try {
  context.WON_PAYMENT_ALREADY_RECORDED = vm.runInContext('WON_PAYMENT_ALREADY_RECORDED', snapshotContext);
  existingBatch = null;
  startStatus = 'created';
  lostOutcome = false;
  for (const [mode, field] of [
    ['payment_requested', 'paymentRequestedAt'], ['paid_in', 'paidInAt'], ['paid_out', 'paidOutAt'],
  ]) {
    for (const resetAfterPreflight of [false, true]) {
      const initial = snapshot();
      initial.data[defsKey].push({ ...initial.data[defsKey][0], id: 'second-case' });
      initial.data[rowsKey].push({ ...initial.data[rowsKey][0], id: 'second-system', optionId: 'second-case' });
      if (mode === 'payment_requested') {
        initial.data[rowsKey].push({ id: 'legacy-line', optionId: 'second-case', wonAt, finalInc: 50 });
      }
      if (resetAfterPreflight) initial.data[stateKey] = [{
        userEmail: 'rep@example.test', optionId: 'second-case', wonAt, [field]: reqAt,
      }];
      const database = mockDatabase(initial);
      const readJobs = () => {
        const reader = snapshotContext.wonSnapshotReader([]);
        reader.collectState(database.state.row);
        reader.scan(database.state.row, database.state.row.updated_at);
        return [...reader.wonOptions.values()];
      };
      const reviewedJobs = readJobs();
      context.requireAdmin = async () => ({ supabase: database.db, email: admin, actorId: 'admin-uid' });
      context.listWonOptions = async () => ({ data: readJobs(), errorMessage: '' });
      context.updateWonOptionState = snapshotContext.updateWonOptionState;
      let checks = 0;
      context.manageWonBatchLease = async (supabase, change) => {
        if (change.action === 'check' && ++checks === 2 && resetAfterPreflight) {
          assert.equal(await snapshotContext.updateWonOptionState(database.db, 'rep@example.test', 'second-case',
            'reset_payment', admin, 'current', initial.user_id, initial.email, wonAt), '');
          assert.equal(readJobs()[1][field], '', 'The intervening reset really cleared the payment status');
        }
        return batchDependencies.manageWonBatchLease(supabase, change);
      };
      const result = await submit(form(mode, reviewedJobs.map(wonBatchJobId), reviewedJobs.map(job => job.review.fingerprint)));
      assert.equal(leaseHeld, false);
      assert.equal(checks, 2);
      if (resetAfterPreflight) {
        assert.match(result.searchParams.get('error') || '', /1 updated, 0 already recorded, 1 failed/,
          `${mode} must recheck an earlier recorded status before journalling it`);
        assert.deepEqual(storedOutcomes.map(({ status }) => status), ['confirmed', 'failed']);
        assert.match(storedOutcomes[1].detail, /changed before saving/);
        assert.equal(readJobs()[1][field], '', 'Do not reapply a payment after a conflicting reset');
      } else {
        assert.match(result.searchParams.get('message') || '', /2 updated, 0 already recorded, 0 failed/);
        assert.deepEqual(storedOutcomes.map(({ status }) => status), ['confirmed', 'confirmed']);
        assert.ok(readJobs().every(job => job[field]), 'Both same-owner payments survive the final reload');
        if (mode === 'payment_requested') {
          assert.equal(readJobs()[1].review.amounts.agencyCommissionTotal, null);
          assert.ok(readJobs().every(job => !job.paidInAt && !job.paidOutAt));
          assert.deepEqual(database.state.row.data[rowsKey], initial.data[rowsKey], 'Do not backfill or change any quote amounts');
          assert.deepEqual(database.state.row.data[defsKey], initial.data[defsKey], 'Original quote options remain unchanged');
        }
        const originalTimestamps = readJobs().map(job => job[field]);
        const commits = database.state.commits;
        const currentReviews = readJobs();
        const replay = await submit(form(mode, currentReviews.map(wonBatchJobId), currentReviews.map(job => job.review.fingerprint)));
        assert.match(replay.searchParams.get('message') || '', /0 updated, 2 already recorded, 0 failed/);
        assert.equal(database.state.commits, commits, 'Already recorded payments do not write again');
        assert.deepEqual(readJobs().map(job => job[field]), originalTimestamps, 'Keep the original payment timestamps');
      }
      log.splice(0);
    }
  }
} finally {
  Object.assign(context, batchDependencies);
}
console.log('PASS bulk payment backend: same-owner persistence, final-state idempotency, and reset-after-preflight conflicts for all three statuses');

assert.equal(wonBatchReadyToResume({ created_at: new Date(Date.now() - 89_000).toISOString() }), false);
assert.equal(wonBatchReadyToResume({ created_at: new Date(Date.now() - 91_000).toISOString() }), true);
assert.equal(wonBatchReadyToResume({ created_at: 'invalid' }), false);

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
const workspace = await readFile(new URL("../app/admin/users/admin-workspace.tsx", import.meta.url), "utf8");
assert.match(workspace, /onSubmitCapture=\{[\s\S]+?runtime\.submit\(native\)[\s\S]+?await wonActions\[kind\]\(data\)/);
assert.doesNotMatch(runtimeText, /addEventListener\("submit"/, "Exactly one dispatcher must own payment submission");
assert.match(panels, /<caption>Weekly details<\/caption>/);

assert.match(schema, /enable row level security/);
assert.match(schema, /grant insert \(id, kind, label, items\), update \(outcomes\)/);
assert.match(schema, /actor_id = \(select auth.uid\(\)\) and kind <> 'manual'/);
assert.match(schema, /and approval.is_locked/);
assert.match(schema, /new.outcomes - previous_count <> old.outcomes/);
assert.doesNotMatch(schema, /security definer|user_calculator_data|grant delete/i);
console.log("Won batch action wiring, selected scope, totals, and additive SQL contract passed.");
