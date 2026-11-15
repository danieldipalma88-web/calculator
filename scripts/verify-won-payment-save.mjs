import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { delimiter, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { saveWonPaymentOverlay } from '../lib/won-payment-save.ts';
import { manageWonBatchLease } from '../lib/won-batch-lease.ts';

const files = ['user_access_lock_upgrade.sql', 'data_safety_upgrade.sql', 'won_job_batches_upgrade.sql', 'won_payment_status_save_upgrade.sql'];
const migrations = await Promise.all(files.map(file => readFile(new URL('../supabase/' + file, import.meta.url), 'utf8')));
const owner = '11111111-1111-4111-8111-111111111111';
const admin = '22222222-2222-4222-8222-222222222222';
const locked = '33333333-3333-4333-8333-333333333333';
const other = '44444444-4444-4444-8444-444444444444';
const key = 'installerWonOptionAdminStateV1', alias = 'greenEnergyWonOptionAdminStateV1';
const before = '2026-01-01T00:00:00.000Z', stamp = new Date().toISOString();
const legacyReset = { email: 'REP@example.invalid', optionId: 'existing', wonAt: before, paymentResetAt: before };
const legacyPaid = { wonByEmail: 'REP@example.invalid', optionId: 'unrelated', wonAt: before, agencyPaidInAt: before, extra: { keep: true } };
const request = { userEmail: 'rep@example.invalid', optionId: 'synthetic-won', wonAt: before, updatedAt: stamp, paymentRequestedAt: stamp };
const unchangedTail = [legacyReset, legacyPaid];
const change = { ownerColumn: 'user_id', ownerValue: owner, storageKey: key, overlay: [request, ...unchangedTail], previousUpdatedAt: before };
const lit = value => value === null ? 'null' : "'" + String(value).replaceAll("'", "''") + "'";
const claims = (id, email) => JSON.stringify({ sub: id, email });
const as = (id = admin, email = 'admin@example.invalid') =>
  `reset role; set role authenticated; set request.jwt.claims=${lit(claims(id, email))};`;
const schema = `create role anon; create role authenticated; create schema auth;
  create function auth.jwt() returns jsonb language sql stable as $$select nullif(current_setting('request.jwt.claims',true),'')::jsonb$$;
  create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
  grant usage on schema auth to authenticated;
  create table public.approved_users(email text primary key, role text, is_locked boolean);
  insert into public.approved_users values ('admin@example.invalid','admin',false),('owner@example.invalid','user',false),
    ('locked@example.invalid','admin',true),('danieldipalma88@gmail.com','admin',true);
  alter table public.approved_users enable row level security;
  create policy read_own_approval on public.approved_users for select to authenticated using (lower(email)=lower(auth.jwt()->>'email'));
  grant select on public.approved_users to authenticated;
  create table public.user_calculator_data(user_id uuid primary key, email text, data jsonb not null, updated_at timestamptz);
  create unique index calculator_email on public.user_calculator_data(lower(email)) where email is not null;
  alter table public.user_calculator_data enable row level security;
  grant select,update on public.user_calculator_data to authenticated;`;
const policies = `create policy read_calculator on public.user_calculator_data for select to authenticated
  using(user_id=auth.uid() or public.is_approved_admin());
  create policy update_calculator on public.user_calculator_data for update to authenticated
  using(user_id=auth.uid() or public.is_approved_admin()) with check(user_id=auth.uid() or public.is_approved_admin());`;
const expression = (overlay = change.overlay, expected = before, { id = owner, email = null, storageKey = key, readback = false, batchId = null, token = null } = {}) =>
  `public.save_won_payment_overlay(${lit(id)},${lit(email)},${lit(storageKey)},${lit(expected)},${lit(JSON.stringify(overlay))},${readback},${lit(batchId)},${lit(token)})`;
const journalIds = ['a'.repeat(64), 'b'.repeat(64)];
const batchItems = journalIds.map(id => ({ id, quote: 'Fixture', salesperson: 'Fixture', recovered: false }));
const batchInsert = (id, kind = 'paid_out') => `insert into public.won_job_batches(id,kind,label,items) values
  (${lit(id)},${lit(kind)},${lit(kind === 'manual' ? 'fixture' : '')},${lit(JSON.stringify(batchItems))});`;
const leaseExpr = (batchId, token, action, outcomes = action === 'claim' ? [] : null) =>
  `public.manage_won_batch_lease(${lit(batchId)},${lit(token)},${lit(action)},${outcomes === null ? 'null' : lit(JSON.stringify(outcomes))})`;
const appendDirectly = (batchId, outcomes) =>
  `update public.won_job_batches set outcomes=${lit(JSON.stringify(outcomes))} where id=${lit(batchId)};`;
const saved = updatedAt => ({ status: 'saved', updated_at: updatedAt });
const unconfirmed = { status: 'unconfirmed' };

// The installed Supabase client runs against this intercepted fetch only.
function client(responses, rpcName = 'save_won_payment_overlay') {
  const calls = [];
  const supabase = createClient('https://won-payment-fixture.invalid', 'fixture-key', {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: async (url, init) => {
      assert.equal(String(url), `https://won-payment-fixture.invalid/rest/v1/rpc/${rpcName}`);
      assert.equal(init.method, 'POST'); assert.ok(init.signal instanceof AbortSignal);
      calls.push(JSON.parse(init.body));
      const response = responses.shift();
      assert.ok(response, 'unexpected RPC; no extra write or readback is allowed');
      if (typeof response === 'function') return await response(calls.at(-1));
      if (response instanceof Error) throw response;
      const [data, status = 200] = response;
      return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    } },
  });
  return { supabase, calls };
}

