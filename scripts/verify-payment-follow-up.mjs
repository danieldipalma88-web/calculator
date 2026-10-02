import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("..", import.meta.url);
const [rules, noticeSource, page] = await Promise.all([
  readFile(new URL("lib/payment-follow-up.ts", root), "utf8"),
  readFile(new URL("app/admin/users/payment-follow-up-notice.tsx", root), "utf8"),
  readFile(new URL("app/admin/users/page.tsx", root), "utf8"),
]);

const rulesSource = ts.createSourceFile("payment-follow-up.ts", rules, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
assert.equal(rulesSource.parseDiagnostics.length, 0, "payment-follow-up module parses");
const runtime = rulesSource.statements.filter(node =>
  (ts.isFunctionDeclaration(node) && ["paymentFollowUp", "sydneyToday", "dateDay"].includes(node.name?.text)) ||
  (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
    ts.isIdentifier(declaration.name) && ["paymentFollowUp", "sydneyToday"].includes(declaration.name.text)))
);
assert.equal(runtime.length, 3, "exports paymentFollowUp and sydneyToday with their date parser");
const sandbox = { exports: {} };
vm.createContext(sandbox);
vm.runInContext(ts.transpileModule(rules, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, sandbox);

const job = overrides => ({
  proposedInstallationDate: "2026-03-10",
  paymentRequestedAt: null,
  paidInAt: null,
  paidOutAt: null,
  agencyCommissionTotal: 100,
  salespersonCommissionTotal: 0,
  ...overrides,
});
const notice = (record, today = "2026-03-11") => sandbox.exports.paymentFollowUp(record, today);
const expectNotice = (actual, kind, daysSinceInstall, amount) => assert.deepEqual(
  { kind: actual?.kind, daysSinceInstall: actual?.daysSinceInstall, amount: actual?.amount },
  { kind, daysSinceInstall, amount },
);

expectNotice(notice(job()), "request-payment", 1, 100);
const immutableJob = job({ paymentRequestedAt: null });
const immutableSnapshot = JSON.stringify(immutableJob);
notice(immutableJob);
assert.equal(JSON.stringify(immutableJob), immutableSnapshot, "paymentFollowUp does not mutate its job");
expectNotice(notice(job({ paymentRequestedAt: "2026-03-10T10:00:00Z" })), "follow-up-payment", 1, 100);
expectNotice(notice(job({ paymentRequestedAt: null, proposedInstallationDate: "2026-03-09" })), "request-payment", 2, 100); // Reset/reschedule starts a fresh request state.
const payoutFirstNotice = notice(job({ paidOutAt: "2026-03-10T10:00:00Z" }));
expectNotice(payoutFirstNotice, "follow-up-payment", 1, 100); // Payout never proves agency receipt; follow up without resetting it.
assert.equal(payoutFirstNotice.label, "Follow up payment", "payout-first reminder uses follow-up wording");
expectNotice(notice(job({ paymentRequestedAt: "2026-03-10", paidOutAt: "2026-03-10" })), "follow-up-payment", 1, 100);
expectNotice(notice(job({ agencyCommissionTotal: 0, salespersonCommissionTotal: 40 })), "pay-commission", 1, 40);
expectNotice(notice(job({ agencyCommissionTotal: -1, salespersonCommissionTotal: 40 })), "pay-commission", 1, 40);
assert.equal(notice(job({ paidInAt: "2026-03-11T08:00:00Z", salespersonCommissionTotal: 0 })), null, "agency receipt settles an agency-only obligation");
expectNotice(notice(job({ paidInAt: "2026-03-11T08:00:00Z", salespersonCommissionTotal: 40 })), "pay-commission", 1, 40);
assert.equal(notice(job({ paidInAt: "2026-03-11T08:00:00Z", paidOutAt: "2026-03-11T09:00:00Z", salespersonCommissionTotal: 40 })), null, "fully settled positive commission obligation produces no reminder");
assert.equal(notice(job({ agencyCommissionTotal: 0, salespersonCommissionTotal: 0 })), null);
for (const total of [0, -1, NaN, Infinity, -Infinity]) {
  assert.equal(notice(job({ agencyCommissionTotal: total, salespersonCommissionTotal: 0 })), null, `invalid/non-positive agency total ${total} is not payable`);
  assert.equal(notice(job({ agencyCommissionTotal: 0, salespersonCommissionTotal: total })), null, `invalid/non-positive salesperson total ${total} is not payable`);
}
assert.equal(notice(job(), "2026-03-10"), null, "installation today is not overdue");
assert.equal(notice(job(), "2026-03-09"), null, "future installation is not overdue");
assert.equal(notice(job(), "2026-02-30"), null, "invalid current date suppresses reminders");
expectNotice(notice(job({ proposedInstallationDate: "2026-03-09" }), "2026-03-10"), "request-payment", 1, 100);
expectNotice(notice(job({ proposedInstallationDate: "2024-02-29" }), "2024-03-01"), "request-payment", 1, 100);
expectNotice(notice(job({ proposedInstallationDate: "2023-02-29" }), "2023-03-01"), "check-date", null, 100);
for (const proposedInstallationDate of [null, "", "not-a-date", "2026-02-30", "2026-3-1", "2026-03-01T00:00:00Z"]) {
  expectNotice(notice(job({ proposedInstallationDate })), "check-date", null, 100);
}
assert.equal(notice(job({ proposedInstallationDate: "2026-02-30", agencyCommissionTotal: 0, salespersonCommissionTotal: 0 })), null, "no obligation means no date reminder");
expectNotice(notice(job({ proposedInstallationDate: "2026-03-08", agencyCommissionTotal: 0, salespersonCommissionTotal: 10 })), "pay-commission", 3, 10);

for (const [instant, date] of [
  ["2026-01-01T12:59:59.999Z", "2026-01-01"],
  ["2026-01-01T13:00:00.000Z", "2026-01-02"],
  ["2026-04-04T12:59:59.999Z", "2026-04-04"],
  ["2026-04-04T13:00:00.000Z", "2026-04-05"],
  ["2026-10-03T13:59:59.999Z", "2026-10-03"],
  ["2026-10-03T14:00:00.000Z", "2026-10-04"],
]) assert.equal(sandbox.exports.sydneyToday(new Date(instant)), date, `Sydney calendar date for ${instant}`);

const pageFile = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
assert.equal(pageFile.parseDiagnostics.length, 0, "admin users page parses");
assert.ok(page.includes("<PaymentFollowUpNotice"), "admin page renders the follow-up notice");
assert.ok(page.includes("wonOptions.filter((option) => !option.recoveredFromBackup).map((option) => ({"), "notice uses canonical wonOptions and excludes recovered backups");
assert.ok(page.includes("key: wonOptionDomKey(option)"), "notice uses the canonical job key for review handoff");
assert.ok(/isOwnerEmail\(currentEmail\)\s*\?\s*<PaymentFollowUpNotice\b/.test(page), "notice is rendered only in the Daniel owner-email branch");
assert.ok(!/isOwnerEmail\(currentEmail\)[\s\S]{0,250}<PaymentFollowUpNotice\b[\s\S]{0,250}:\s*<PaymentFollowUpNotice\b/.test(page), "no alternate non-owner notice branch");
assert.ok(!/(?:fetch\s*\(|createSupabaseServerClient\s*\(|from\s*\(["'](?:won|jobs|payment)["']\s*\))/i.test(noticeSource), "notice adds no API or database call");
assert.ok(!/fetch\s*\(/.test(page.slice(Math.max(0, page.indexOf("<PaymentFollowUpNotice") - 1200), page.indexOf("<PaymentFollowUpNotice") + 1200)), "notice integration adds no local fetch");

const component = ts.createSourceFile("notice.tsx", noticeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
assert.equal(component.parseDiagnostics.length, 0, "notice component parses");
assert.ok(noticeSource.includes("PaymentFollowUp"), "notice component uses paymentFollowUp");
assert.ok(noticeSource.includes("sydneyToday"), "notice component uses Sydney-local today");
assert.ok(noticeSource.includes("jobs.flatMap("), "notice derives reminders from supplied jobs");
assert.ok(noticeSource.includes('aria-expanded={expanded}'), "notice exposes its expandable state accessibly");
assert.ok(noticeSource.includes('aria-label={`Review ${job.name}`}'), "each job has a readable review action");
assert.ok(noticeSource.includes('setMessage("Wait for the current job update to finish, then try again.")'), "cancelled review handoff gives an accessible status message");

const scriptNode = pageFile.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "wonExportScript");
assert.ok(scriptNode, "admin client script source exists");
const scriptScope = {};
vm.runInNewContext(ts.transpileModule(scriptNode.getText(pageFile), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText, scriptScope);
const clientSource = scriptScope.wonExportScript();
const clientFile = ts.createSourceFile("admin-client.js", clientSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
let reviewNode;
function findReviewHandler(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "reviewWonJob") reviewNode = node;
  ts.forEachChild(node, findReviewHandler);
}
findReviewHandler(clientFile);
assert.ok(reviewNode, "existing reviewWonJob client handler exists");
const selected = [], openedTab = [], scheduled = [], ops = [];
const card = {
  open: false, attrs: {}, getAttribute: name => name === "data-won-card-key" ? "job-exact-key" : null,
  setAttribute: (name, value) => { card.attrs[name] = value; },
  focus: options => ops.push(["focus", options]),
  scrollIntoView: options => ops.push(["scroll", options]),
};
const otherCard = { getAttribute: () => "job-similar-key" };
const section = {
  busy: false, getAttribute: () => section.busy ? "true" : null,
  querySelectorAll: () => [otherCard, card],
};
const search = { value: "stale search" };
const reviewScope = {
  document: {
    querySelector: selector => selector === ".won-options-section" ? section : selector === "[data-won-search]" ? search : null,
    getElementById: id => id === "admin-tab-jobs" ? { click: () => openedTab.push(id) } : null,
  },
  window: { requestAnimationFrame: callback => { scheduled.push(callback); callback(); } },
  setActiveSalespersonEmails: value => selected.push(["salespeople", value]),
  setActivePaymentFilters: value => selected.push(["payments", value]),
  applyWonSalespersonFilter: () => ops.push(["apply-filters"]),
  rememberWonUiState: value => ops.push(["remember", value]),
};
vm.runInNewContext(reviewNode.getText(clientFile), reviewScope);
const reviewEvent = { detail: { key: "job-exact-key", opened: false }, prevented: false, preventDefault() { this.prevented = true; } };
reviewScope.reviewWonJob(reviewEvent);
assert.equal(reviewEvent.prevented, false);
assert.equal(reviewEvent.detail.opened, true, "exact-key review opens and reports success");
assert.equal(card.open, true);
assert.equal(card.attrs.tabindex, "-1");
assert.equal(search.value, "");
assert.deepEqual(openedTab, ["admin-tab-jobs"]);
assert.equal(JSON.stringify(selected), JSON.stringify([["salespeople", []], ["payments", ["all"]]]));
assert.equal(JSON.stringify(ops), JSON.stringify([["apply-filters"], ["focus", { preventScroll: true }], ["scroll", { block: "start", behavior: "instant" }], ["remember", false]]));
assert.equal(scheduled.length, 1);
const rejected = { detail: { key: "job-exact-key", opened: false }, prevented: false, preventDefault() { this.prevented = true; } };
section.busy = true;
reviewScope.reviewWonJob(rejected);
assert.equal(rejected.prevented, true, "busy job section rejects a review event");
section.busy = false;
const missing = { detail: { key: "job-missing", opened: false }, prevented: false, preventDefault() { this.prevented = true; } };
reviewScope.reviewWonJob(missing);
assert.equal(missing.prevented, true, "unknown job key is rejected without opening another card");
let reviewJobNode;
function findNoticeReviewJob(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "reviewJob") reviewJobNode = node;
  ts.forEachChild(node, findNoticeReviewJob);
}
findNoticeReviewJob(component);
assert.ok(reviewJobNode, "notice reviewJob handler exists");
const dispatched = [];
const reviewMessages = [];
let collapsed = false;
const noticeScope = {
  CustomEvent: class {
    constructor(type, options) {
      this.type = type;
      this.detail = options.detail;
      this.cancelable = options.cancelable;
      this.defaultPrevented = false;
    }
    preventDefault() { this.defaultPrevented = true; }
  },
  document: {
    dispatchEvent(event) {
      dispatched.push(event);
      if (dispatchHandler) dispatchHandler(event);
      return !event.defaultPrevented;
    },
  },
  setMessage: value => reviewMessages.push(value),
  setExpanded: value => { collapsed = value; },
};
let dispatchHandler;
vm.runInNewContext(ts.transpileModule(reviewJobNode.getText(component), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText, noticeScope);
dispatchHandler = event => reviewScope.reviewWonJob(event);
noticeScope.reviewJob("job-exact-key");
assert.equal(dispatched.at(-1).type, "admin:review-won-job");
assert.equal(dispatched.at(-1).cancelable, true);
assert.deepEqual(JSON.parse(JSON.stringify(dispatched.at(-1).detail)), { key: "job-exact-key", opened: true });
assert.equal(dispatched.at(-1).defaultPrevented, false, "accepted review handler does not cancel dispatch");
assert.deepEqual(reviewMessages, [""], "successful review handoff clears any prior failure message");
assert.equal(collapsed, false, "successful review handoff closes the notice list");
section.busy = true;
noticeScope.reviewJob("job-exact-key");
assert.equal(dispatched.at(-1).defaultPrevented, true);
assert.equal(reviewMessages.at(-1), "Wait for the current job update to finish, then try again.");
section.busy = false;
dispatchHandler = undefined;
noticeScope.reviewJob("job-exact-key");
assert.deepEqual(JSON.parse(JSON.stringify(dispatched.at(-1).detail)), { key: "job-exact-key", opened: false });
assert.equal(reviewMessages.at(-1), "Wait for the current job update to finish, then try again.", "missing review handler is reported without pretending the job opened");

const canonicalNames = [
  "normalizeWonOptionText", "wonOptionRowsFingerprint", "duplicateWonOptionKey",
  "wonOptionSourcePriority", "paymentStatusPriority", "preferDuplicateWonOption", "canonicalWonOptions",
];
const canonicalNodes = [];
function findCanonicalHelpers(node) {
  if (ts.isFunctionDeclaration(node) && canonicalNames.includes(node.name?.text)) canonicalNodes.push(node);
  ts.forEachChild(node, findCanonicalHelpers);
}
findCanonicalHelpers(pageFile);
assert.equal(canonicalNodes.length, canonicalNames.length, "canonical duplicate-selection helpers exist");
const canonicalScope = { CURRENT_WON_SOURCE_ID: "current" };
vm.createContext(canonicalScope);
vm.runInContext(ts.transpileModule(canonicalNodes.map(node => node.getText(pageFile)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText, canonicalScope);
const canonicalJob = overrides => ({
  userEmail: "seller@example.test", dataOwnerEmail: "seller@example.test",
  optionId: "option-1", optionName: "Install", rows: [], systemCount: 1,
  customerTotal: 1000, rebateTotal: 0, wonAt: "2026-01-01T00:00:00Z",
  sourceId: "current", recoveredFromBackup: false, paymentStatus: "payment_open",
  ...overrides,
});
const unpaidLive = canonicalJob();
const paidHistoricalBackup = canonicalJob({
  recoveredFromBackup: true, sourceId: "backup:archive:current", paymentStatus: "payment_complete",
  wonAt: "2025-12-25T00:00:00Z",
});
for (const ordered of [[paidHistoricalBackup, unpaidLive], [unpaidLive, paidHistoricalBackup]]) {
  const canonical = canonicalScope.canonicalWonOptions(ordered);
  assert.equal(canonical.length, 1, "duplicate live and recovered records canonicalize to one job");
  assert.equal(canonical[0], unpaidLive, "unpaid live state wins over fully paid historical backup in either order");
}
const distinctBackup = canonicalJob({
  recoveredFromBackup: true, sourceId: "backup:archive:other", optionId: "other-option", optionName: "Separate install",
});
const withDistinctBackup = canonicalScope.canonicalWonOptions([unpaidLive, distinctBackup]);
assert.equal(withDistinctBackup.length, 2, "a distinct recovered backup remains in canonical results");
assert.ok(withDistinctBackup.includes(distinctBackup));
console.log("Daniel-only payment follow-up regression checks passed.");
