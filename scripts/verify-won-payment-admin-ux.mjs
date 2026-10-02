import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("..", import.meta.url);
const [admin, styles] = await Promise.all([
  readFile(new URL("app/admin/users/page.tsx", root), "utf8"),
  readFile(new URL("app/globals.css", root), "utf8"),
]);

const checks = [
  [admin.includes('data-won-payment-filter="all"'), "All payment filter"],
  [admin.includes('data-won-payment-filter="not-requested"'), "Not requested payment filter"],
  [admin.includes('data-won-payment-filter="awaiting-agency"'), "Awaiting agency payment filter"],
  [admin.includes('data-won-payment-filter="commission-to-pay"'), "Commission to pay filter"],
  [admin.includes('data-won-payment-filter="settled"'), "Settled payment filter"],
  [admin.includes('data-payment-awaiting-agency={!option.paidInAt && (option.paymentRequestedAt || option.paidOutAt)'), "paid-out-before-received bucket"],
  [admin.includes('function wonPaymentStatusLabel(paymentRequestedAt: string, paidInAt: string, paidOutAt: string)'), "independent payment display label"],
  [admin.includes('if (paidInAt) return "Commission to pay";'), "received-only display label"],
  [admin.includes('if (paidOutAt) return "Awaiting agency payment";'), "paid-out-before-received display label"],
  [admin.includes('Record payment received'), "agency receipt action label"],
  [admin.includes('Record commission paid'), "salesperson payout action label"],
  [admin.includes('className="won-payment-line"'), "two payment lines"],
  [admin.includes('data-mobile-summary-agency-outstanding'), "agency outstanding total"],
  [admin.includes('data-mobile-summary-sales-outstanding'), "sales commission outstanding total"],
  [admin.includes('data-mobile-summary-agency-profit'), "agency profit total"],
  [admin.includes('function bulkEligibleCards(mode, cards)'), "client bulk eligibility filter"],
  [admin.includes('mode === "payment_requested") return cards.filter'), "client requested-payment skip filter"],
  [admin.includes('bulkConfirmationMessage(mode, selectedCards, eligibleCards)'), "bulk count and amount confirmation"],
  [admin.includes('paymentAction ? " (" + amountLabel + " " + currency(amount) + ")?" : "?"'), "non-payment bulk confirmation without a dollar amount"],
  [admin.includes('function wonOptionPaymentAlreadyRecorded('), "server payment timestamp guard"],
  [admin.includes('function wonAdminPaymentAlreadyRecorded('), "effective admin payment timestamp guard"],
  [admin.includes('record.paymentRequestedAt || record.paidInAt || record.paidOutAt'), "requested-payment progression guard"],
  [admin.includes('return WON_PAYMENT_ALREADY_RECORDED;'), "server skip result"],
  [admin.includes('alreadyRecordedCount += 1;'), "bulk skip reporting"],
  [admin.includes('if (!next.paidInAt && !next.agencyPaidInAt)'), "agency receipt timestamp preservation"],
  [admin.includes('if (!next.paidOutAt && !next.salespersonPaidOutAt)'), "salesperson payout timestamp preservation"],
  [admin.includes('option.paidOutAt ? "Paid" : option.paidInAt ? "Commission to pay" : "Not paid"'), "salesperson status before agency receipt"],
  [!admin.includes('if (!option.salespersonCommissionTotal)'), "zero sales commission semantics preserved"],
  [styles.replace(/\r\n/g, '\n').includes('.won-selection-toolbar:not([hidden]) {\n  position: fixed;'), "fixed bottom selection toolbar"],
  [styles.includes('--won-selection-height'), "measured clearance below the final job"],
  [admin.includes('new ResizeObserver(updateWonDockSpacing)'), "toolbar clearance follows wrapping and viewport changes"],
  [styles.includes('.won-secondary-actions'), "secondary action menus"],
];

const failed = checks.filter(([passed]) => !passed);
if (failed.length) {
  failed.forEach(([, label]) => console.error(`Missing ${label}.`));
  process.exit(1);
}

