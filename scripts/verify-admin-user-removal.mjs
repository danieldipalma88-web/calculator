import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';

const read = (file) => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
function load(file, dependencies, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, URL, AbortController, setTimeout, clearTimeout, ...globals, require: (name) => {
      assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name];
    } });
  return exports;
}
let config, queries, revalidated;
function reset(overrides = {}) { config = { role: 'admin', email: 'admin@example.test', targetEmail: 'target@example.test', exists: true, ...overrides }; queries = []; revalidated = []; }
const client = createClient('https://mock.invalid', 'test-key', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: async (input, options) => {
    const url = new URL(String(input));
    queries.push({ url: url.pathname, method: options.method, body: options.body, email: url.searchParams.get('email') });
    assert.ok(!/calculator_data|businesses|payments|quotes/.test(url.pathname), 'Removal must not read or mutate quote/payment/business data');
    if (url.pathname.endsWith('/rpc/admin_delete_approved_user')) {
      assert.deepEqual(JSON.parse(options.body), { target_email: config.targetEmail.toLowerCase() });
      if (config.rpcError) return Response.json({ message: config.rpcError }, { status: 400 });
      if (!config.noop) config.exists = false;
      return Response.json(null);
    }
    assert.ok(url.pathname.endsWith('/approved_users'));
    if (options.method === 'DELETE') {
      assert.equal(url.searchParams.get('email'), `eq.${config.targetEmail}`, 'Fallback uses the canonical literal, never a wildcard');
      if (config.deleteError) return Response.json({ message: 'denied' }, { status: 403 });
      config.exists = false;
      return new Response(null, { status: 204 });
    }
    assert.equal(options.method, 'GET');
    const filter = email => `email.ilike.${JSON.stringify(email.toLowerCase().replace(/[\\%_]/g, '\\$&'))}`;
    assert.equal(url.searchParams.get('or'), `(${filter(config.email)},${filter(config.targetEmail)})`);
    assert.equal(url.searchParams.get('select'), 'email,role,is_locked');
    if (config.readError) return Response.json({ message: 'unavailable' }, { status: 503 });
    const actor = { email: config.email, role: config.role, is_locked: false, ...config.actor };
    const rows = [...(config.missingActor ? [] : [actor]), ...(config.duplicateActor ? [actor] : []),
      ...(config.exists && !config.hiddenTarget ? [{ email: config.targetEmail, role: 'user', is_locked: false }] : []), ...(config.extraRows || [])];
    return Response.json(rows, { headers: config.missingCount ? {} : { 'Content-Range': `0-${rows.length - 1}/${config.count ?? rows.length}` } });
  } },
});
const admin = load('lib/admin.ts', {});
const route = load('app/api/admin/approved-users/route.ts', {
  'next/server': { NextResponse: { json: Response.json } },
  'next/cache': { revalidatePath: (path) => revalidated.push(path) },
  '../../../../lib/admin': admin,
  '../../../../lib/supabase/approved-calculator-session': { getApprovedCalculatorSession: async () => config.status
    ? { status: config.status, error: 'Access denied' }
    : { status: 200, session: { supabase: client, email: config.email, approvedUser: { role: config.role } } } },
});
function request(method = 'DELETE', email = 'target@example.test', headers = {}) {
  return new Request('https://calculator.example.test/api/admin/approved-users' + (method === 'GET' ? `?email=${encodeURIComponent(email)}` : ''), {
    method, headers: { origin: 'https://calculator.example.test', 'Content-Type': 'application/json', ...headers },
    body: method === 'GET' ? undefined : JSON.stringify({ email }),
  });
}
async function response(method = 'DELETE', email, headers) {
  const result = await route[method](request(method, email, headers));
  assert.match(result.headers.get('cache-control'), /private, no-store/);
  return { status: result.status, body: await result.json() };
}
for (const headers of [{ origin: '' }, { origin: 'https://elsewhere.test' }, { 'sec-fetch-site': 'cross-site' }]) {
  reset(); assert.equal((await response('DELETE', undefined, headers)).status, 403); assert.equal(queries.length, 0);
}
for (const overrides of [{ status: 401 }, { status: 403 }, { status: 503 }, ...['user', 'salesperson', 'business_owner', 'agency'].map(role => ({ role }))]) {
  reset(overrides); assert.notEqual((await response()).status, 200); assert.equal(queries.length, 0);
}
for (const email of ['admin@example.test', 'danieldipalma88@gmail.com', '', 'bad']) {
  reset(); assert.notEqual((await response('DELETE', email)).status, 200); assert.equal(queries.length, 0);
}
reset();
assert.deepEqual((await response('DELETE', 'TARGET@EXAMPLE.TEST')).body, { ok: true, email: 'target@example.test', removed: true });
assert.deepEqual(queries.map(q => q.method), ['POST', 'GET']);
assert.deepEqual(revalidated, ['/admin/users']);
reset({ rpcError: 'Could not find the function in the schema cache' });
assert.equal((await response()).body.removed, true);
assert.deepEqual(queries.map(q => q.method), ['POST', 'GET', 'DELETE', 'GET']);
reset({ targetEmail: 'Target@Example.Test', rpcError: 'Could not find the function in the schema cache' });
assert.equal((await response()).body.removed, true);
reset({ targetEmail: 'Target@Example.Test', noop: true });
assert.equal((await response()).status, 409, 'Mixed-case target cannot be falsely confirmed as removed');
for (const overrides of [
  { actor: { role: 'user' }, hiddenTarget: true }, { actor: { is_locked: true }, hiddenTarget: true },
  { missingActor: true }, { duplicateActor: true }, { actor: { is_locked: undefined } },
  { missingCount: true }, { count: 1001 },
]) {
  reset(overrides); assert.equal((await response('GET')).status, 503, 'Missing authority or truncated read is not confirmation');
}
for (const targetEmail of ['Target_Name@Example.Test', 'target%name@example.test', 'target*name@example.test', 'target,name@example.test', 'target"name@example.test']) {
  reset({ targetEmail, rpcError: 'Could not find the function in the schema cache', extraRows: [{ email: 'target-other@example.test', role: 'user', is_locked: false }] });
  assert.equal((await response('DELETE', targetEmail)).body.removed, true);
}
reset({ rpcError: 'permission denied' });
assert.equal((await response()).status, 503); assert.equal(queries.length, 1); assert.equal(revalidated.length, 0);
reset({ noop: true }); assert.equal((await response()).status, 409);
reset({ readError: true }); assert.equal((await response()).status, 503);
for (const exists of [true, false]) {
  reset({ exists }); assert.equal((await response('GET')).body.removed, !exists);
  assert.deepEqual(queries.map(q => q.method), ['GET'], 'Uncertain outcomes must be checked without repeating deletion');
}

