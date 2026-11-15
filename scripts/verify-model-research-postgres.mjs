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
const workerCall = (worker, action, id = null, lease = null, payload = {}) => `${worker}(${literal(secret)},${literal(action)},${id ? literal(id) : 'null'},${lease ? literal(lease) : 'null'},${literal(JSON.stringify(payload))}::jsonb)`;
const call = (...args) => workerCall('public.model_request_research_worker', ...args);
const contact = (...args) => workerCall('public.model_request_contact_worker', ...args);
const legacy = (...args) => workerCall('public.model_request_worker', ...args);
const selectWorker = async expression => {
  const output = await sql(`set role anon; select ${expression};`);
  return output ? JSON.parse(output) : null;
};
const rpc = (...args) => selectWorker(call(...args));
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

  const workflowFile = 'model_request_autonomous_workflow_upgrade.sql';
  const workflow = await readFile(new URL('../supabase/' + workflowFile, import.meta.url), 'utf8');
  evidence.migrationHashes[workflowFile] = createHash('sha256').update(workflow).digest('hex');
  await sql(workflow);
  await sql('update model_automation_private.settings set autonomous_workflow_enabled=true where singleton;');
  await sql(`update public.calculator_model_requests set created_at=now()-interval '1 day';
    set role authenticated;
    insert into public.calculator_model_requests(user_id,client_request_id,requester_email,business_id,system_type,brand,model,capacity,phase,postcode,install_type)
      values('${user}',gen_random_uuid(),'fixture@example.invalid','${business}','ducted','Fixture','RACE MODEL','12','single','2145','new'),
        ('${user}',gen_random_uuid(),'fixture@example.invalid','${business}','ducted','fixture',' race   model ','12','single','2145','new');`);
  const [canonicalId, duplicateId] = JSON.parse(await sql("select jsonb_agg(id order by created_at,id) from calculator_model_requests where upper(btrim(model)) like 'RACE%';"));
  const enqueueA = sql(`begin; set role anon; select ${call('enqueue', canonicalId)}; select pg_sleep(3); commit;`, 'qa-workflow-enqueue-a');
  evidence.workflowEnqueueHolding = await barrier('qa-workflow-enqueue-a', 'PgSleep');
  const enqueueB = sql(`set role anon; select ${call('enqueue', duplicateId)};`, 'qa-workflow-enqueue-b');
  evidence.workflowEnqueueWaiting = await barrier('qa-workflow-enqueue-b', 'Lock');
  assert.notEqual(evidence.workflowEnqueueHolding.pid, evidence.workflowEnqueueWaiting.pid);
  const [caseJob] = parseLines(await enqueueA);
  assert.equal(await enqueueB, '');
  assert.equal(await sql(`select canonical_id from model_automation_private.research_case_links where duplicate_id=${literal(duplicateId)};`), canonicalId);
  assert.equal(Number(await sql(`select count(*) from model_automation_private.research_jobs where external_id in (${literal(canonicalId)},${literal(duplicateId)});`)), 1);

  const caseLease = await rpc('claim', caseJob.id);
  await rpc('finish', caseJob.id, caseLease.lease, { state: 'review', result: { outcome: 'review', summary: 'No matching registration' } });
  const review = { outcome: { kind: 'review', registry_match_unverified: true, reason: 'No matching registration' } };
  const alertA = sql(`begin; set role anon; select ${call('apply_result', caseJob.id, null, review)}; select pg_sleep(3); commit;`, 'qa-workflow-alert-a');
  evidence.workflowAlertHolding = await barrier('qa-workflow-alert-a', 'PgSleep');
  const alertB = sql(`set role anon; select ${call('apply_result', caseJob.id, null, review)};`, 'qa-workflow-alert-b');
  evidence.workflowAlertWaiting = await barrier('qa-workflow-alert-b', 'Lock');
  await alertA;
  assert.equal(JSON.parse(await alertB).already_applied, true);
  assert.equal(Number(await sql(`select count(*) from model_automation_private.mail_outbox where request_id=${literal(canonicalId)};`)), 1);
  const contactClaim = `select public.model_request_contact_worker(${literal(secret)},'claim',${literal(canonicalId)});`;
  const sendA = sql(`begin; set role anon; ${contactClaim} select pg_sleep(3); commit;`, 'qa-workflow-send-a');
  evidence.workflowSendHolding = await barrier('qa-workflow-send-a', 'PgSleep');
  const sendB = sql(`set role anon; ${contactClaim}`, 'qa-workflow-send-b');
  evidence.workflowSendWaiting = await barrier('qa-workflow-send-b', 'Lock');
  assert.equal(parseLines(await sendA)[0].kind, 'escalation');
  assert.equal(await sendB, '');
  assert.equal((await rpc('budget')).reserved, reserve.micros);
  console.log('PASS independent sessions serialize exact duplicate intake, unmatched alert creation, and send authorization without changing reserved spend');

  for (const kind of ['ready_to_add', 'no_rebate']) {
    const added = kind === 'ready_to_add';
    const tag = added ? 'confirmation' : 'zero';
    const model = `RACE-${tag}-OUT / RACE-${tag}-IN`;
    const requests = parseLines(await sql(`set role authenticated;
      insert into public.calculator_model_requests(user_id,client_request_id,requester_email,business_id,system_type,brand,model,capacity,phase,postcode,install_type,notes)
      values('${user}',gen_random_uuid(),'fixture@example.invalid','${business}','split','Fixture',${literal(model)},'3.5','single','2145','new','older evidence'),
        ('${user}',gen_random_uuid(),'fixture@example.invalid','${business}','split','Fixture',${literal(model)},'3.5','single','2145','new','newer evidence')
      returning jsonb_build_object('id',id,'notes',notes);`));
    const ids = ['older evidence', 'newer evidence'].map(notes => requests.find(row => row.notes === notes).id);
    await sql(`update public.calculator_model_requests set created_at=now()-interval '2 days' where id=${literal(ids[0])};`);
    const exact = { ...canonical, model, registrationNumber: `RACE-${tag}-REG` };
    const decision = { outcome: { kind, product: { ...exact, series: 'Fixture' }, identity: `FIXTURE|RACE-${tag}-IN/RACE-${tag}-OUT`, evidence: { verification: {
      kind: added ? 'verified' : 'no_rebate', registry: exact, certificates: { esc: added ? 1 : 0, prc: 0 },
    } } } };
    const jobs = [];
    for (const id of ids) {
      const job = await rpc('enqueue', id);
      assert.equal(job?.external_id, id, `${tag} notes must not merge before verification`);
      const lease = await rpc('claim', job.id);
      await rpc('finish', job.id, lease.lease, { state: 'pending_verification', result: { outcome: 'candidate', canonical: exact } });
      jobs.push(job);
    }
    const state = added ? 'added' : 'no_rebate';
    assert.equal((await rpc('apply_result', jobs[1].id, null, decision)).state, state);
    const claim = id => added ? call('confirmation_claim', id) : contact('claim', id);
    const firstClaim = added ? await selectWorker(claim(ids[1])) : null;
    const start = firstClaim ? legacy('email_start', ids[1], firstClaim.job.lease_token) : claim(ids[1]);
    const send = sql(`begin; set role anon; select ${start}; select pg_sleep(3); commit;`, `qa-${tag}-start`);
    const sending = await barrier(`qa-${tag}-start`, 'PgSleep');
    const merge = sql(`set role anon; select ${call('apply_result', jobs[0].id, null, decision)};`, `qa-${tag}-merge`);
    const merging = await barrier(`qa-${tag}-merge`, 'Lock');
    assert.notEqual(sending.pid, merging.pid);
    evidence[`${tag}DeliveryRace`] = { sending, merging };
    const firstStart = parseLines(await send)[0];
    assert.equal(JSON.parse(await merge).state, state);
    assert.equal(await selectWorker(claim(ids[0])), null);
    assert.equal(await selectWorker(claim(ids[1])), null);
    assert.equal((await rpc('get', jobs[0].id)).completion_suppressed, true);
    assert.equal((await rpc('get', jobs[1].id)).completion_suppressed, false);
    assert.equal(await sql(`select canonical_id from model_automation_private.research_case_links where duplicate_id=${literal(ids[1])};`), ids[0]);
    await sql(added
      ? `update public.calculator_model_request_jobs set lease_until=now()-interval '1 second' where request_id=${literal(ids[1])};`
      : `update model_automation_private.mail_outbox set lease_until=now()-interval '1 second' where mail_key=${literal(firstStart.mail_key)};`);
    const retry = await selectWorker(claim(ids[1]));
    assert.equal(await selectWorker(claim(ids[1])), null);
    assert.equal(await selectWorker(claim(ids[0])), null);
    if (added) {
      assert.equal(retry.request.id, firstClaim.request.id, 'request UUID is the provider idempotency key input');
      assert.notEqual(retry.job.lease_token, firstClaim.job.lease_token);
      const restarted = await selectWorker(legacy('email_start', retry.request.id, retry.job.lease_token));
      assert.equal(restarted.email_started_at, firstStart.email_started_at);
      await selectWorker(legacy('email_sent', retry.request.id, retry.job.lease_token, { id: 'fixture-confirmed' }));
    } else {
      assert.equal(retry.mail_key, firstStart.mail_key);
      assert.equal(retry.started_at, firstStart.started_at);
      assert.deepEqual(retry.payload, firstStart.payload);
      assert.equal(retry.attempts, 2);
      await selectWorker(contact('sent', retry.request_id, retry.lease, { key: retry.mail_key, provider_id: 'fixture-zero' }));
    }
    assert.equal(await selectWorker(claim(ids[1])), null);
    console.log(`PASS ${tag}: older verification waits on newer send authorization; after timeout only the original provider key retries`);
  }

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
