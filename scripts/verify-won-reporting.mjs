import assert from "node:assert/strict";
import {
  isStoredWonAmount, summarizeWonReport, wonReportAmounts, wonReportPerson, wonReportRange, wonSydneyDate,
} from "../lib/won-reporting.ts";
import { parseWonBatchIds, resolveWonBatchJobs, runWonBatch, sameWonBatchSelection, wonBatchJobId, wonPaymentReviewFingerprint } from "../lib/won-batches.ts";

assert.equal(wonSydneyDate("2026-11-01T12:59:59.999Z"), "2026-11-01");
assert.equal(wonSydneyDate("2026-11-01T13:00:00Z"), "2026-11-02");
assert.equal(wonSydneyDate("2026-04-04T13:30:00Z"), "2026-04-05", "Before Sydney DST ends");
assert.equal(wonSydneyDate("2026-04-05T13:30:00Z"), "2026-04-05", "After Sydney DST ends");
assert.equal(wonSydneyDate("2026-11-01T23:30:00-0500"), "2026-11-02");
assert.equal(wonSydneyDate("2026-11-01"), "2026-11-01");
for (const invalid of ["", "not a date", "2026-02-29", "2026-02-30T12:00:00Z", "2026-11-01T13:00:00", "2026-11-01T24:00:00Z"]) {
  assert.equal(wonSydneyDate(invalid), null, invalid);
}
assert.deepEqual(wonReportRange("last-week", "2026-11-02"), { start: "2026-10-26", end: "2026-11-01" });
assert.deepEqual(wonReportRange("last-week", "2026-11-08"), { start: "2026-10-26", end: "2026-11-01" });
assert.deepEqual(wonReportRange("last-month", "2024-03-01"), { start: "2024-02-01", end: "2024-02-29" });
assert.deepEqual(wonReportRange("last-month", "2026-01-01"), { start: "2025-12-01", end: "2025-12-31" });
for (const [start, end] of [["2026-11-06", "2026-11-05"], ["2026-11-01", "2026-11-08"], ["2024-11-01", "2026-11-07"], ["2026-02-31", "2026-11-01"]]) {
  assert.equal(wonReportRange("custom", "2026-11-07", start, end), null);
}

const person = { email: "rep@example.test", name: " Daniel  Parisotto " };
const other = { email: "other@example.test", name: "Daniel DiPalma" };
assert.equal(wonReportPerson([other, person]), person.email);
assert.equal(wonReportPerson([other]), "");
assert.equal(wonReportPerson([person, { ...person, email: "duplicate@example.test" }]), "");
assert.equal(wonReportPerson([person, other], "OTHER@EXAMPLE.TEST"), other.email);
assert.equal(wonReportPerson([person], "unknown@example.test"), "");

const amounts = {
  salespersonCommissionTotal: 20, agencyCommissionTotal: 90, agencyProfitAfterSalesTotal: 70,
  installerProfitTotal: -10, customerTotal: 100,
};
const raw = { salespersonCommissionInc: "20", commissionInc: 90, netProfit: "-10", finalInc: 100 };
assert.deepEqual(wonReportAmounts(amounts, [raw]), amounts, "Keep existing amounts and GST basis");
assert.equal(wonReportAmounts({ ...amounts, installerProfitTotal: 0 }, [{ ...raw, netProfit: 0 }]).installerProfitTotal, 0);
assert.deepEqual(wonReportAmounts(amounts, [raw, { ...raw, salespersonCommissionInc: undefined }]), {
  ...amounts, salespersonCommissionTotal: null, agencyProfitAfterSalesTotal: null,
});
assert.equal(wonReportAmounts(amounts, [{ ...raw, agencyCommissionInc: "" }]).agencyCommissionTotal, null);
for (const value of [null, undefined, "", " ", "NaN", true, [], "0x20", Infinity]) assert.equal(isStoredWonAmount(value), false);

const job = (wonAt, reportAmounts = amounts, userEmail = person.email) => ({ userEmail, wonAt, reportAmounts });
const result = summarizeWonReport([
  job("2026-10-26"), // Monday: not comparable to the first partial Tue-Sun week.
  job("2026-10-27"), job("2026-11-02"), // Previous comparable Tuesday.
  job("2026-11-03", { ...amounts, installerProfitTotal: null }),
  job("2026-11-08T12:00:00Z"), // Sydney Sunday.
  job("2026-11-17"), job("2026-11-23"), // Monday before final Tue-Thu comparison.
  job("2026-11-24"), job("2026-11-25"), job("2026-11-27"),
  job("bad-date"), job("2026-11-03", amounts, other.email),
], person.email, { start: "2026-11-03", end: "2026-11-26" });
assert.equal(result.invalidDates, 1);
assert.equal(result.totals.count, 6);
assert.equal(result.totals.money.customerTotal.total, 600);
assert.equal(result.totals.money.installerProfitTotal.missing, 1);
assert.deepEqual(result.weeks.map((week) => [week.start, week.end, week.current.count, week.previous.count]), [
  ["2026-11-03", "2026-11-08", 2, 1],
  ["2026-11-09", "2026-11-15", 0, 3],
  ["2026-11-16", "2026-11-22", 1, 0],
  ["2026-11-23", "2026-11-26", 3, 1],
]);
assert.equal(result.weeks[1].current.money.customerTotal.total, 0, "A zero-job week is a real zero");
assert.equal(result.weeks[0].previousStart, "2026-10-27");
assert.equal(result.weeks[3].previousEnd, "2026-11-19");

