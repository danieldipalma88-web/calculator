import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, join, delimiter } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Disposable native PostgreSQL only: no env file, HTTP, production DSN or service registration.
const bin = process.env.POSTGRES_BIN_DIR;
if (!bin) throw Error('Set POSTGRES_BIN_DIR to the official portable PostgreSQL bin directory.');
const directory = resolve('outputs/model-research-native-' + randomUUID());
const data = join(directory, 'data');
const socket = createServer();
await new Promise(done => socket.listen(0, '127.0.0.1', done));
const port = socket.address().port;
await new Promise(done => socket.close(done));
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC,
  USERNAME: process.env.USERNAME, USERPROFILE: process.env.USERPROFILE, TEMP: process.env.TEMP, TMP: process.env.TMP,
  PATH: resolve(bin) + delimiter + (process.env.PATH || process.env.Path || ''),
  PGHOST: '127.0.0.1', PGPORT: String(port), PGUSER: 'postgres', PGDATABASE: 'postgres' };
const executable = name => join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
function command(name, args, input = '', extra = {}) {
  return new Promise((done, fail) => {
    const child = spawn(executable(name), args, { env: { ...env, ...extra }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill(); fail(Error(name + ' timed out')); }, 60000);
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timeout); fail(error); });
    child.on(name === 'pg_ctl' ? 'exit' : 'close', code => { clearTimeout(timeout); code === 0 ? done(stdout.trim()) : fail(Error(`${name} exited ${code}: ${(stderr || stdout).slice(-3000)}`)); });
    child.stdin.end(input);
  });
}
const sql = (text, app = 'qa-observer') => command('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], text, { PGAPPNAME: app });
const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
const secret = 'isolated-native-fixture-secret-never-used-in-production-0123456789';
const call = (action, id = null, lease = null, payload = {}) => `public.model_request_research_worker(${literal(secret)},${literal(action)},${id ? literal(id) : 'null'},${lease ? literal(lease) : 'null'},${literal(JSON.stringify(payload))}::jsonb)`;
const rpc = async (...args) => {
  const output = await sql(`set role anon; select ${call(...args)};`);
  return output ? JSON.parse(output) : null;
};
const parseLines = text => text.split('\n').filter(line => line.trim().startsWith('{')).map(line => JSON.parse(line));
async function barrier(app, event, milliseconds = 8000) {
  const started = Date.now();
  while (Date.now() - started < milliseconds) {
    const row = JSON.parse(await sql(`select coalesce((select jsonb_build_object('pid',pid,'wait_event',wait_event,'wait_event_type',wait_event_type,'state',state)
      from pg_stat_activity where application_name=${literal(app)} and ${event === 'PgSleep' ? "wait_event='PgSleep'" : "wait_event_type='Lock'"} limit 1),'null'::jsonb);`));
    if (row) return row;
    await delay(30);
  }
  throw Error('The concurrent transaction did not reach its required barrier: ' + app + ' ' + event);
}
const evidence = {};
let initialized = false, passed = false;
await mkdir(directory, { recursive: true });
try {
  await command('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8']);
  initialized = true;
  await command('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -c fsync=off -c shared_buffers=16MB -c max_connections=12`, '-w', 'start']);
  const user = '11111111-1111-4111-8111-111111111111', business = '33333333-3333-4333-8333-333333333333';
  await sql(`create role anon; create role authenticated; create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select '${user}'::uuid$$;
    create function auth.jwt() returns jsonb language sql stable as $$select '{"sub":"${user}","email":"fixture@example.invalid"}'::jsonb$$;
    grant usage on schema auth,public to anon,authenticated; grant execute on all functions in schema auth to anon,authenticated;
    create table auth.users(id uuid primary key,email text); insert into auth.users values('${user}','fixture@example.invalid');
    create table public.businesses(id uuid primary key,name text,operating_state text); insert into businesses values('${business}','Fixture NSW','NSW');
    create table public.approved_users(email text primary key,display_name text,role text,business_id uuid,is_locked boolean);
    insert into approved_users values('fixture@example.invalid','Fixture','business_owner','${business}',false);
    create table public.approved_user_businesses(email text,business_id uuid);
    grant select on businesses,approved_users,approved_user_businesses to authenticated;`);
  for (const file of ['calculator_guidance_and_model_requests_upgrade.sql', 'model_request_automation_upgrade.sql', 'model_request_followup_upgrade.sql', 'model_request_research_upgrade.sql']) {
    const migration = await readFile(new URL('../supabase/' + file, import.meta.url), 'utf8');
    (evidence.migrationHashes ||= {})[file] = createHash('sha256').update(migration).digest('hex');
    await sql(migration);
  }
  await sql(`insert into model_automation_private.settings(secret_hash) values(sha256(convert_to(${literal(secret)},'UTF8')));
    set role authenticated;
    insert into public.calculator_model_requests(user_id,client_request_id,requester_email,business_id,system_type,brand,model,capacity,phase,postcode,install_type)
      select '${user}',gen_random_uuid(),'fixture@example.invalid','${business}','split','Fixture','OUT / IN','3.5','single','2145','new' from generate_series(1,4);`);
  const ids = JSON.parse(await sql('select jsonb_agg(id order by created_at,id) from public.calculator_model_requests;'));
  const jobs = [];
  for (const id of ids) jobs.push(await rpc('enqueue', id));
  const a = sql(`begin; set role anon; select jsonb_build_object('pid',pg_backend_pid(),'result',${call('claim', jobs[0].id)}); select pg_sleep(3); commit;`, 'qa-claim-a');
  evidence.claimHolding = await barrier('qa-claim-a', 'PgSleep');
  const b = JSON.parse(await sql(`set role anon; select jsonb_build_object('pid',pg_backend_pid(),'result',${call('claim', jobs[0].id)});`, 'qa-claim-b'));
  const first = parseLines(await a)[0];
  assert.notEqual(first.pid, b.pid); assert.equal(b.result, null); assert.ok(first.result.lease);
  evidence.claimSessions = [first.pid, b.pid];
  console.log('PASS actual distinct-session claim exclusion while the first transaction holds its lock');
  const claim = first.result, other = await rpc('claim', jobs[1].id);
  const cp = { round: 0, input: [], records: [], sources: [] };
  for (const item of [claim, other]) await rpc('checkpoint', item.job.id, item.lease, cp);
  const reserve = { micros: 11729168, limit: 20000000 };
  const ra = sql(`begin; set role anon; select jsonb_build_object('cost',${call('reserve', claim.job.id, claim.lease, reserve)}); select pg_sleep(3); commit;`, 'qa-budget-a');
  evidence.budgetHolding = await barrier('qa-budget-a', 'PgSleep');
  const rb = sql(`set role anon; select ${call('reserve', other.job.id, other.lease, reserve)};`, 'qa-budget-b').then(value => ({ value }), error => ({ error }));
  evidence.budgetWaiting = await barrier('qa-budget-b', 'Lock');
  assert.notEqual(evidence.budgetHolding.pid, evidence.budgetWaiting.pid);
  const cost = parseLines(await ra)[0].cost;
  assert.match((await rb).error.message, /budget/);
  const budget = await rpc('budget'); assert.equal(budget.charged, 1063705); assert.equal(budget.reserved, reserve.micros);
  await rpc('rejected', cost);
  console.log('PASS competing budget transactions demonstrably wait on the monthly lock and cannot exceed A$20');
  const canonical = { brand: 'Fixture', model: 'OUT / IN', systemType: 'split', capacityKw: 3.5, phase: 'Single', registrationNumber: 'FIXTURE-REG' };
  const finding = { outcome: 'candidate', canonical };
  const outcome = { kind: 'no_rebate', product: { ...canonical, series: 'Fixture' }, identity: 'FIXTURE|IN/OUT', evidence: { verification: {
    kind: 'no_rebate', registry: { brand: 'Fixture', model: 'OUT / IN', registrationNumber: 'FIXTURE-REG' }, certificates: { esc: 0, prc: 0 },
  } } };
  await rpc('finish', claim.job.id, claim.lease, { state: 'pending_verification', result: finding });
  const oa = sql(`begin; set role anon; select ${call('apply_result', claim.job.id, null, { outcome })}; select pg_sleep(3); commit;`, 'qa-outcome-a');
  evidence.outcomeHolding = await barrier('qa-outcome-a', 'PgSleep');
  const ob = sql(`set role anon; select ${call('apply_result', claim.job.id, null, { outcome })};`, 'qa-outcome-b');
  evidence.outcomeWaiting = await barrier('qa-outcome-b', 'Lock');
  await oa; assert.equal(JSON.parse(await ob).already_applied, true);
  assert.equal(Number(await sql('select count(*) from model_automation_private.mail_outbox;')), 1);
  console.log('PASS concurrent completion enqueues exactly one fictional outcome email');
  const stale = await rpc('claim', jobs[2].id);
  await rpc('finish', stale.job.id, stale.lease, { state: 'pending_verification', result: finding });
  const edit = sql(`begin; update public.calculator_model_requests set model='OUT2 / IN2' where id=${literal(stale.job.external_id)}; select pg_sleep(3); commit;`, 'qa-edit-a');
  evidence.editHolding = await barrier('qa-edit-a', 'PgSleep');
  const late = sql(`set role anon; select ${call('apply_result', stale.job.id, null, { outcome })};`, 'qa-stale-b');
  evidence.staleWaiting = await barrier('qa-stale-b', 'Lock');
  await edit; assert.equal(JSON.parse(await late).state, 'superseded');
  assert.equal(Number(await sql('select count(*) from model_automation_private.mail_outbox;')), 1);
  console.log('PASS a concurrent request edit fences the old outcome with no obsolete notification');
  const interrupted = await rpc('claim', jobs[3].id);
  await rpc('checkpoint', interrupted.job.id, interrupted.lease, cp);
  await rpc('reserve', interrupted.job.id, interrupted.lease, reserve);
  await sql(`update model_automation_private.research_jobs set lease_until=now()-interval '1 second' where id=${literal(interrupted.job.id)};`);
  assert.equal(await rpc('claim', interrupted.job.id), null);
  assert.equal((await rpc('get', interrupted.job.id)).state, 'review');
  assert.equal((await rpc('budget')).reserved, reserve.micros);
  console.log('PASS uncertain interrupted charges remain reserved and are not replayed');
  evidence.postgresVersion = await sql('show server_version;');
  passed = true;
} finally {
  let cleanupError;
  if (initialized) {
    try {
      const running = await command('pg_ctl', ['-D', data, 'status']).then(() => true, () => false);
      if (running) await command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
      const stillRunning = await command('pg_ctl', ['-D', data, 'status']).then(() => true, () => false);
      assert.equal(stillRunning, false, 'The test cluster must not remain running');
      evidence.clusterStopped = true;
    } catch (error) { cleanupError = error; evidence.cleanupError = error.message; evidence.clusterStopped = false; }
  }
  await writeFile(join(directory, 'report.json'), JSON.stringify({ passed, paidCalls: 0, realRequestsModified: 0, ...evidence }, null, 2));
  console.log((evidence.clusterStopped ? 'Local database stopped. ' : 'Database setup did not start a server. ') + 'Evidence: ' + join(directory, 'report.json'));
  if (cleanupError) throw cleanupError;
}