async function verifyHelper() {
  const cancelled = [{ code: '57014', message: 'fixture cancellation' }, 500];
  const unknown = [{ code: 'XX000', message: 'fixture unknown' }, 500];
  const cases = [
    { replies: [[saved(stamp)]], writes: 1, reads: 0, message: '' },
    { replies: [cancelled, [saved(stamp)]], writes: 2, reads: 0, message: '' },
    { replies: [cancelled, cancelled], writes: 2, reads: 0, message: /timed out.*no payment change/ },
    { replies: [cancelled, [{ status: 'conflict' }]], writes: 2, reads: 0, message: /calculator changed/ },
    { replies: [unknown, [saved(stamp)]], writes: 1, reads: 1, message: '' },
    { replies: [new Error('lost response'), [unconfirmed]], writes: 1, reads: 1, message: null },
    { replies: [cancelled, unknown, [unconfirmed]], writes: 2, reads: 1, message: null },
    { replies: [[{ code: '55P03', message: 'lock wait' }, 500]], writes: 1, reads: 0, message: /calculator was busy/ },
    { replies: [[{ status: 'saved' }], [unconfirmed]], writes: 1, reads: 1, message: null },
  ];
  for (const { replies, writes, reads, message } of cases) {
    const mock = client(replies);
    const result = saveWonPaymentOverlay(mock.supabase, change);
    if (message === null) await assert.rejects(result, /Payment update not confirmed/);
    else if (typeof message === 'string') assert.equal(await result, message);
    else assert.match(await result, message);
    const [first] = mock.calls;
    assert.deepEqual(first, { p_owner_id: owner, p_owner_email: null, p_storage_key: key,
      p_expected_updated_at: before, p_overlay: JSON.stringify(change.overlay) });
    assert.equal(mock.calls.length, writes + reads);
    for (const call of mock.calls.slice(0, writes)) assert.deepEqual(call, first);
    if (reads) assert.deepEqual(mock.calls.at(-1), { ...first, p_readback: true });
  }
  const email = client([[saved(stamp)]]);
  assert.equal(await saveWonPaymentOverlay(email.supabase, { ...change, ownerColumn: 'email', ownerValue: ' OWNER@EXAMPLE.INVALID ', overlay: JSON.stringify(change.overlay) }), '');
  assert.equal(email.calls[0].p_owner_email, 'owner@example.invalid');
  assert.equal(email.calls[0].p_owner_id, null);
  const invalid = client([]);
  assert.match(await saveWonPaymentOverlay(invalid.supabase, { ...change, storageKey: 'installerSavedQuoteSetsV1' }), /identify/);
  assert.equal(invalid.calls.length, 0);
  const batchId = randomUUID(), token = randomUUID();
  const lostLease = client([[{ status: 'lease_lost' }]]);
  assert.match(await saveWonPaymentOverlay(lostLease.supabase, { ...change, batchLease: { batchId, token } }), /lease ended/);
  assert.equal(lostLease.calls.length, 1);
  assert.equal(lostLease.calls[0].p_batch_id, batchId); assert.equal(lostLease.calls[0].p_batch_token, token);
  const lease = client([[true], [false], new Error('append reply lost')], 'manage_won_batch_lease');
  assert.equal(await manageWonBatchLease(lease.supabase, { batchId, token, action: 'claim' }), false);
  assert.equal(await manageWonBatchLease(lease.supabase, { batchId, token, action: 'claim', outcomes: [] }), true);
  assert.deepEqual(lease.calls[0], { p_batch_id: batchId, p_token: token, p_action: 'claim', p_outcomes: [] });
  assert.equal(await manageWonBatchLease(lease.supabase, { batchId, token, action: 'check' }), false);
  const outcomes = [{ id: journalIds[0], status: 'confirmed' }];
  assert.equal(await manageWonBatchLease(lease.supabase, { batchId, token, action: 'record', outcomes }), false);
  assert.deepEqual(lease.calls[2], { p_batch_id: batchId, p_token: token, p_action: 'record', p_outcomes: outcomes });
  assert.equal(lease.calls.length, 3, 'an ambiguous append is not retried');
  console.log('PASS Supabase transport: one exact 57014 retry, one narrow readback for unknowns, no blind retry');
}

