import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

// Local PostgreSQL only. Never loads an env file or connects to Supabase.
const fallback = new URL('../../calculator-commission-fix/outputs/automation-test-deps/package/dist/index.js', import.meta.url);
const moduleUrl = process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE).href
  : existsSync(new URL('../outputs/automation-test-deps/package/dist/index.js', import.meta.url))
    ? new URL('../outputs/automation-test-deps/package/dist/index.js', import.meta.url).href : fallback.href;
const { PGlite } = await import(moduleUrl);
const db = new PGlite();
const user = '11111111-1111-4111-8111-111111111111';
const admin = '22222222-2222-4222-8222-222222222222';
const business = '33333333-3333-4333-8333-333333333333';
const secret = 'local-test-secret-never-used-in-production-0123456789';
const reservation = 11729168;
const product = { systemType: 'split', brand: 'Fixture', model: 'OUT / IN', capacityKw: 3.5, phase: 'Single', series: 'Fixture' };
const canonical = { ...product, brand: 'FIXTURE', registrationNumber: 'FIXTURE-REG' };
const finding = { outcome: 'candidate', summary: 'Exact registered pair', canonical, identity: 'FIXTURE|IN/OUT', sourceUrls: ['https://data.gov.au/'] };
const outcome = (kind = 'no_rebate') => ({ kind, product, identity: 'FIXTURE|IN/OUT', evidence: {
  research: finding, verification: { kind: kind === 'no_rebate' ? 'no_rebate' : 'verified',
    registry: { brand: canonical.brand, model: canonical.model, registrationNumber: canonical.registrationNumber },
    certificates: kind === 'no_rebate' ? { esc: 0, prc: 0 } : { esc: 1.5, prc: 2.75 } },
} });
let checks = 0;
const pass = name => { checks++; console.log(`ok ${checks} - ${name}`); };
const q = (sql, args = []) => db.query(sql, args);
const one = async (sql, args = []) => (await q(sql, args)).rows[0];
async function as(role = 'anon', id = user, email = 'user@example.invalid') {
  await db.exec('reset role');
  await q("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: id, email })]);
  await db.exec(`set role ${role}`);
}
async function rpc(action, id = null, lease = null, data = {}) {
  return (await one('select public.model_request_research_worker($1,$2,$3,$4,$5) as r', [secret, action, id, lease, JSON.stringify(data)])).r;
}
async function contact(action, id = null, lease = null, data = {}) {
  return (await one('select public.model_request_contact_worker($1,$2,$3,$4,$5) as r', [secret, action, id, lease, JSON.stringify(data)])).r;
}
async function owner(sql, args = []) { await db.exec('reset role'); return q(sql, args); }
async function submit(details = {}) {
  await as('authenticated');
  if (details.id) {
    // Fixed IDs are test fixtures for the three explicitly reviewed restore pins.
    await owner('begin');
    await db.exec('alter table calculator_model_requests disable trigger validate_new_model_request');
  }
  let r;
  try {
    r = await one(`insert into public.calculator_model_requests(id,user_id,client_request_id,requester_email,business_id,system_type,brand,model,capacity,phase,notes,postcode,install_type)
      values(coalesce($12::uuid,gen_random_uuid()),$1,$2,'user@example.invalid',$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
    [user, randomUUID(), business, details.system_type || 'split', details.brand || 'Fixture', details.model || 'OUT / IN',
      details.capacity || '3.5', details.phase || '', details.notes || '', details.postcode || '2145', details.install_type || 'new', details.id || null]);
    if (details.id) await db.exec('alter table calculator_model_requests enable trigger validate_new_model_request; commit');
  } catch (error) { if (details.id) await db.exec('rollback'); throw error; }
  // Keep test fixtures out of the production submission quota, under owner only.
  await owner("update public.calculator_model_requests set created_at=now()-interval '1 day' where id=$1", [r.id]);
  await as();
  return r;
}
async function queued(details) { const r = await submit(details); return { request: r, job: await rpc('enqueue', r.id) }; }
async function saved(state = 'pending_verification', result = finding, details) {
  const item = await queued(details); const claim = await rpc('claim', item.job.id);
  await rpc('finish', item.job.id, claim.lease, { state, result });
  return { ...item, job: await rpc('get', item.job.id) };
}
const cp = round => ({ round, input: [], records: [], sources: [], response: null });

try {
  // Freeze only this in-memory test database, never a live PostgreSQL instance.
  await db.exec("create or replace function pg_catalog.now() returns timestamptz language sql stable as $$select timestamptz '2026-11-09 03:00:00+00'$$");
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
    create function auth.jwt() returns jsonb language sql stable as $$select nullif(current_setting('request.jwt.claims',true),'')::jsonb$$;
    grant usage on schema auth,public to anon,authenticated;
    grant execute on all functions in schema auth to anon,authenticated;
    create table auth.users(id uuid primary key,email text);
    insert into auth.users values('${user}','user@example.invalid'),('${admin}','admin@example.invalid');
    create table public.businesses(id uuid primary key,name text,operating_state text);
    insert into businesses values('${business}','Fixture NSW','NSW');
    create table public.approved_users(email text primary key,display_name text,role text,business_id uuid,is_locked boolean);
    insert into approved_users values('user@example.invalid','Fixture User','business_owner','${business}',false),('admin@example.invalid','Admin','admin','${business}',false);
    create table public.approved_user_businesses(email text,business_id uuid);
    grant select on businesses,approved_users,approved_user_businesses to authenticated;`);
  for (const file of ['calculator_guidance_and_model_requests_upgrade.sql', 'model_request_automation_upgrade.sql', 'model_request_followup_upgrade.sql']) {
    await db.exec(await readFile(new URL(`../supabase/${file}`, import.meta.url), 'utf8'));
  }
  await q("insert into model_automation_private.settings(secret_hash) values(sha256(convert_to($1,'UTF8')))", [secret]);
  const legacy = await submit({ notes: 'Original note remains verbatim.' });
  await owner("update calculator_model_request_jobs set state='review',contact_state='escalated' where request_id=$1", [legacy.id]);
  const before = await one('select to_jsonb(r) as r from calculator_model_requests r where id=$1', [legacy.id]);
  const migration = await readFile(new URL('../supabase/model_request_research_upgrade.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  assert.deepEqual((await one('select to_jsonb(r) as r from calculator_model_requests r where id=$1', [legacy.id])).r, before.r);
  assert.equal((await one('select count(*)::int as n from model_automation_private.research_jobs')).n, 0);
  assert.equal((await one('select seed_spent::int as n from model_automation_private.research_budget where month=$1', ['2026-11-01'])).n, 1063705);
  await q("insert into model_automation_private.research_budget(month,seed_spent) values('2026-11-01',1063705) on conflict(month) do nothing");
  assert.equal((await one('select seed_spent::int as n from model_automation_private.research_budget where month=$1', ['2026-11-01'])).n, 1063705);
  pass('migration preserves legacy requests/jobs, creates no research, and seeds known spend once');

  await as();
  await assert.rejects(() => q("select public.model_request_research_worker('wrong','budget')"), /Not authorized/);
  await assert.rejects(() => q('select * from model_automation_private.research_jobs'), /permission denied/);
  await assert.rejects(() => q('select model_automation_private.research_snapshot($1)', [legacy.id]), /permission denied/);
  await assert.rejects(() => q('select model_automation_private.contact_worker_before_research($1,\'claim\',null,null,\'{}\')', [secret]), /permission denied/);
  await assert.rejects(() => q('select public.admin_model_request_list()'), /permission denied/);
  assert.equal(await rpc('enqueue'), null);
  assert.equal(await rpc('enqueue', legacy.id), null);
  assert.equal(await rpc('confirmation_claim', legacy.id), null);
  await as('authenticated');
  await assert.rejects(() => rpc('budget'), /permission denied/);
  await assert.rejects(() => q('select public.admin_model_request_list()'), /Not authorized/);
  pass('secret, private table/function ACLs and admin authorization fail closed');

  await as();
  const explicit = await rpc('enqueue', legacy.id, null, { retry: true });
  assert.ok(explicit?.id, 'only a targeted, explicit secret-authorized retry can reopen legacy review');
  assert.equal(explicit.request.notes, 'Original note remains verbatim.');
  assert.equal((await rpc('enqueue', legacy.id)).id, explicit.id);
  const claims = await Promise.all([rpc('claim', explicit.id), rpc('claim', explicit.id)]);
  assert.equal(claims.filter(Boolean).length, 1);
  await assert.rejects(() => rpc('check_lease', explicit.id, randomUUID()), /lease is no longer current/);
  await rpc('checkpoint', explicit.id, claims.find(Boolean).lease, cp(0));
  await rpc('yield', explicit.id, claims.find(Boolean).lease);
  assert.equal((await rpc('enqueue')).id, explicit.id, 'cron resumes the oldest yielded durable job');
  const next = await rpc('claim', explicit.id);
  await assert.rejects(() => rpc('finish', explicit.id, claims.find(Boolean).lease, { state: 'review', result: {} }), /lease/);
  await rpc('finish', explicit.id, next.lease, { state: 'review', result: { summary: 'Manual review' } });
  assert.equal((await rpc('enqueue')).id, explicit.id, 'cron also recovers an unapplied review outcome');
  await rpc('apply_result', explicit.id, null, { outcome: { kind: 'review', reason: 'Manual review' } });
  pass('targeted review retry, immutable snapshots, competing claims, yield and stale lease fencing');

  const inaccessibleOldest = await submit();
  const inaccessibleBusiness = randomUUID();
  await owner("insert into businesses(id,name,operating_state) values($1,'Inaccessible fixture NSW','NSW')", [inaccessibleBusiness]);
  await owner('update calculator_model_requests set business_id=$2 where id=$1', [inaccessibleOldest.id, inaccessibleBusiness]);
  await owner("update calculator_model_request_jobs set available_at=now()-interval '30 days' where request_id=$1", [inaccessibleOldest.id]);
  const laterIntake = await submit();
  await as();
  const selectedIntake = await rpc('enqueue');
  assert.equal(selectedIntake?.external_id, laterIntake.id, 'oldest inaccessible request must not starve later eligible intake');
  const intakeClaim = await rpc('claim', selectedIntake.id);
  await rpc('finish', selectedIntake.id, intakeClaim.lease, { state: 'review', result: { summary: 'Fixture completed' } });
  await rpc('apply_result', selectedIntake.id, null, { outcome: { kind: 'review', reason: 'Fixture completed' } });

  const unsupportedOldest = await submit({ system_type: 'multi-head' });
  await owner("update calculator_model_request_jobs set available_at=now()-interval '20 days' where request_id=$1", [unsupportedOldest.id]);
  const laterVerification = await saved();
  await as();
  assert.equal((await rpc('enqueue'))?.id, laterVerification.job.id, 'unsupported oldest request must not starve a saved verification continuation');
  await rpc('apply_result', laterVerification.job.id, null, { outcome: { kind: 'review', reason: 'Fixture completed' } });

  const leasedLegacy = await submit();
  await owner("update calculator_model_request_jobs set available_at=now()-interval '10 days',lease_token=gen_random_uuid(),lease_until=now()+interval '6 minutes' where request_id=$1", [leasedLegacy.id]);
  const activeResearch = await queued(); const activeClaim = await rpc('claim', activeResearch.job.id);
  await owner("update calculator_model_request_jobs set available_at=now()-interval '5 days' where request_id=$1", [activeResearch.request.id]);
  const activeContact = await submit();
  await owner("update calculator_model_request_jobs set available_at=now()-interval '3 days' where request_id=$1", [activeContact.id]);
  await owner(`insert into model_automation_private.mail_outbox(mail_key,request_id,kind,recipient,payload,state,lease,lease_until,started_at,attempts)
    values($1,$2,'escalation','admin@example.invalid','{}','sending',gen_random_uuid(),now()+interval '2 minutes',now(),1)`, [`starvation/${activeContact.id}`, activeContact.id]);
  const laterYield = await queued(); const yieldClaim = await rpc('claim', laterYield.job.id);
  await rpc('checkpoint', laterYield.job.id, yieldClaim.lease, cp(0)); await rpc('yield', laterYield.job.id, yieldClaim.lease);
  await owner("update calculator_model_request_jobs set available_at=now()-interval '1 day' where request_id=$1", [laterYield.request.id]);
  const skippedIds = [inaccessibleOldest.id, unsupportedOldest.id, leasedLegacy.id, activeResearch.request.id, activeContact.id];
  const skippedRows = async () => ({
    requests: (await q('select to_jsonb(r) as r from calculator_model_requests r where id=any($1::uuid[]) order by id', [skippedIds])).rows,
    jobs: (await q('select to_jsonb(j) as j from calculator_model_request_jobs j where request_id=any($1::uuid[]) order by request_id', [skippedIds])).rows,
    research: (await q('select to_jsonb(j) as j from model_automation_private.research_jobs j where external_id=any($1::uuid[]) order by id', [skippedIds])).rows,
    outbox: (await q('select to_jsonb(m) as m from model_automation_private.mail_outbox m where request_id=any($1::uuid[]) order by mail_key', [skippedIds])).rows,
  });
  const beforeSkipping = await skippedRows();
  await as();
  assert.equal((await rpc('enqueue'))?.id, laterYield.job.id, 'active legacy/research leases and sends must not starve a later yielded continuation');
  await owner('select 1'); assert.deepEqual(await skippedRows(), beforeSkipping, 'skipping must not modify inaccessible, unsupported or active requests/jobs/mail');
  await as(); assert.equal((await rpc('get', activeResearch.job.id)).lease, activeClaim.lease);
  const selectedYield = await rpc('claim', laterYield.job.id);
  await rpc('finish', laterYield.job.id, selectedYield.lease, { state: 'review', result: { summary: 'Fixture completed' } });
  await rpc('apply_result', laterYield.job.id, null, { outcome: { kind: 'review', reason: 'Fixture completed' } });
  pass('enqueue skips inaccessible/unsupported oldest rows, active leases and sends without starving valid intake or continuations');

  const a = await queued(), b = await queued();
  const aa = await rpc('claim', a.job.id), bb = await rpc('claim', b.job.id);
  await rpc('checkpoint', a.job.id, aa.lease, cp(0)); await rpc('checkpoint', b.job.id, bb.lease, cp(0));
  const reservations = await Promise.allSettled([
    rpc('reserve', a.job.id, aa.lease, { micros: reservation, limit: 20000000 }),
    rpc('reserve', b.job.id, bb.lease, { micros: reservation, limit: 20000000 }),
  ]);
  assert.equal(reservations.filter(r => r.status === 'fulfilled').length, 1);
  let budget = await rpc('budget');
  assert.equal(budget.charged, 1063705); assert.equal(budget.reserved, reservation);
  assert.ok(budget.charged + budget.reserved <= 20000000);
  const cost = reservations[0].value;
  await rpc('checkpoint', a.job.id, aa.lease, cp(0)); // Exact pre-send renewal is allowed.
  await assert.rejects(() => rpc('checkpoint', a.job.id, aa.lease, cp(1)), /Checkpoint/);
  await assert.rejects(() => rpc('reserve', a.job.id, aa.lease, { micros: reservation, limit: 20000000 }), /checkpoint or reconciliation/);
  await assert.rejects(() => rpc('reserve', b.job.id, bb.lease, { micros: 1, limit: 20000000 }), /budget/);
  await assert.rejects(() => rpc('reserve', b.job.id, bb.lease, { micros: reservation, limit: 20000001 }), /budget/);
  assert.equal(await rpc('settle', cost, null, { charge: 12345, provider_id: 'provider-budget' }), true);
  assert.equal(await rpc('settle', cost, null, { charge: 12345, provider_id: 'provider-budget' }), true);
  await rpc('checkpoint', a.job.id, aa.lease, cp(1));
  await rpc('yield', a.job.id, aa.lease);
  budget = await rpc('budget'); assert.equal(budget.charged, 1063705 + 12345); assert.equal(budget.reserved, 0);
  const blocked = await rpc('reserve', b.job.id, bb.lease, { micros: reservation, limit: 20000000 });
  assert.equal(await rpc('settle', blocked, null, { charge: reservation + 1, provider_id: 'provider-overrun' }), false);
  assert.equal((await rpc('budget')).reserved, reservation);
  await rpc('rejected', blocked); assert.equal((await rpc('budget')).reserved, reservation, 'uncertain money cannot be silently released');
  await owner("update model_automation_private.research_jobs set lease_until=now()-interval '1 second' where id=$1", [b.job.id]);
  await as(); assert.equal(await rpc('claim', b.job.id), null);
  assert.equal((await rpc('get', b.job.id)).state, 'review');
  await assert.rejects(() => rpc('enqueue', b.request.id, null, { retry: true }), /reconciliation/);
  pass('serialized Sydney-month budget, hard cap/FX floor, one reservation per lease and retained uncertain spend');

  // Isolated fixture cleanup of a deliberately uncertain reservation is not an RPC.
  await owner('update model_automation_private.research_budget set reserved_micros=reserved_micros-(select reserved from model_automation_private.research_costs where id=$1) where month=(select month from model_automation_private.research_costs where id=$1)', [blocked]);
  await owner("update model_automation_private.research_costs set state='rejected' where id=$1", [blocked]);
  await as();
  const missing = await queued(); const mm = await rpc('claim', missing.job.id);
  await rpc('checkpoint', missing.job.id, mm.lease, cp(0));
  const mc = await rpc('reserve', missing.job.id, mm.lease, { micros: reservation, limit: 20000000 });
  await rpc('settle', mc, null, { charge: 2, provider_id: 'provider-before-checkpoint' });
  await owner("update model_automation_private.research_jobs set lease_until=now()-interval '1 second' where id=$1", [missing.job.id]);
  await as(); assert.equal(await rpc('claim', missing.job.id), null); assert.equal((await rpc('get', missing.job.id)).state, 'review');
  const clean = await queued(); const cc = await rpc('claim', clean.job.id); await rpc('checkpoint', clean.job.id, cc.lease, cp(0));
  await owner("update model_automation_private.research_jobs set lease_until=now()-interval '1 second' where id=$1", [clean.job.id]);
  await as(); const resumed = await rpc('claim', clean.job.id); assert.ok(resumed); assert.notEqual(resumed.lease, cc.lease);
  await rpc('finish', clean.job.id, resumed.lease, { state: 'budget_paused', result: { summary: 'Budget exhausted' } });
  await rpc('apply_result', clean.job.id, null, { outcome: { kind: 'review', reason: 'Budget exhausted' } });
  pass('expired clean leases resume; settled calls beyond checkpoint stop; budget pauses reach admin review');

  const pricing = await queued(); const pc = await rpc('claim', pricing.job.id); await rpc('checkpoint', pricing.job.id, pc.lease, cp(0));
  await owner('select 1');
  const definition = (await one("select pg_get_functiondef('model_automation_private.research_worker(text,text,uuid,uuid,jsonb)'::regprocedure) as d")).d;
  assert.ok(definition.includes("date '2026-12-09'"));
  await db.exec(definition.replace("date '2026-12-09'", "date '2000-01-01'"));
  await as();
  await assert.rejects(() => rpc('reserve', pricing.job.id, pc.lease, { micros: reservation, limit: 20000000 }), /pricing needs review/);
  await owner('select 1'); await db.exec(definition);
  const monthChecks = await one(`select to_char(date_trunc('month',timestamptz '2026-10-31 14:00:00+00' at time zone 'Australia/Sydney'),'YYYY-MM') as month,
    date '2026-12-10'>date '2026-12-09' as expired`);
  assert.deepEqual(monthChecks, { month: '2026-11', expired: true });
  pass('server-side pricing expiry and Sydney month boundary');

  await as();
  const published = await saved();
  const good = outcome('ready_to_add');
  const zeroPublication = outcome('ready_to_add'); zeroPublication.evidence.verification.certificates = { esc: 0, prc: 0 };
  await assert.rejects(() => rpc('apply_result', published.job.id, null, { outcome: zeroPublication }), /Positive deterministic certificates/);
  const wrongVerifierKind = outcome('ready_to_add'); wrongVerifierKind.evidence.verification.kind = 'review';
  await assert.rejects(() => rpc('apply_result', published.job.id, null, { outcome: wrongVerifierKind }), /Positive deterministic certificates/);
  const stringCertificates = outcome('ready_to_add'); stringCertificates.evidence.verification.certificates.esc = '1.5';
  await assert.rejects(() => rpc('apply_result', published.job.id, null, { outcome: stringCertificates }), /Positive deterministic certificates/);
  assert.equal((await rpc('apply_result', published.job.id, null, { outcome: good })).state, 'added');
  assert.equal((await rpc('get', published.job.id)).applied_at !== null, true);
  assert.equal((await rpc('apply_result', published.job.id, null, { outcome: good })).already_applied, true);
  const refreshedEvidence = structuredClone(good); refreshedEvidence.evidence.verification.verifiedAt = '2026-11-09T03:00:01Z';
  assert.equal((await rpc('apply_result', published.job.id, null, { outcome: refreshedEvidence })).already_applied, true);
  await assert.rejects(() => rpc('apply_result', published.job.id, null, { outcome: outcome() }), /different research outcome/);
  const confirmation = await rpc('confirmation_claim', published.request.id);
  assert.equal(confirmation.job.state, 'added');
  assert.equal(await rpc('confirmation_claim', a.request.id), null, 'confirmation never consumes queued research');
  await q('select public.model_request_worker($1,\'email_start\',$2,$3)', [secret, published.request.id, confirmation.job.lease_token]);
  await q('select public.model_request_worker($1,\'email_sent\',$2,$3,$4)', [secret, published.request.id, confirmation.job.lease_token, JSON.stringify({ id: 'confirmed-added' })]);
  assert.equal(await rpc('confirmation_claim', published.request.id), null);
  pass('legacy verified publication and immediate added-only confirmation claim remain authoritative/idempotent');

  const staleConfirmation = await saved();
  await rpc('apply_result', staleConfirmation.job.id, null, { outcome: good });
  await owner("update calculator_model_requests set notes='Changed after publication' where id=$1", [staleConfirmation.request.id]);
  await as(); assert.equal(await rpc('confirmation_claim', staleConfirmation.request.id), null);
  await owner('select 1'); assert.equal((await one('select email_state from calculator_model_request_jobs where request_id=$1', [staleConfirmation.request.id])).email_state, 'failed');
  await as();
  const staleSend = await saved(); await rpc('apply_result', staleSend.job.id, null, { outcome: good });
  const staleClaim = await rpc('confirmation_claim', staleSend.request.id);
  await owner("update calculator_model_requests set notes='Changed after confirmation claim' where id=$1", [staleSend.request.id]);
  await as();
  await assert.rejects(() => q("select public.model_request_worker($1,'email_start',$2,$3)", [secret, staleSend.request.id, staleClaim.job.lease_token]), /confirmation held for review/);
  await as('authenticated');
  const heldSelf = (await one('select public.model_request_self($1) as r', [staleSend.request.id])).r;
  assert.equal(heldSelf.state, 'review'); assert.ok(!('outcome' in heldSelf)); assert.equal(heldSelf.product, null);
  await as();
  pass('research-backed added confirmations recheck versions at both claim and original send-start RPC');

  const noRebate = await saved();
  const invalid = outcome(); invalid.evidence.verification.registry.registrationNumber = 'WRONG';
  await assert.rejects(() => rpc('apply_result', noRebate.job.id, null, { outcome: invalid }), /exact researched registration/);
  const missingKind = outcome(); delete missingKind.evidence.verification.kind;
  await assert.rejects(() => rpc('apply_result', noRebate.job.id, null, { outcome: missingKind }), /deterministic no_rebate/);
  const negative = outcome(); negative.evidence.verification.certificates.esc = -1;
  await assert.rejects(() => rpc('apply_result', noRebate.job.id, null, { outcome: negative }), /deterministic no_rebate/);
  assert.equal((await rpc('apply_result', noRebate.job.id, null, { outcome: outcome() })).state, 'no_rebate');
  assert.equal((await rpc('apply_result', noRebate.job.id, null, { outcome: outcome() })).already_applied, true);
  await as('authenticated', admin, 'admin@example.invalid');
  assert.deepEqual((await one("select public.admin_model_request_list('added','',0) as r")).r.requests.find(r => r.id === noRebate.request.id).job.outcome_email,
    { state: 'pending', sent_at: null });
  await as();
  let mail = await contact('claim', noRebate.request.id);
  assert.equal(mail.kind, 'no_rebate');
  assert.deepEqual(mail.payload, { brand: product.brand, model: product.model, registration: canonical.registrationNumber, postcode: '2145', install_type: 'new' });
  assert.equal(await contact('claim', noRebate.request.id), null);
  await assert.rejects(() => contact('sent', noRebate.request.id, randomUUID(), { key: mail.mail_key, provider_id: 'invalid' }), /lease expired/);
  await contact('retry', noRebate.request.id, mail.lease, { key: mail.mail_key });
  await owner('update model_automation_private.mail_outbox set available_at=now() where mail_key=$1', [mail.mail_key]);
  await as(); const retryMail = await contact('claim', noRebate.request.id); assert.equal(retryMail.mail_key, mail.mail_key);
  await contact('sent', noRebate.request.id, retryMail.lease, { key: mail.mail_key, provider_id: 'confirmed-no-rebate' });
  assert.equal(await contact('claim', noRebate.request.id), null);
  await as('authenticated');
  const finalSelf = (await one('select public.model_request_self($1) as r', [noRebate.request.id])).r;
  assert.equal(finalSelf.outcome, 'no_rebate'); assert.equal(finalSelf.no_rebate, true);
  assert.equal(finalSelf.matchedModel, 'Fixture OUT / IN (3.5 kW, Single phase)');
  assert.equal(finalSelf.brand, noRebate.request.brand); assert.equal(finalSelf.model, noRebate.request.model);
  assert.match(finalSelf.summary, /verified calculation returned no ESC or PRC/);
  assert.ok(!('evidence' in finalSelf)); assert.ok(!('checkpoint' in finalSelf));
  await as('authenticated', admin, 'admin@example.invalid');
  assert.equal((await one('select public.model_request_self($1) as r', [noRebate.request.id])).r, null);
  await as();
  pass('no_rebate requires exact deterministic registration and zero proof; existing outbox leases/keys prevent duplicate notifications');

  const stale = await saved();
  await owner("update calculator_model_requests set notes='A genuinely new message' where id=$1", [stale.request.id]);
  await as();
  assert.equal((await rpc('apply_result', stale.job.id, null, { outcome: outcome() })).state, 'superseded');
  const inaccessible = await saved();
  await owner("update auth.users set email='changed@example.invalid' where id=$1", [user]);
  await as(); assert.equal(await rpc('current', inaccessible.request.id), null);
  assert.equal((await rpc('apply_result', inaccessible.job.id, null, { outcome: outcome() })).state, 'review');
  await owner("update auth.users set email='user@example.invalid' where id=$1", [user]);
  await as();
  const held = await saved(); await rpc('apply_result', held.job.id, null, { outcome: outcome() });
  await owner("update calculator_model_requests set notes='Changed before contact claim' where id=$1", [held.request.id]);
  await as(); assert.equal((await contact('claim', held.request.id)).state, 'failed');
  pass('new details, identity/access changes and stale contact versions prevent obsolete publication or mail');

  const verificationRetry = await saved();
  await rpc('apply_result', verificationRetry.job.id, null, { outcome: { kind: 'review', reason: 'Service unavailable', evidence: { temporaryVerificationFailure: true } } });
  await as('authenticated', admin, 'admin@example.invalid');
  await q("select public.admin_model_request_action($1,'retry')", [verificationRetry.request.id]);
  await as();
  const retryCandidate = await rpc('enqueue', verificationRetry.request.id);
  assert.equal(retryCandidate.id, verificationRetry.job.id); assert.equal(retryCandidate.state, 'pending_verification');
  assert.equal(retryCandidate.applied_at, null); assert.deepEqual(retryCandidate.result, finding);
  assert.equal(await rpc('claim', retryCandidate.id), null, 'a reused candidate cannot incur another paid provider call');
  pass('authorized retry after a deterministic outage preserves the candidate and never restarts paid research');

  const detail = await saved('waiting_for_details', { outcome: 'needs_details', question: 'Which exact unit code?', summary: 'Need label code' }, { notes: 'Keep this original note.' });
  await rpc('apply_result', detail.job.id, null, { outcome: { kind: 'needs_details', question: 'Which exact unit code?' } });
  mail = await contact('claim', detail.request.id); assert.equal(mail.kind, 'question');
  await as('authenticated');
  await assert.rejects(() => q('select public.model_request_self($1,$2)', [detail.request.id, JSON.stringify({ round: 1, message: 'OUT / IN on the label' })]), /notification is sending/);
  await as(); await contact('sent', detail.request.id, mail.lease, { key: mail.mail_key, provider_id: 'question-one' });
  await as('authenticated');
  const self = (await one('select public.model_request_self($1) as r', [detail.request.id])).r;
  const response = (await one('select public.model_request_self($1,$2) as r', [detail.request.id, JSON.stringify({ round: self.round, version: self.version, message: 'The label says OUT / IN, suffix unchanged.' })])).r;
  assert.equal(response.state, 'queued'); assert.equal(response.version, self.version + 1);
  await assert.rejects(() => q('select public.model_request_self($1,$2)', [detail.request.id, JSON.stringify({ round: self.round, version: self.version, message: 'Duplicate stale reply' })]), /no longer awaiting/);
  await as(); const detail2 = await rpc('enqueue', detail.request.id);
  assert.equal(detail2.request.round, 2); assert.equal(detail2.request.model, detail.request.model);
  assert.equal(detail2.request.notes, 'Keep this original note.');
  assert.deepEqual(detail2.request.messages, ['The label says OUT / IN, suffix unchanged.']);
  await owner('select 1');
  assert.equal((await one('select original->>\'notes\' as note from model_automation_private.research_requests where request_id=$1', [detail.request.id])).note, 'Keep this original note.');
  await assert.rejects(() => q("update model_automation_private.research_rounds set request='{}' where external_id=$1", [detail.request.id]), /immutable/);
  const reminders = (await q("select * from model_automation_private.mail_outbox where request_id=$1 and kind='reminder' order by available_at", [detail.request.id])).rows;
  assert.equal(reminders.length, 2); assert.ok(reminders[0].mail_key.startsWith('reminder-2/')); assert.ok(reminders[1].mail_key.startsWith('reminder-5/'));
  assert.ok(reminders.every(m => m.state === 'cancelled'));
  assert.ok(reminders.every(m => m.research_version === 1));
  pass('message-only replies are versioned and fed into snapshots; original text, immutable rounds and old reminder fences survive');

  await as();
  const help = await saved('waiting_for_details', { outcome: 'needs_details', question: 'Confirm details', summary: 'Need details' });
  await rpc('apply_result', help.job.id, null, { outcome: { kind: 'needs_details', question: 'Confirm details' } });
  await as('authenticated');
  assert.equal((await one('select public.model_request_self($1,$2) as r', [help.request.id, JSON.stringify({ round: 1, message: 'This is frustrating. Please get a human.' })])).r.state, 'escalated');
  await as(); const escalation = await contact('claim', help.request.id); assert.equal(escalation.kind, 'escalation');
  await contact('sent', help.request.id, escalation.lease, { key: escalation.mail_key, provider_id: 'escalation-one' });
  await contact('maintain');
  await owner('select 1');
  assert.equal((await one("select count(*)::int as n from model_automation_private.mail_outbox where request_id=$1 and kind='escalation'", [help.request.id])).n, 1);
  const capped = await saved('waiting_for_details', { outcome: 'needs_details', question: 'Fourth question?', summary: 'Still unresolved' });
  await owner('update calculator_model_request_jobs set contact_round=3 where request_id=$1', [capped.request.id]);
  await as(); await rpc('apply_result', capped.job.id, null, { outcome: { kind: 'needs_details', question: 'Fourth question?' } });
  await owner('select 1');
  assert.equal((await one('select contact_round from calculator_model_request_jobs where request_id=$1', [capped.request.id])).contact_round, 3);
  assert.equal((await one("select count(*)::int as n from model_automation_private.mail_outbox where request_id=$1 and kind='question'", [capped.request.id])).n, 0);
  await as();
  const closing = await saved('waiting_for_details', { outcome: 'needs_details', question: 'Confirm details', summary: 'Need details' });
  await rpc('apply_result', closing.job.id, null, { outcome: { kind: 'needs_details', question: 'Confirm details' } });
  const closingMail = await contact('claim', closing.request.id);
  await contact('sent', closing.request.id, closingMail.lease, { key: closingMail.mail_key, provider_id: 'closing-question' });
  await owner("update model_automation_private.mail_outbox set sent_at=now()-interval '20 days' where mail_key=$1", [closingMail.mail_key]);
  await as(); await contact('maintain');
  await as('authenticated'); assert.equal((await one('select public.model_request_self($1) as r', [closing.request.id])).r.state, 'closed');
  await as(); assert.equal(await rpc('enqueue', closing.request.id), null); assert.equal(await rpc('enqueue', closing.request.id, null, { retry: true }), null);
  pass('human-help escalation remains immediate, old summary scheduler is retained, and clarification stays capped at three rounds');

  await as('authenticated', admin, 'admin@example.invalid');
  const listing = (await one("select public.admin_model_request_list('all','',0) as r")).r;
  const listed = listing.requests.find(r => r.id === noRebate.request.id);
  assert.equal(listed.job.state, 'no_rebate'); assert.equal(listed.job.research.id, noRebate.job.id);
  assert.equal(listed.job.outcome_email.state, 'sent'); assert.ok(listed.job.outcome_email.sent_at);
  assert.deepEqual(Object.keys(listed.job.outcome_email).sort(), ['sent_at', 'state']);
  assert.deepEqual(Object.keys(listed.job.research).sort(), ['events', 'id', 'result', 'round', 'state', 'updated_at']);
  assert.deepEqual(Object.keys(listed.job.research.result).sort(), ['canonical', 'question', 'sourceUrls', 'summary']);
  assert.ok(!('lease_token' in listed.job)); assert.ok(!('lease_until' in listed.job));
  assert.ok(!JSON.stringify(listing).includes('checkpoint')); assert.ok(!JSON.stringify(listing).includes(secret));
  assert.deepEqual(Object.keys(listing.researchBudget).sort(), ['limitMicros', 'month', 'pricingReviewBy', 'reservedMicros', 'spentMicros']);
  assert.ok((await one("select public.admin_model_request_list('no_rebate','',0) as r")).r.requests.some(r => r.id === noRebate.request.id));
  assert.ok((await one("select public.admin_model_request_list('researching','',0) as r")).r.requests.some(r => r.id === a.request.id));
  pass('admin compact research/results/events and budget shapes contain no checkpoint, lease or key material');

  await owner(`insert into model_automation_private.mail_outbox(mail_key,kind,recipient,payload)
    values('weekly/'||to_char(date_trunc('week',now() at time zone 'Australia/Sydney'),'YYYY-MM-DD'),'weekly','admin@example.invalid','{}') on conflict do nothing`);
  await owner("update model_automation_private.research_jobs set applied_at=(date_trunc('week',now() at time zone 'Australia/Sydney')-interval '3 days') at time zone 'Australia/Sydney' where id=$1", [noRebate.job.id]);
  await as();
  await saved('budget_paused', { summary: 'Monthly research budget cannot cover another bounded API call' });
  await contact('maintain');
  await owner('select 1');
  const weekly = await one("select * from model_automation_private.mail_outbox where kind='weekly' order by available_at desc limit 1");
  assert.equal(weekly.payload.no_rebate, 1); assert.ok(weekly.payload.research_paused >= 1);
  assert.equal(weekly.payload.researchBudget.limitMicros, 20000000);
  assert.ok(!('reserved' in weekly.payload.researchBudget));
  const weeklyBody = weekly.payload;
  for (const state of ['sending', 'pending', 'sent']) {
    await owner('update model_automation_private.mail_outbox set state=$2,started_at=now(),attempts=1 where mail_key=$1', [weekly.mail_key, state]);
    await as(); await contact('maintain'); await owner('select 1');
    assert.deepEqual((await one('select payload from model_automation_private.mail_outbox where mail_key=$1', [weekly.mail_key])).payload, weeklyBody);
  }
  pass('weekly-only summary adds no-rebate/budget/paused counts only before any possible provider acceptance');

  await as();
  const importTarget = await queued();
  await assert.rejects(() => rpc('import_checkpoint', importTarget.job.id, null, { source_job_id: randomUUID(), source_request_text: '{}', result_text: '{}' }), /artifact does not match/);
  await assert.rejects(() => rpc('import_checkpoint', importTarget.job.id, null, { source_job_id: 'bba2e013-2073-4453-9379-81a20ce7030c', source_request_text: '{}', result_text: '{}' }), /artifact does not match/);
  pass('unrecognized or altered prepaid imports are refused, without any paid calls');

  // Exercise the actual pinned local artifacts when the approved read-only source
  // checkout is present. No artifact is copied into the repository or sent online.
  const sourceDb = new URL('../../model-request-agent/.state/agent.sqlite', import.meta.url);
  if (existsSync(sourceDb)) {
    const { DatabaseSync } = await import('node:sqlite');
    const source = new DatabaseSync(sourceDb, { readOnly: true });
    try {
      const artifacts = source.prepare('select id,request,result from jobs where state=\'pending_verification\'').all();
      const pins = {
        'bba2e013-2073-4453-9379-81a20ce7030c': { id: '6fd1afa2-85f0-4615-8ec9-bd45eb2ba28e', notes: 'Mitsubishi Ciara Range' },
        '2f076bd0-127f-4511-9cc1-15cd203d0279': { id: '12fadd7c-887c-4398-89bc-879fc0999b43', notes: 'Mitsubishi Ciara' },
        '9ac354f8-473a-4853-ba91-a9193d9a5085': { id: '4c8410a4-83c9-4488-8d55-4685eb263f8a', notes: 'UCMI200OC-3PH/DUCMI200IHC-3PH Midea Quantum' },
      };
      for (const artifact of artifacts) {
        const local = JSON.parse(artifact.request);
        const pin = pins[artifact.id]; assert.ok(pin);
        const target = await submit({ ...local, ...pin });
        await owner('update model_automation_private.research_requests set messages=$2 where request_id=$1', [target.id, JSON.stringify(local.messages)]);
        await owner("update calculator_model_request_jobs set state='review',contact_state='escalated' where request_id=$1", [target.id]);
        await as();
        const data = { source_job_id: artifact.id, source_request_text: artifact.request, result_text: artifact.result };
        await assert.rejects(() => rpc('restore_prepaid', target.id, null, { ...data, result_text: '{}' }), /artifact does not match/);
        await owner('select 1');
        assert.deepEqual(await one('select state,contact_state from calculator_model_request_jobs where request_id=$1', [target.id]), { state: 'review', contact_state: 'escalated' });
        assert.equal((await one('select count(*)::int as n from model_automation_private.research_jobs where external_id=$1', [target.id])).n, 0);
        assert.equal((await one('select notes from calculator_model_requests where id=$1', [target.id])).notes, pin.notes);
        await as();
        const imported = await rpc('restore_prepaid', target.id, null, data);
        assert.equal(imported.state, 'pending_verification'); assert.equal(imported.result.outcome, 'candidate');
        assert.equal(imported.request.notes, pin.notes); assert.deepEqual(imported.request.messages, local.messages);
        await assert.rejects(() => rpc('import_checkpoint', imported.id, null, data), /artifact does not match/);
      }
      assert.equal(artifacts.length, 3); pass('atomic prepaid restoration pins exact target UUID/notes, preserves messages, and rolls back failed imports');
    } finally { source.close(); }
  } else console.log('note: pinned import success checks skipped; approved local source database is absent');

  await owner('select 1');
  const chargedBeforeDelete = Number((await one('select coalesce(sum(charged),0) as n from model_automation_private.research_costs')).n);
  await q('delete from calculator_model_requests where id=$1', [a.request.id]);
  assert.equal(Number((await one('select coalesce(sum(charged),0) as n from model_automation_private.research_costs')).n), chargedBeforeDelete);
  pass('request deletion cannot erase spent financial ledger entries');

  // Test the real adapter with a local injected RPC stub, without loading app env.
  const ts = await import('typescript');
  const adapterSource = await readFile(new URL('../lib/model-research/store.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(adapterSource.replace('import { catalogueClient } from "../model-catalogue";', 'const catalogueClient = () => { throw new Error("No network in adapter tests"); };'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { PostgresResearchStore } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  const calls = [];
  const store = new PostgresResearchStore(secret, { async rpc(name, args) { calls.push({ name, args }); return { data: args.p_action === 'reserve' ? 'cost-id' : null, error: null }; } });
  assert.ok(store.now() instanceof Date); assert.equal(await store.reserve('job', 'lease', reservation, 20000000), 'cost-id');
  await store.current('request'); await store.apply('job', { kind: 'review' }); await store.confirmationClaim('request'); await store.yield('job', 'lease');
  assert.deepEqual(calls.map(c => c.args.p_action), ['reserve', 'current', 'apply_result', 'confirmation_claim', 'yield']);
  assert.ok(calls.every(c => c.name === 'model_request_research_worker' && c.args.p_secret === secret));
  assert.deepEqual(calls[2].args.p_data, { outcome: { kind: 'review' } });
  const failed = new PostgresResearchStore(secret, { async rpc() { return { error: { code: 'P0001', message: `Monthly research budget cannot cover another bounded API call ${secret}` } }; } });
  await assert.rejects(() => failed.reserve('job', 'lease', reservation, 20000000), e => /budget/.test(e.message) && !e.message.includes(secret));
  pass('async adapter dispatch, synchronous now(), raw RPC contract and sanitized budget errors');

  // Run the production async core against PostgreSQL and the real RPC adapter.
  // Provider and registry are in-process fixtures; no paid/network requests exist.
  const { ResearchAgent } = await import('../lib/model-research/agent.mjs');
  const { configuration } = await import('../lib/model-research/config.mjs');
  const liveAdapter = new PostgresResearchStore(secret, { async rpc(_name, args) {
    try { return { data: await rpc(args.p_action, args.p_id, args.p_lease, args.p_data), error: null }; }
    catch (error) { return { data: null, error: { code: error.code, message: error.message } }; }
  } }, () => new Date('2026-11-09T03:00:00Z'));
  const integrated = await queued();
  let providerCalls = 0;
  const provider = { async respond() {
    providerCalls++;
    return { id: `fixture-core-${providerCalls}`, model: 'gpt-6.1-sol', status: 'completed', usage: { input_tokens: 1000, output_tokens: 100 },
      output: providerCalls === 1
        ? [{ type: 'function_call', name: 'search_registry', call_id: 'registry-1', arguments: '{"code":"OUT"}' }]
        : [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ outcome: 'review', summary: 'An exact label is required', sourceUrls: ['https://data.gov.au/fixture'] }) }] }] };
  } };
  const registry = { async search() { return { sourceUrl: 'https://data.gov.au/fixture', records: [], truncated: false }; } };
  const agent = new ResearchAgent({ store: liveAdapter, provider, registry, config: configuration({}), clock: () => 0, maxDurationMs: 180000 });
  assert.equal((await agent.run(integrated.job.id)).state, 'queued'); assert.equal(providerCalls, 1);
  assert.equal((await liveAdapter.get(integrated.job.id)).checkpoint.round, 1);
  assert.equal((await agent.run(integrated.job.id)).state, 'review'); assert.equal(providerCalls, 2);
  assert.equal((await liveAdapter.get(integrated.job.id)).checkpoint.round, 2);
  await liveAdapter.apply(integrated.job.id, { kind: 'review', reason: 'An exact label is required' });
  pass('production async core runs one mocked provider round per invocation through the PostgreSQL adapter');
  await owner('select 1');
  const ledger = await one(`select b.spent_micros::int as spent,b.reserved_micros::int as reserved,
    coalesce((select sum(charged) from model_automation_private.research_costs c where c.month=b.month),0)::int as audit_spent,
    coalesce((select sum(reserved) from model_automation_private.research_costs c where c.month=b.month and state in ('pending','uncertain')),0)::int as audit_reserved
    from model_automation_private.research_budget b where month='2026-11-01'`);
  assert.equal(ledger.spent, ledger.audit_spent); assert.equal(ledger.reserved, ledger.audit_reserved);
  pass('atomic monthly counters reconcile exactly to the durable cost audit ledger');
  console.log(`Isolated PostgreSQL research checks passed (${checks} groups). PGlite executes PostgreSQL statements serially; true multi-session contention still needs staging verification.`);
} catch (error) {
  console.error(error.message, error.where || '');
  process.exitCode = 1;
} finally { await db.close(); }