const quote = { dataUserId: "stable-owner", dataOwnerEmail: "Owner@example.test", userEmail: person.email, optionId: "option_1", wonAt: "2026-11-03" };
const id = wonBatchJobId(quote);
const nextQuote = { ...quote, wonAt: "2026-11-04" };
const nextId = wonBatchJobId(nextQuote);
assert.notEqual(id, nextId, "Re-winning the same quote is not the same job");
assert.equal(wonBatchJobId({ ...quote, sourceId: "recovered", dataOwnerEmail: "renamed@example.test" }), id);
assert.notEqual(wonBatchJobId({ ...quote, dataUserId: "another-owner" }), id);
const reviewedQuote = { ...quote, userName: "Rep", sourceId: "current", recoveredFromBackup: false, paymentFields: {} };
const reviewedHash = (job, totals = amounts, rawRow = raw) => wonPaymentReviewFingerprint(job, totals, { id: quote.optionId }, [rawRow]);
const fingerprint = reviewedHash(reviewedQuote);
assert.equal(reviewedHash(reviewedQuote, amounts, Object.fromEntries(Object.entries(raw).reverse())), fingerprint);
for (const changed of [
  { sourceId: "saved:other" }, { userEmail: "new-rep@example.test" }, { dataOwnerEmail: "new-owner@example.test" },
  { wonAt: "2026-11-04" }, { paymentFields: { paidInAt: "new" } },
]) assert.notEqual(reviewedHash({ ...reviewedQuote, ...changed }), fingerprint);
assert.notEqual(reviewedHash(reviewedQuote, { ...amounts, customerTotal: 100.01 }), fingerprint);
assert.notEqual(reviewedHash(reviewedQuote, amounts, { ...raw, finalInc: 101 }), fingerprint);
assert.deepEqual(parseWonBatchIds(JSON.stringify([id, nextId])), [id, nextId]);
for (const invalid of [null, "", "bad JSON", "[]", JSON.stringify([id, id]), JSON.stringify([{ id }]), JSON.stringify(Array(51).fill(id))]) {
  assert.equal(parseWonBatchIds(invalid), null);
}
assert.deepEqual(resolveWonBatchJobs([nextId, id], [quote, nextQuote]), [nextQuote, quote]);
assert.equal(resolveWonBatchJobs([nextId, id], [quote]), null, "Never quietly drop a missing job on submission");

const intent = { id: "batch", kind: "paid_in", label: "", items: [id, nextId].map((id) => ({ id })) };
const actor = "admin@example.test";
const saved = { ...intent, actor_email: actor };
assert.equal(sameWonBatchSelection(saved, intent.kind, intent.label, [nextId, id], actor), true);
assert.equal(sameWonBatchSelection(saved, "paid_out", intent.label, [id, nextId], actor), false);
assert.equal(sameWonBatchSelection(saved, intent.kind, intent.label, [id, nextId], other.email), false);
for (const status of ["unavailable", "replayed", "conflict"]) {
  assert.equal((await runWonBatch(intent, {
    start: async () => status,
    apply: () => assert.fail("Must not apply a payment before a new intent is saved"),
    record: () => assert.fail("Must not record an outcome without applying"),
  })).status, status);
}
const operations = [];
const partial = await runWonBatch(intent, {
  start: async () => { operations.push("intent"); return "created"; },
  apply: async (_item, index) => {
    operations.push(`apply ${index}`);
    return index === 0 ? { status: "failed", detail: "Changed" } : { status: "confirmed" };
  },
  record: async (outcomes) => { operations.push(`record ${outcomes.length}`); return true; },
});
assert.deepEqual(operations, ["intent", "apply 0", "record 1", "apply 1", "record 2"]);
assert.deepEqual(partial.outcomes.map(({ status }) => status), ["failed", "confirmed"]);
for (const failure of ["lost payment reply", "history write failure"]) {
  let calls = 0;
  const interrupted = await runWonBatch(intent, {
    start: async () => "created",
    apply: async () => {
      calls++;
      if (failure === "lost payment reply") throw new Error(failure);
      return { status: "confirmed" };
    },
    record: async () => false,
  });
  assert.equal(interrupted.status, "interrupted");
  assert.deepEqual(interrupted.outcomes, []);
  assert.equal(calls, 1, "Do not start another payment when its predecessor is unconfirmed");
}
const manual = await runWonBatch({ ...intent, kind: "manual", label: "Older selection" }, {
  start: async () => "created",
  apply: () => assert.fail("Manual groups cannot apply payments"),
  record: () => assert.fail("Manual groups cannot record a payment outcome"),
});
assert.deepEqual(manual, { status: "saved", outcomes: [] });
console.log("Won reporting dates, totals, identity, idempotence, and batch outcomes passed.");