async function verifyPGlite() {
  const local = new URL('../outputs/automation-test-deps/package/dist/index.js', import.meta.url);
  const fallback = new URL('../../calculator-commission-fix/outputs/automation-test-deps/package/dist/index.js', import.meta.url);
  const { PGlite } = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE).href : (existsSync(local) ? local : fallback).href);
  const db = new PGlite();
  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
  const rpc = async (...args) => (await one(`select ${expression(...args)} as result`)).result;
  try {
    await db.exec(schema);
    for (const migration of migrations) await db.exec(migration);
    await db.exec(policies);
    await db.exec(migrations.at(-1));
    const setBlob = (name, bytes) => {
      const rows = Array.from({ length: Math.ceil(bytes / 128) }, (_, i) => createHash('sha512').update(name + i).digest('hex'));
      return JSON.stringify([{ name, syntheticState: rows.join('').slice(0, bytes), price: 1234 }]);
    };
    const large = { installerSavedQuoteSetsV1: setBlob('sets', 5_150_000), installerMasterQuoteLogV1: setBlob('rows', 820_000),
      installerQuoteOptionDefsV1: setBlob('defs', 75_000), [key]: JSON.stringify(unchangedTail), installerPricesV1: '{"fictional":2345}' };
    for (const [id, email, data, at] of [[owner, 'Owner@Example.Invalid', large, before], [other, 'other@example.invalid', { [alias]: [] }, null]]) {
      await db.query('insert into user_calculator_data values($1,$2,$3::jsonb,$4)', [id, email, JSON.stringify(data), at]);
    }
    const old = await one('select md5(data::text) total, md5((data-$1::text)::text) unchanged, octet_length(data::text) bytes from user_calculator_data where user_id=$2', [key, owner]);
    assert.ok(old.bytes > 6_000_000);
    for (const [id, email] of [[owner, 'owner@example.invalid'], [locked, 'locked@example.invalid'],
      [locked, 'danieldipalma88@gmail.com'], [null, 'admin@example.invalid']]) {
      await db.exec(as(id, email));
      for (const readback of [false, true]) await assert.rejects(() => rpc(change.overlay, before, { readback }), { code: '42501' });
    }
    await db.exec('reset role; set role anon');
    await assert.rejects(() => rpc(), { code: '42501' });
    await db.exec(as());
    await assert.rejects(() => rpc(change.overlay, before, { email: 'owner@example.invalid' }), { code: '22023' });
    await assert.rejects(() => rpc(change.overlay, before, { storageKey: 'installerSavedQuoteSetsV1' }), { code: '22023' });
    await assert.rejects(() => rpc([request]), { code: '22023' });
    await assert.rejects(() => rpc([request, legacyReset]), /replace unrelated payment records/);
    await assert.rejects(() => rpc([request, legacyReset, { ...legacyPaid, agencyPaidInAt: stamp }]), /replace unrelated payment records/);
    await assert.rejects(() => rpc([{ ...request, unlockedAt: before }, ...unchangedTail]), /unlock or reset markers/);
    assert.equal((await rpc(change.overlay, before, { storageKey: alias })).status, 'conflict');

    const lost = client([
      async input => { assert.equal(input.p_readback, undefined); assert.equal((await rpc(JSON.parse(input.p_overlay))).status, 'saved'); throw new Error('reply lost after actual SQL commit'); },
      async input => { assert.equal(input.p_readback, true); return new Response(JSON.stringify(await rpc(JSON.parse(input.p_overlay), before, { readback: true }))); },
    ]);
    assert.equal(await saveWonPaymentOverlay(lost.supabase, change), '');
    assert.equal(lost.calls.length, 2);
    assert.equal((await rpc()).status, 'conflict');
    assert.deepEqual(await rpc([{ ...request, paidInAt: stamp }, ...unchangedTail], before, { readback: true }), unconfirmed);
    await db.exec('reset role');
    const stored = await one('select md5((data-$1::text)::text) unchanged, jsonb_typeof(data->$1::text) type, data->>$1::text overlay from user_calculator_data where user_id=$2', [key, owner]);
    assert.deepEqual(stored, { unchanged: old.unchanged, type: 'string', overlay: JSON.stringify(change.overlay) });
    assert.deepEqual((await db.query('select md5(data::text) total from user_calculator_data_backups where user_id=$1', [owner])).rows, [{ total: old.total }]);

    await db.exec(as());
    const later = new Date(Date.parse(stamp) + 1).toISOString();
    const payout = [{ ...request, paidOutAt: stamp }, ...unchangedTail];
    await assert.rejects(() => rpc([{ ...payout[0], paymentRequestedAt: '' }, ...unchangedTail], stamp), /replace existing payment timestamps/);
    const payoutResult = await rpc(payout, stamp, { id: null, email: ' OWNER@EXAMPLE.INVALID ' });
    assert.equal(new Date(payoutResult.updated_at).toISOString(), later);
    assert.equal((await rpc(payout, stamp, { readback: true })).status, 'saved');
    assert.deepEqual(await rpc(change.overlay, before, { readback: true }), unconfirmed);
    const array = await rpc([request], null, { id: other, storageKey: alias });
    assert.equal(array.status, 'saved');
    assert.equal((await rpc([request], null, { id: other, storageKey: alias, readback: true })).status, 'saved');
    await db.exec('reset role');
    assert.deepEqual(await one('select data->$1::text as overlay from user_calculator_data where user_id=$2', [alias, other]), { overlay: [request] });
    const last = JSON.parse((await one('select data->>$1::text as overlay from user_calculator_data where user_id=$2', [key, owner])).overlay)[0];
    assert.equal(last.paymentRequestedAt, stamp); assert.equal(last.paidOutAt, stamp); assert.equal(last.paidInAt, undefined);
    await db.query('update user_calculator_data set data=jsonb_build_object($1::text, $2::jsonb), updated_at=$3 where user_id=$4', [alias, JSON.stringify([legacyReset]), before, other]);
    await db.exec(as());
    const normalizedTarget = { userEmail: 'rep@example.invalid', dataUserId: other, dataOwnerEmail: 'other@example.invalid', sourceId: 'current',
      optionId: legacyReset.optionId, wonAt: before, paymentResetAt: before, updatedAt: stamp, paidOutAt: stamp };
    assert.equal((await rpc([normalizedTarget], before, { id: other, storageKey: alias })).status, 'saved');
    console.log('PASS local database: admin/locked/owner ACLs, exact version readback, legacy markers and aliases, 6 MB preservation and original backup');

    const badOverlays = [null, { oldPayment: before }, 17, false, 'null', '{"oldPayment":true}', '17', '"not an array"', '[incomplete'];
    for (const [index, badOverlay] of badOverlays.entries()) {
      const id = randomUUID();
      const snapshot = { [key]: badOverlay, installerMasterQuoteLogV1: '[{"id":"fixture","finalInc":321}]',
        installerSavedQuoteSetsV1: '[{"id":"saved-fixture"}]', installerPricesV1: '{"fictional":123}' };
      await db.exec('reset role');
      await db.query('insert into user_calculator_data values($1,$2,$3::jsonb,$4)', [id, `bad-overlay-${index}@example.invalid`, JSON.stringify(snapshot), before]);
      await db.exec(as());
      await assert.rejects(() => rpc([request], before, { id }), { code: index === badOverlays.length - 1 ? '22P02' : '22023' });
      await db.exec('reset role');
      const preserved = await one('select data,updated_at from user_calculator_data where user_id=$1', [id]);
      assert.deepEqual(preserved.data, snapshot);
      assert.equal(new Date(preserved.updated_at).toISOString(), before);
      assert.deepEqual(await one('select count(*)::int n from user_calculator_data_backups where user_id=$1', [id]), { n: 0 });
    }
    console.log('PASS all nine present malformed overlays are rejected with the full snapshot, version and backups untouched');

    const batchId = randomUUID(), legacyId = randomUUID(), manualId = randomUUID(), firstToken = randomUUID(), resumedToken = randomUUID();
    const lease = async (...args) => (await one(`select ${leaseExpr(...args)} as result`)).result;
    await db.exec(as());
    await db.exec(batchInsert(batchId) + batchInsert(legacyId) + batchInsert(manualId, 'manual'));
    await assert.rejects(() => one('select * from won_payment_private.batch_leases'), { code: '42501' });
    const legacyPrefix = [{ id: journalIds[0], status: 'failed' }];
    await db.exec(appendDirectly(legacyId, legacyPrefix));
    assert.deepEqual(await one('select outcomes from public.won_job_batches where id=$1', [legacyId]), { outcomes: legacyPrefix });
    assert.equal(await lease(legacyId, firstToken, 'claim', []), false, 'cannot act on an out-of-date journal after a definitive legacy failure');
    assert.deepEqual(await rpc(payout, later, { batchId: legacyId, token: firstToken }), { status: 'lease_lost' });
    assert.equal(await lease(legacyId, firstToken, 'claim', legacyPrefix), true);
    assert.equal(await lease(legacyId, firstToken, 'release'), true);
    await assert.rejects(() => db.exec(appendDirectly(legacyId, [...legacyPrefix, { id: journalIds[1], status: 'confirmed' }])), { code: '42501' });
    assert.equal(await lease(manualId, firstToken, 'claim'), false);
    await db.exec(as(other)); // Same email is not the stored actor UID.
    assert.equal(await lease(batchId, firstToken, 'claim'), false);
    await db.exec(as());
    assert.equal(await lease(batchId, firstToken, 'claim', null), false);
    assert.equal(await lease(batchId, firstToken, 'claim'), true);
    assert.equal(await lease(batchId, resumedToken, 'claim'), false);
    assert.equal(await lease(batchId, firstToken, 'check'), true);
    const prefix = [{ id: journalIds[0], status: 'confirmed' }];
    await db.exec(`set won_payment.record_token=${lit(firstToken)};`);
    await assert.rejects(() => db.exec(appendDirectly(batchId, prefix)), { code: '42501' });
    assert.equal(await lease(batchId, firstToken, 'record', prefix), true);
    assert.equal(await lease(batchId, firstToken, 'record', prefix), false);
    await db.exec(`reset role; update won_payment_private.batch_leases set lease_until=clock_timestamp()-interval '1 second' where batch_id=${lit(batchId)};`);
    await db.exec(as());
    assert.equal(await lease(batchId, firstToken, 'check'), false);
    assert.equal(await lease(batchId, resumedToken, 'claim', []), false);
    assert.equal(await lease(batchId, resumedToken, 'claim', prefix), true);
    assert.equal(await lease(batchId, firstToken, 'release'), false);
    const next = [...prefix, { id: journalIds[1], status: 'failed' }];
    assert.equal(await lease(batchId, firstToken, 'record', next), false);
    assert.deepEqual(await rpc(payout, later, { batchId, token: firstToken }), { status: 'lease_lost' });
    assert.equal(await lease(batchId, resumedToken, 'record', [prefix[0], { ...next[1], amount: 100 }]), false);
    assert.equal(await lease(batchId, resumedToken, 'record', [{ ...prefix[0], status: 'failed' }, next[1]]), false);
    assert.equal(await lease(batchId, resumedToken, 'record', next), true);
    assert.equal(await lease(batchId, resumedToken, 'release'), true);
    assert.deepEqual(await one('select outcomes from public.won_job_batches where id=$1', [batchId]), { outcomes: next });
    console.log('PASS private lease ACLs, exclusive claim/renew/release, takeover fences for both payment and journal, immutable journal prefix');
  } finally { await db.close(); }
}

