const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
require.extensions['.ts'] = (mod, path) => mod._compile(ts.transpileModule(fs.readFileSync(path, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText, path);
const { businessWonJobsPayload, createBusinessWonJobsCache, isBusinessId } = require('../lib/business-won-jobs.ts');
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333', D = '44444444-4444-4444-8444-444444444444';
const raw = (id = A) => ({ businessId: id, businessName: 'Fictional Air', jobs: [{ key: 'job-1', quoteName: 'Test customer', wonAt: '2026-11-23T22:00:00.000Z', salespersonName: 'Example salesperson', address: 'Fictional address', installationDate: '2026-12-01',
  secret: 'never expose', rows: [{ brand: 'Fixture', model: 'OUT/IN', type: 'split', size: '2.5kW', install: 'new', finalInc: 2000, rebate: '400.50', netProfit: 600, state: { secret: 'private' } }] }] });
const snapshot = raw(), before = JSON.stringify(snapshot);
const data = businessWonJobsPayload(snapshot, A, 1000);
assert.equal(JSON.stringify(snapshot), before, 'Read projection must not mutate quotes');
assert.equal(data.jobs[0].customerTotal, 2000);
assert.equal(data.jobs[0].rebateTotal, 400.5);
assert.equal(data.jobs[0].installerProfit, 600);
assert.ok(!JSON.stringify(data).includes('secret'));
assert.equal(data.checkedAt, new Date(1000).toISOString());
assert.throws(() => businessWonJobsPayload(raw(B), A));
assert.equal(isBusinessId('not-a-business'), false);
const missing = raw(); delete missing.jobs[0].rows[0].netProfit;
assert.equal(businessWonJobsPayload(missing, A).jobs[0].installerProfit, null);
missing.jobs[0].rows[0].finalInc = '';
assert.equal(businessWonJobsPayload(missing, A).jobs[0].customerTotal, null);
const duplicate = raw(); duplicate.jobs.push(duplicate.jobs[0]);
assert.throws(() => businessWonJobsPayload(duplicate, A));
const large = raw(); large.jobs[0].quoteName = 'x'.repeat(2 * 1024 * 1024);
assert.throws(() => businessWonJobsPayload(large, A), /too large/);
const tooManyRows = raw();
tooManyRows.jobs = Array.from({ length: 26 }, (_, i) => ({ ...raw().jobs[0], key: `many-${i}`, rows: Array.from({ length: 200 }, () => raw().jobs[0].rows[0]) }));
assert.throws(() => businessWonJobsPayload(tooManyRows, A), /too many systems/);

let clock = 0, loads = 0;
const cache = createBusinessWonJobsCache(() => clock);
async function cached(id = A) { return cache(id, async () => { loads++; return businessWonJobsPayload(raw(id), id); }); }
let actor, target, membership = false, rpcCalls = 0, rpcError = false, rpcPreparing = false, cancellationMode = false, readCalls = [];
const owner = { email: 'owner@example.invalid', role: 'business_owner', business_id: A, is_locked: false };
const client = {
  auth: { getUser: async () => ({ data: { user: actor ? { id: 'user-1', email: actor.email } : null }, error: null }) },
  from(table) {
    const filters = {};
    const query = { select: () => query, eq: (key, value) => { filters[key] = value; return query; },
      maybeSingle: async () => {
        readCalls.push([table, filters]);
        return { data: table === 'approved_users' ? (filters.email === actor?.email ? actor : target) : membership ? { business_id: filters.business_id } : null, error: null };
      } };
    return query;
  },
  rpc(name, args) {
    assert.equal(name, 'read_business_won_jobs'); rpcCalls++;
    return { abortSignal: async () => ({ data: rpcError ? null : rpcPreparing ? { status: 'refreshing', businessId: args.p_business_id } : raw(args.p_business_id), error: rpcError ? { message: 'internal error' } : null }) };
  },
};
require('../lib/supabase/server.ts');
require.cache[require.resolve('../lib/supabase/server.ts')].exports = { createSupabaseServerClient: async fetchImpl => cancellationMode ? {
  ...client,
  rpc: (_name, args) => ({ abortSignal: signal => fetchImpl(`https://fixture.invalid/rpc/${args.p_business_id}`, { signal }).then(async response => ({ data: await response.json(), error: null })) }),
} : client };
const { GET } = require('../app/api/business-won-jobs/route.ts');
const request = (query = `businessId=${A}`) => GET(new Request(`https://fixture.invalid/api/business-won-jobs?${query}`));

async function main() {
  await Promise.all([cached(), cached(), cached()]); assert.equal(loads, 1, 'Concurrent reads coalesce');
  await cached(B); assert.equal(loads, 2, 'Business cache separation');
  clock = 30_001; await cached(); assert.equal(loads, 3, 'Expired cache rechecks source');
  let attempts = 0;
  const bad = () => cache('failure', async () => { attempts++; throw new Error('outage'); });
  await assert.rejects(bad); await assert.rejects(bad); assert.equal(attempts, 2, 'Failures are not cached');
  actor = null; assert.equal((await request()).status, 401);
  actor = { ...owner, is_locked: true }; assert.equal((await request()).status, 403);
  actor = { ...owner, role: 'salesperson' }; assert.equal((await request()).status, 403);
  actor = owner;
  assert.equal((await request('businessId=bad')).status, 400);
  assert.equal((await request(`businessId=${B}`)).status, 403);
  assert.equal((await request(`businessId=${A}&as=other@example.invalid`)).status, 403);
  assert.equal(rpcCalls, 0, 'Denied users never read quote snapshots');
  const allowed = await request(); assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('cache-control'), 'private, no-store');
  assert.equal((await allowed.json()).jobs.length, 1);
  await request(); assert.equal(rpcCalls, 1);
  actor = { ...owner, is_locked: true }; assert.equal((await request()).status, 403);
  actor = { ...owner, business_id: B }; assert.equal((await request()).status, 403);
  actor = { email: 'admin@example.invalid', role: 'admin', is_locked: false }; target = owner;
  assert.equal((await request(`businessId=${A}&as=${owner.email}`)).status, 200);
  target = { ...owner, role: 'salesperson' }; assert.equal((await request(`businessId=${A}&as=${owner.email}`)).status, 403);
  target = { ...owner, is_locked: true }; assert.equal((await request(`businessId=${A}&as=${owner.email}`)).status, 403);
  target = owner;
  assert.equal((await request(`businessId=${B}&as=${owner.email}`)).status, 403);
  actor = { ...owner, business_id: B }; rpcError = true;
  const failure = await request(`businessId=${B}`); assert.equal(failure.status, 503);
  assert.ok(!(await failure.text()).includes('internal error'));
  rpcError = false; assert.equal((await request(`businessId=${B}`)).status, 200);
  actor = { ...owner, business_id: C }; rpcPreparing = true;
  const preparationCalls = rpcCalls;
  assert.equal((await request(`businessId=${C}`)).status, 202);
  assert.equal((await request(`businessId=${C}`)).status, 202);
  assert.equal(rpcCalls, preparationCalls + 2, 'Incomplete directory responses are not cached as reports');
  rpcPreparing = false; assert.equal((await request(`businessId=${C}`)).status, 200);

  actor = { ...owner, business_id: D }; cancellationMode = true;
  const originalFetch = global.fetch;
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  global.fetch = (input, options) => new Promise((resolve, reject) => {
    assert.equal(String(input), `https://fixture.invalid/rpc/${D}`);
    ready();
    const timer = setTimeout(() => { options.signal.removeEventListener('abort', abort); resolve(Response.json(raw(D))); }, 50);
    const abort = () => { clearTimeout(timer); reject(new Error('Request cancelled')); };
    if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const firstController = new AbortController();
    const first = GET(new Request(`https://fixture.invalid/api/business-won-jobs?businessId=${D}`, { signal: firstController.signal }));
    await started;
    const second = request(`businessId=${D}`);
    firstController.abort();
    assert.equal((await second).status, 200, 'A closing caller must not poison the shared read');
    await first;
  } finally { global.fetch = originalFetch; cancellationMode = false; }
  assert.ok(readCalls.every(([table]) => ['approved_users', 'approved_user_businesses'].includes(table)));

  const html = fs.readFileSync(new URL('../index.html', `file://${__filename.replaceAll('\\', '/')}`), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n');
  const ast = ts.createSourceFile('fixture.js', script, ts.ScriptTarget.Latest, true);
  const baseline = execFileSync('git', ['show', '598b29a:index.html'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).replaceAll('\r\n', '\n');
  const baseScript = [...baseline.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n');
  const baseAst = ts.createSourceFile('baseline.js', baseScript, ts.ScriptTarget.Latest, true);
  const functions = source => new Map(source.statements.filter(ts.isFunctionDeclaration).map(node => [node.name.text, node.getText(source).replaceAll('\r\n', '\n')]));
  const actualFunctions = functions(ast);
  for (const [name, code] of functions(baseAst)) {
    if (!['updateWonJobsCount', 'openWonJobsDrawer'].includes(name)) assert.equal(actualFunctions.get(name), code, `Unchanged existing calculator logic: ${name}`);
  }
  assert.equal(html.replace(/<script>[\s\S]*?<\/script>/g, '').replaceAll('\r\n', '\n'), baseline.replace(/<script>[\s\S]*?<\/script>/g, ''), 'Existing markup and styles unchanged');
  const names = ['businessWonJobsUrl', 'openWonJobsDrawer', 'openOwnWonJobsDrawer', 'updateWonJobsCount'];
  const source = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(ast)).join('\n');
  let context = { role: 'business_owner', businessId: A, email: owner.email, viewingEmail: owner.email }, opens = [], ownReads = 0, rendered = 0;
  let ownButton;
  const button = { textContent: '', after: child => { ownButton = child; } };
  const sandbox = { URLSearchParams, calculatorUserContext: () => context, window: { open: (...args) => opens.push(args) },
    document: { querySelectorAll: () => [{ parentElement: button }], createElement: () => ({}) }, collectWonJobs: () => { ownReads++; return []; },
    ensureSecondaryStartup() {}, renderWonJobs() { rendered++; }, $: () => ({ classList: { add() {} } }), syncOverlayState() {} };
  vm.createContext(sandbox); vm.runInContext(source, sandbox);
  sandbox.updateWonJobsCount(); sandbox.openWonJobsDrawer();
  assert.equal(ownReads, 0); assert.equal(rendered, 0);
  assert.equal(button.textContent, 'Business Won Jobs');
  assert.equal(opens[0][0], `/business-won-jobs?businessId=${A}`);
  assert.deepEqual(opens[0].slice(1), ['_blank', 'noopener']);
  assert.equal(ownButton.textContent, 'My Won Jobs'); ownButton.onclick(); assert.equal(rendered, 1, 'Owner keeps original own-job actions');
  context = { ...context, role: 'salesperson' }; sandbox.openWonJobsDrawer(); assert.equal(rendered, 2);
  context = { ...context, role: 'business_owner', email: 'admin@example.invalid' };
  assert.ok(sandbox.businessWonJobsUrl().includes('as=owner%40example.invalid'));
  console.log('Business Won Jobs access, cache, projection, unchanged-data and entry checks passed. No live services used.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