const syntax = ts.createSourceFile("admin.tsx", admin, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["wonPaymentStatusLabel", "applyWonPaymentFields"];
const helpers = syntax.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
assert.equal(helpers.length, names.length);
const source = helpers.map(node => node.getText(syntax)).join("\n");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
for (const [requested, received, paid, label] of [
  ["", "", "", "Not requested"],
  ["request", "", "", "Awaiting agency payment"],
  ["", "receipt", "", "Commission to pay"],
  ["", "", "payout", "Awaiting agency payment"],
  ["request", "receipt", "payout", "Settled"],
]) assert.equal(sandbox.wonPaymentStatusLabel(requested, received, paid), label);
for (const [mode, field] of [["payment_requested", "paymentRequestedAt"], ["paid_in", "paidInAt"], ["paid_out", "paidOutAt"]]) {
  const first = sandbox.applyWonPaymentFields({ [field]: "2026-01-01", untouched: "keep" }, mode, "admin@example.test");
  assert.equal(first[field], "2026-01-01", `${mode} must preserve the original date`);
  assert.equal(first.untouched, "keep");
}
const receiptOnly = sandbox.applyWonPaymentFields({}, "paid_in", "admin@example.test");
assert.ok(receiptOnly.paidInAt);
assert.equal(receiptOnly.paidOutAt, undefined, "Receipt must not imply salesperson payment");
const payoutOnly = sandbox.applyWonPaymentFields({}, "paid_out", "admin@example.test");
assert.ok(payoutOnly.paidOutAt);
assert.equal(payoutOnly.paidInAt, undefined, "Payout must not imply agency receipt");

const bulkControls = syntax.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'WonBulkActionControls').getText(syntax);
const primaryForm = bulkControls.slice(0, bulkControls.indexOf('</form>'));
assert.deepEqual([...primaryForm.matchAll(/name="bulkMode" value="([^"]+)"/g)].map(match => match[1]), ['paid_in', 'paid_out']);
for (const mode of ['payment_requested', 'update_rebate', 'reset_payment', 'unlock', 'delete']) {
  assert.ok(bulkControls.includes(`value="${mode}"`), `Secondary ${mode} remains available`);
}
assert.equal((admin.match(/<WonBulkActionControls\s*\/>/g) || []).length, 1, 'One shared action bar on desktop and mobile');
const scriptNode = syntax.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'wonExportScript');
const scriptScope = {};
vm.runInNewContext(ts.transpileModule(scriptNode.getText(syntax), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, scriptScope);
const scriptAst = ts.createSourceFile('won-runtime.js', scriptScope.wonExportScript(), ts.ScriptTarget.Latest, true);
const dockFunctions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && ['updateWonSelectionDock', 'updateWonDockSpacing', 'handleWonKeydown', 'handleWonSubmit', 'setWonSectionLoading'].includes(node.name?.text)) dockFunctions.push(node.getText(scriptAst));
  ts.forEachChild(node, visit);
}
visit(scriptAst);
assert.equal(dockFunctions.length, 5);
const dock = { hidden: true, offsetHeight: 112 };
const count = {}, scope = {}, clear = {}, actions = { open: true };
let selection = [], reservedHeight, hasDock, focusReturned = false, busy = false;
const section = {
  classList: { toggle: (_name, value) => { hasDock = value; } },
  style: { setProperty: (_name, value) => { reservedHeight = value; } },
  setAttribute: () => { busy = true; }, removeAttribute: () => { busy = false; }, getAttribute: () => busy ? 'true' : null,
  querySelector: selector => selector === '[data-won-mobile-selection-dock]' ? dock : {},
};
const dockScope = {
  selectedWonCards: () => selection, visibleWonCards: () => [{}, {}, {}], hasActiveWonFilter: () => true,
  document: {
    querySelector: selector => selector === '.won-options-section' ? section : selector === '[data-won-mobile-actions][open]' ? { ...actions, querySelector: () => ({ focus: () => { focusReturned = true; } }) } : dock,
    querySelectorAll: selector => ({ '[data-won-selection-count]': [count], '[data-won-selection-scope]': [scope], '[data-won-clear-selection]': [clear], '[data-won-mobile-actions]': [actions] })[selector],
  },
};
vm.runInNewContext(dockFunctions.join('\n'), dockScope);
dockScope.updateWonSelectionDock();
assert.equal(dock.hidden, true); assert.equal(hasDock, false); assert.equal(actions.open, false);
selection = [{}, {}]; dockScope.updateWonSelectionDock();
assert.equal(dock.hidden, false); assert.equal(hasDock, true);
assert.equal(count.textContent, '2 selected'); assert.equal(scope.textContent, '3 filtered quotes visible');
assert.equal(clear.hidden, false); assert.equal(reservedHeight, '112px');
dock.offsetHeight = 210; dockScope.updateWonDockSpacing(); assert.equal(reservedHeight, '210px');
dockScope.handleWonKeydown({ key: 'Escape' }); assert.equal(focusReturned, true);
dockScope.setWonSectionLoading(true, 'Recording...'); assert.equal(dock.inert, true);
let prevented = 0, confirmations = 0, saves = 0, restored = 0;
const submitEvent = { target: { closest: () => section, hasAttribute: () => true, getAttribute: () => null }, submitter: { name: 'bulkMode', value: 'paid_in' }, preventDefault: () => { prevented++; } };
dockScope.handleWonSubmit(submitEvent);
assert.equal(prevented, 1, 'Pending payment blocks repeat submissions before changing selection or confirming');
dockScope.setWonSectionLoading(false); assert.equal(dock.inert, false);
Object.assign(dockScope, {
  bulkModeForForm: (_form, submitter) => submitter.value,
  bulkEligibleCards: (_mode, cards) => cards,
  setBulkSelections: cards => assert.equal(cards, selection),
  bulkConfirmationMessage: () => 'Confirm selected jobs',
  window: { confirm: () => { confirmations++; return false; } },
  refreshBulkInputs: () => { restored++; },
  rememberWonUiState: () => {}, setWonActionLoading: () => { saves++; },
});
dockScope.handleWonSubmit(submitEvent);
assert.equal(confirmations, 1); assert.equal(restored, 1); assert.equal(saves, 0, 'Cancellation does not start a payment');
dockScope.window.confirm = () => true;
dockScope.handleWonSubmit(submitEvent); assert.equal(saves, 1);
console.log("Won Quote payment admin UX and payment-state behavior checks passed.");