async function verifyNative(bin) {
  const dir = resolve('outputs/won-payment-native-' + randomUUID());
  await mkdir(dir, { recursive: true });
  const data = join(dir, 'data');
  const socket = createServer();
  await new Promise(done => socket.listen(0, '127.0.0.1', done));
  const port = socket.address().port;
  await new Promise(done => socket.close(done));
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC,
    USERNAME: process.env.USERNAME, USERPROFILE: process.env.USERPROFILE, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PATH: resolve(bin) + delimiter + (process.env.PATH || process.env.Path || ''),
    PGHOST: '127.0.0.1', PGPORT: String(port), PGUSER: 'postgres', PGDATABASE: 'postgres' };
  function command(name, args, input = '', app = 'won-observer') {
    return new Promise((done, fail) => {
      const child = spawn(join(bin, name + (process.platform === 'win32' ? '.exe' : '')), args, {
        env: { ...env, PGAPPNAME: app }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      const timeout = setTimeout(() => { child.kill(); fail(new Error(name + ' timed out')); }, 30_000);
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', error => { clearTimeout(timeout); fail(error); });
      child.on(name === 'pg_ctl' ? 'exit' : 'close', code => {
        clearTimeout(timeout);
        code === 0 ? done(stdout.trim()) : fail(new Error(`${name} exited ${code}: ${stderr.slice(-1500)}`));
      });
      child.stdin.end(input);
    });
  }
  const sql = (text, app) => command('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'], text, app);
  async function barrier(app, condition) {
    for (let i = 0; i < 100; i++) {
      const pid = await sql(`select pid from pg_stat_activity where application_name=${lit(app)} and ${condition};`);
      if (pid) return Number(pid);
      await delay(30);
    }
    throw new Error(`Session ${app} did not reach its barrier`);
  }
  let initialized = false;
  try {
    await command('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8']);
    initialized = true;
    await command('pg_ctl', ['-D', data, '-l', join(dir, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start']);
    await sql(schema);
    for (const migration of migrations) await sql(migration);
    await sql(policies);
    await sql(`insert into user_calculator_data values(${lit(owner)},'owner@example.invalid','{}',${lit(before)});`);
    const first = sql(`begin; ${as()} select ${expression([request])}; select pg_sleep(1.9); commit;`, 'won-race-a');
    const pid = await barrier('won-race-a', "wait_event='PgSleep'");
    const different = [{ ...request, paidOutAt: stamp }];
    const second = sql(`${as()} select ${expression(different)};`, 'won-race-b');
    assert.notEqual(await barrier('won-race-b', "wait_event_type='Lock'"), pid);
    assert.equal(JSON.parse(await first).status, 'saved');
    assert.equal(JSON.parse(await second).status, 'conflict');
    assert.equal(JSON.parse(await sql(`${as()} select ${expression([request], before, { readback: true })};`)).status, 'saved');
    assert.deepEqual(JSON.parse(await sql(`${as()} select ${expression(different, before, { readback: true })};`)), unconfirmed);

    const blocker = sql(`begin; select user_id from user_calculator_data where user_id=${lit(owner)} for update; select pg_sleep(4.8); commit;`, 'won-lock-holder');
    await barrier('won-lock-holder', "wait_event='PgSleep'");
    const started = Date.now();
    const blocked = sql(`${as()} select ${expression(different, stamp)};`, 'won-lock-timeout');
    const rejected = assert.rejects(blocked, /55P03.*lock timeout/);
    const inspected = JSON.parse(await sql(`${as()} select ${expression([request], before, { readback: true })};`, 'won-readback'));
    assert.equal(inspected.status, 'saved');
    await rejected;
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 2_800 && elapsed < 5_000, `expected a roughly 3 s lock wait, got ${elapsed} ms`);
    await blocker;
    assert.equal(await sql('select count(*) from user_calculator_data_backups;'), '1');
    console.log(`PASS native PostgreSQL ${await sql('show server_version;')}: two-session CAS, exact readback during a row lock, and lock timeout (${elapsed} ms)`);

    const batchId = randomUUID(), tokenA = randomUUID(), tokenB = randomUUID();
    await sql(`${as()} ${batchInsert(batchId)}`);
    const claimA = sql(`begin; ${as()} select ${leaseExpr(batchId, tokenA, 'claim')}; select pg_sleep(1.6); commit;`, 'won-claim-a');
    const claimant = await barrier('won-claim-a', "wait_event='PgSleep'");
    const claimB = sql(`${as()} select ${leaseExpr(batchId, tokenB, 'claim')};`, 'won-claim-b');
    assert.notEqual(await barrier('won-claim-b', "wait_event_type='Lock'"), claimant);
    assert.equal(await claimA, 't'); assert.equal(await claimB, 'f');

    await sql(`update won_payment_private.batch_leases set lease_until=clock_timestamp()+interval '1.2 seconds' where batch_id=${lit(batchId)};`);
    const lockedWrite = sql(`begin; ${as()} select ${expression(different, stamp, { batchId, token: tokenA })}; select pg_sleep(1.9); commit;`, 'won-leased-write');
    const writer = await barrier('won-leased-write', "wait_event='PgSleep'");
    const takeover = sql(`${as()} select ${leaseExpr(batchId, tokenB, 'claim')};`, 'won-takeover');
    assert.notEqual(await barrier('won-takeover', "wait_event_type='Lock'"), writer);
    const written = JSON.parse(await lockedWrite);
    assert.equal(written.status, 'saved'); assert.equal(await takeover, 't');
    assert.deepEqual(JSON.parse(await sql(`${as()} select ${expression([request], written.updated_at, { batchId, token: tokenA })};`)), { status: 'lease_lost' });
    const outcome = [{ id: journalIds[0], status: 'confirmed' }];
    assert.equal(await sql(`${as()} select ${leaseExpr(batchId, tokenA, 'record', outcome)};`), 'f');
    assert.equal(await sql(`${as()} select ${leaseExpr(batchId, tokenB, 'record', outcome)};`), 't');
    assert.equal(await sql('select count(*) from user_calculator_data_backups;'), '2');
    console.log('PASS native separate-session claim and expiry takeover wait for the payment lease row lock; old token cannot write or append');

    const legacyId = randomUUID(), managedId = randomUUID(), repeatableId = randomUUID();
    await sql(`${as()} ${batchInsert(legacyId)} ${batchInsert(managedId)} ${batchInsert(repeatableId)}`);
    const failed = [{ id: journalIds[0], status: 'failed' }];
    const legacyAppend = sql(`begin; ${as()} ${appendDirectly(legacyId, failed)} select pg_sleep(1.6); commit;`, 'won-legacy-append');
    const legacyPid = await barrier('won-legacy-append', "wait_event='PgSleep'");
    const stale = sql(`${as()} select ${leaseExpr(legacyId, tokenA, 'claim', [])};`, 'won-stale-claim');
    assert.notEqual(await barrier('won-stale-claim', "wait_event_type='Lock'"), legacyPid);
    assert.equal(await legacyAppend, ''); assert.equal(await stale, 'f');
    assert.deepEqual(JSON.parse(await sql(`${as()} select ${expression(different, written.updated_at, { batchId: legacyId, token: tokenA })};`)), { status: 'lease_lost' });
    assert.equal(await sql(`${as()} select ${leaseExpr(legacyId, tokenB, 'claim', failed)};`), 't');

    const managedClaim = sql(`begin; ${as()} select ${leaseExpr(managedId, tokenA, 'claim')}; select pg_sleep(1.6); commit;`, 'won-managed-claim');
    const managedPid = await barrier('won-managed-claim', "wait_event='PgSleep'");
    const racedLegacyAppend = sql(`${as()} ${appendDirectly(managedId, failed)}`, 'won-fenced-legacy');
    const rejectedAppend = assert.rejects(racedLegacyAppend, /42501.*requires an active payment lease/);
    assert.notEqual(await barrier('won-fenced-legacy', "wait_event_type='Lock'"), managedPid);
    assert.equal(await managedClaim, 't'); await rejectedAppend;
    assert.equal(await sql(`${as()} select ${leaseExpr(managedId, tokenA, 'release')};`), 't');
    await assert.rejects(() => sql(`${as()} ${appendDirectly(managedId, failed)}`), /42501.*requires an active payment lease/);
    const oldSnapshot = sql(`begin isolation level repeatable read; ${as()}
      select outcomes from public.won_job_batches where id=${lit(repeatableId)};
      select pg_sleep(1.6); ${appendDirectly(repeatableId, failed)} commit;`, 'won-old-snapshot');
    const rejectedSnapshot = assert.rejects(oldSnapshot, /42501.*requires read committed isolation/);
    await barrier('won-old-snapshot', "wait_event='PgSleep'");
    assert.equal(await sql(`${as()} select ${leaseExpr(repeatableId, tokenA, 'claim')};`), 't');
    await rejectedSnapshot;
    console.log('PASS native legacy/claim races in both orders: stale expected journal cannot authorise a payment, and a managed batch stays fenced after release');
  } finally {
    if (initialized && await command('pg_ctl', ['-D', data, 'status']).then(() => true, () => false)) {
      await command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
      assert.equal(await command('pg_ctl', ['-D', data, 'status']).then(() => true, () => false), false);
    }
  }
}

if (process.argv.includes('--native')) {
  if (!process.env.POSTGRES_BIN_DIR) throw new Error('Set POSTGRES_BIN_DIR to the portable PostgreSQL bin directory.');
  await verifyNative(process.env.POSTGRES_BIN_DIR);
} else {
  await verifyHelper();
  await verifyPGlite();
}