let timers = new Map(), nextTimer = 0, fetchImpl, calls;
const browser = load('lib/admin-user-removal-client.ts', {}, {
  fetch: (...args) => { calls.push(args); return fetchImpl(...args); },
  setTimeout: (fn) => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimeout: id => timers.delete(id),
});
calls = []; fetchImpl = async () => Response.json({ ok: true, email: 'target@example.test', removed: true });
assert.equal((await browser.requestUserRemoval('target@example.test')).removed, true); assert.equal(timers.size, 0);
assert.equal(calls[0][1].method, 'DELETE');
calls = []; await browser.requestUserRemoval('target@example.test', true); assert.equal(calls[0][1].method, 'GET');
assert.equal(calls[0][1].body, undefined);
calls = []; fetchImpl = async () => ({ ok: true, json: () => new Promise(() => {}) });
const hung = browser.requestUserRemoval('target@example.test');
const rejected = assert.rejects(hung, /too long/);
await Promise.resolve(); assert.equal(timers.size, 1); [...timers.values()][0](); await rejected;
assert.equal(timers.size, 0); assert.equal(calls[0][1].signal.aborted, true);
assert.equal(calls.length, 1, 'Never automatically repeat a destructive action');
fetchImpl = async () => Response.json({ error: 'Denied' }, { status: 403 });
await assert.rejects(browser.requestUserRemoval('target@example.test'), /Denied/); assert.equal(timers.size, 0);
const button = read('app/admin/users/remove-user-button.tsx');
assert.match(button, /finally\s*\{\s*busy\.current = false/);
assert.match(button, /setState\("uncertain"\)/);
assert.match(button, /window\.confirm/);
assert.doesNotMatch(button, /router\.refresh|location\.reload/);
const page = read('app/admin/users/page.tsx');
assert.doesNotMatch(page, /action=\{removeApprovedUser\}|legacy-users-table/);
assert.match(page, /<RemoveUserButton/);
console.log('Admin removal: authorization, confirmed read-back, no full reload, error/timeout recovery and read-only status checks passed.');
