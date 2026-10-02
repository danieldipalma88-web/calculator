import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const page = read('app/admin/users/page.tsx');
const workspace = read('app/admin/users/admin-workspace.tsx');
const loader = read('app/page-loading-overlay.tsx');
for (const view of ['businesses', 'users', 'jobs', 'prices']) {
  assert.ok(page.includes(`<AdminPanel view="${view}"`), `Missing ${view} panel`);
}
assert.ok(page.includes('defaultSort="active-newest"'));
assert.ok(page.includes('initialLastActiveAt={approvedUser.last_active_at}'));
assert.ok(page.includes('"Access locked" : "Access enabled"'));
assert.ok(!page.includes('<span className="locked-pill locked-state">Locked</span>'));
assert.ok(!page.includes('Source of truth'));
assert.ok(page.includes('className="won-payment-summary"'));
assert.ok(workspace.includes('hidden={active !== view}'));
assert.ok(workspace.includes('window.history.replaceState'));
assert.ok(workspace.includes('useFormStatus()'));
assert.ok(workspace.includes('form.removeAttribute("aria-busy")'));
assert.ok(loader.includes('if (captureForms) document.addEventListener("submit", handleSubmit, true)'));
assert.ok(loader.includes('document.addEventListener("click", handleClick, true)'));
assert.ok(!loader.includes('if (!captureForms) return;'), 'Navigation feedback must remain when global form loading is disabled');

const ast = ts.createSourceFile('page.tsx', page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const reset = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'resetPlatformCertificateValues');
assert.ok(reset);
const executable = ts.transpileModule(reset.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const writes = [];
const context = vm.createContext({
  FormData, Date, encodeURIComponent,
  DEFAULT_CERTIFICATE_VALUES: { escSpotPrice:29, prcSpotPrice:3 },
  requireAdmin: async () => ({supabase:{},email:'admin@example.test'}),
  listBusinesses: async () => ({data:[{id:'sample-business'}],errorMessage:''}),
  saveAuthoritativePlatformCertificateValues: async (...args) => { writes.push(['prices',...args]); return ''; },
  applyPlatformCertificateValuesToBusinesses: async (...args) => { writes.push(['businesses',...args]); return ''; },
  revalidatePath: () => {},
  redirect: url => { throw new Error(`REDIRECT:${url}`); },
});
vm.runInContext(executable, context);
for (const confirmation of [null, 'no', 'true']) {
  const form = new FormData();
  if (confirmation) form.set('confirmResetAgreements', confirmation);
  await assert.rejects(context.resetPlatformCertificateValues(form), /Confirm that you want/);
  assert.equal(writes.length, 0, 'Unconfirmed reset must not write prices or business fees');
}
const confirmed = new FormData(); confirmed.set('confirmResetAgreements','yes');
await assert.rejects(context.resetPlatformCertificateValues(confirmed), /reset%20to%20defaults/);
assert.equal(writes.length, 2);
assert.equal(writes[1].at(-1).resetAgreements, true);
console.log('Admin navigation, local loading, activity labels, payment labels and reset confirmation verified.');
