import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const candidates = [process.env.PGLITE_MODULE,
  fileURLToPath(new URL('../outputs/automation-test-deps/package/dist/index.js', import.meta.url)),
  fileURLToPath(new URL('../../calculator-commission-fix/outputs/automation-test-deps/package/dist/index.js', import.meta.url)),
].filter(Boolean);
const modulePath = candidates.find((path) => existsSync(path));
assert.ok(modulePath, 'Set PGLITE_MODULE to an existing local PGlite dist/index.js; this verifier never installs or downloads dependencies.');
const { PGlite } = await import(pathToFileURL(modulePath).href);
const db = new PGlite();
const sql = await readFile(new URL('../supabase/business_won_jobs_read.sql', import.meta.url), 'utf8');
const indexSql = await readFile(new URL('../supabase/business_won_jobs_index.sql', import.meta.url), 'utf8');
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = id(101), B = id(102), C = id(103);
const OWNER = id(1), OTHER_OWNER = id(2), SELLER = id(3), FORMER = id(4), ADMIN = id(5), PLATFORM_OWNER = id(6), MARKERS = id(7);
const stamp = '2026-11-01T03:04:05.000Z';
const q = (query, args = []) => db.query(query, args);
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
async function as(role = 'authenticated', uid = OWNER, email = 'owner@example.invalid') {
  assert.ok(['authenticated', 'anon'].includes(role));
  await db.exec('reset role');
  await q("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: uid, email })]);
  await db.exec(`set role ${role}`);
}
async function root() { await db.exec('reset role'); }
async function readRaw(business = A) {
  return (await q('select public.read_business_won_jobs($1) as result', [business])).rows[0].result;
}
async function read(business = A) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await readRaw(business);
    if (result.status !== 'refreshing') return result;
    assert.deepEqual(result, { status: 'refreshing', businessId: business, retryAfterMs: 1000 }, 'refresh responses contain no jobs or incomplete counts');
  }
  throw new Error('Manual retry required after 20 directory refresh requests');
}
async function profile(n, email, data) {
  await root();
  await q('insert into auth.users(id,email) values($1,$2) on conflict(id) do nothing', [id(n), email]);
  const tagged = data && typeof data === 'object' && !Array.isArray(data) ? { ...data, _fixtureProfileId: id(n) } : data;
  await q('insert into user_calculator_data(user_id,email,data) values($1,$2,$3) on conflict(user_id) do update set data=excluded.data,email=excluded.email,updated_at=clock_timestamp()', [id(n), email, JSON.stringify(tagged)]);
}
const row = (option, business = A, extras = {}) => ({
  optionId: option, optionName: option, wonAt: stamp, wonByEmail: 'seller@example.invalid', wonByName: 'Fictional Seller',
  installationAddress: '10 Fictional Street, Example NSW', proposedInstallationDate: '2026-12-03',
  googlePlaceId: 'fictional-place', brand: 'Fixture', model: 'OUT / IN', type: 'split', size: '3.5', install: 'replacement',
  finalInc: 12345.67, rebate: 1250.25, netProfit: 987.65,
  state: { businessId: business, hiddenCommission: 99, privateNotes: 'NEVER_RETURN_STATE' },
  privateProfile: 'NEVER_RETURN_PROFILE', ...extras,
});
const data = (rows, extras = {}) => ({ installerMasterQuoteLogV1: JSON.stringify(rows), installerQuoteOptionDefsV1: '[]', ...extras });
const saved = (rows, extras = {}) => ({ id: 'fixture-set', name: 'Saved fixture', savedAt: stamp, optionDefs: [], quotes: rows, ...extras });
const marker = (option, extras = {}) => ({ dataUserId: SELLER, dataOwnerEmail: 'seller@example.invalid', userEmail: 'seller@example.invalid', optionId: option, wonAt: stamp, ...extras });
async function rejected(action, pattern, label) { await assert.rejects(action, pattern, label); checks++; }
async function checksum() {
  await root();
  return (await q("select user_id,email,updated_at::text,md5(data::text) as checksum from user_calculator_data order by user_id")).rows;
}
async function quoteStructure() {
  await root();
  return (await q(`select jsonb_build_object(
    'indexes',(select jsonb_agg(pg_get_indexdef(indexrelid) order by indexrelid) from pg_index where indrelid='public.user_calculator_data'::regclass),
    'triggers',(select jsonb_agg(pg_get_triggerdef(oid) order by oid) from pg_trigger where tgrelid='public.user_calculator_data'::regclass),
    'constraints',(select jsonb_agg(pg_get_constraintdef(oid) order by oid) from pg_constraint where conrelid='public.user_calculator_data'::regclass),
    'policies',(select jsonb_agg(to_jsonb(p) order by policyname) from pg_policies p where schemaname='public' and tablename='user_calculator_data'),
    'acl',(select relacl::text from pg_class where oid='public.user_calculator_data'::regclass),
    'rls',(select relrowsecurity from pg_class where oid='public.user_calculator_data'::regclass)
  ) as structure`)).rows[0].structure;
}
async function instrumentParsers() {
  await root();
  await db.exec(`create table business_won_private.test_parser_calls(stage text,profile_id text);
    create table business_won_private.test_read_hook(user_id uuid,next_data jsonb,armed boolean);`);
  for (const [signature, functionName, args, result, body] of [
    ['source_keys_v1(jsonb,uuid,text)', 'source_keys_v1', 'p_data jsonb,p_user_id uuid,p_email text', 'text[]',
      "insert into business_won_private.test_parser_calls values('keys',p_user_id::text); return business_won_private.test_impl_source_keys_v1(p_data,p_user_id,p_email);"],
    ['stored_array_v1(jsonb,text[])', 'stored_array_v1', 'p_data jsonb,p_keys text[]', 'jsonb',
      `insert into business_won_private.test_parser_calls values('stored',p_data->>'_fixtureProfileId');
       update public.user_calculator_data s set data=h.next_data,updated_at=clock_timestamp()
         from business_won_private.test_read_hook h where h.armed and s.user_id=h.user_id;
       update business_won_private.test_read_hook set armed=false where armed;
       return business_won_private.test_impl_stored_array_v1(p_data,p_keys);`],
    ['markers_v1(jsonb)', 'markers_v1', 'p_data jsonb', 'table(kind text,record jsonb,marker_position bigint)',
      "insert into business_won_private.test_parser_calls values('markers',p_data->>'_fixtureProfileId'); return query select * from business_won_private.test_impl_markers_v1(p_data);"],
  ]) {
    const definition = (await q('select pg_get_functiondef($1::regprocedure) as definition', [`business_won_private.${signature}`])).rows[0].definition;
    await db.exec(definition.replace(`business_won_private.${functionName}(`, `business_won_private.test_impl_${functionName}(`));
    await db.exec(`create or replace function business_won_private.${functionName}(${args}) returns ${result}
      language plpgsql volatile set search_path='' as $$ begin ${body} end; $$`);
  }
}
async function resetParserCalls() { await root(); await db.exec('truncate business_won_private.test_parser_calls'); }
async function parserCalls(stage = null, profileId = null) {
  await root();
  return Number((await q('select count(*) as n from business_won_private.test_parser_calls where ($1::text is null or stage=$1) and ($2::text is null or profile_id=$2)', [stage, profileId])).rows[0].n);
}

try {
  check(/create index if not exists/i.test(indexSql) && !/\bconcurrently\b/i.test(indexSql), 'normal GIN index applies only to the new private directory');
  check(!/^\s*(begin|start transaction|commit)\s*;/im.test(sql + indexSql), 'both files defer transaction ownership to the atomic migration runner');
  check(!/alter table\s+(?:public\.)?user_calculator_data|create\s+(?:unique\s+)?index[^;]*\bon\s+(?:public\.)?user_calculator_data|create\s+trigger|references\s+(?:public\.)?user_calculator_data|service_role|https?:/i.test(sql + indexSql), 'no original-table schema/write hooks, FK or service/network access');
  await db.exec(`
    create role anon; create role authenticated; create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select nullif(current_setting('request.jwt.claims',true),'')::jsonb $$;
    grant usage on schema auth to anon,authenticated;
    grant execute on all functions in schema auth to anon,authenticated;
    create table auth.users(id uuid primary key,email text);
    create table public.businesses(id uuid primary key,name text);
    create table public.approved_users(email text unique not null,display_name text,role text,business_id uuid,is_locked boolean default false);
    create table public.approved_user_businesses(email text,business_id uuid,primary key(email,business_id));
    create table public.user_calculator_data(user_id uuid primary key references auth.users(id) on delete cascade,
      email text,data jsonb not null default '{}',updated_at timestamptz not null default now());
    create unique index user_calculator_data_email_unique on public.user_calculator_data(lower(email)) where email is not null;
    alter table public.user_calculator_data enable row level security;
    create policy self_read on public.user_calculator_data for select to authenticated using(auth.uid()=user_id);
    create policy self_update on public.user_calculator_data for update to authenticated using(auth.uid()=user_id) with check(auth.uid()=user_id);
    grant usage on schema public to anon,authenticated;
    create policy self_insert on public.user_calculator_data for insert to authenticated with check(auth.uid()=user_id);
    grant select,insert,update on public.user_calculator_data to authenticated;
  `);
  await q('insert into businesses values($1,$2),($3,$4),($5,$6)', [A, 'Fictional Business A', B, 'Fictional Business B', C, 'Unassigned business']);
  for (const [n, email, name, role, business] of [
    [1, 'owner@example.invalid', 'Owner A', 'business_owner', A],
    [2, 'other-owner@example.invalid', 'Owner B', 'business_owner', B],
    [3, 'seller@example.invalid', 'Fictional Seller', 'salesperson', A],
    [5, 'admin@example.invalid', 'Fixture Admin', 'admin', null],
    [6, 'danieldipalma88@gmail.com', 'Platform Owner', 'user', null],
  ]) {
    await q('insert into auth.users values($1,$2)', [id(n), email]);
    await q('insert into approved_users(email,display_name,role,business_id) values($1,$2,$3,$4)', [email, name, role, business]);
  }
  await q("insert into approved_user_businesses values('seller@example.invalid',$1),('seller@example.invalid',$2)", [A, B]);
  await profile(1, 'owner@example.invalid', data([row('own-open', A, { wonAt: '' })]));
  const sellerRows = [
    row('current-win'), row('other-win', B), row('mixed'), row('mixed', B),
    row('unknown'), row('unknown', A, { state: {} }),
    row('conflicting', A, { businessId: B }), row('legacy', A, { state: {}, businessId: A }),
    row('current-before-saved', A, { finalInc: 100 }), row('unlock'), row('deleted'),
    row('open', A, { wonAt: '' }), row('missing-money', A, { finalInc: null, rebate: undefined, netProfit: '' }),
    row('malformed-money', A, { brand: { private: true }, model: ['secret'], finalInc: true, rebate: {}, netProfit: 'NaN' }),
    row('numeric-money', A, { size: 0, finalInc: '10.25', rebate: 0, netProfit: '-2.50' }),
    row('definition-win', A, { wonAt: '', wonByEmail: '' }),
    row('malformed-sibling'), 'not-a-row',
  ];
  await profile(3, 'seller@example.invalid', data(sellerRows, {
    installerQuoteOptionDefsV1: JSON.stringify([{ id: 'definition-win', name: 'Definition Quote', wonAt: stamp, wonByEmail: 'seller@example.invalid' }]),
    installerSavedQuoteSetsV1: JSON.stringify([saved([
      row('current-before-saved', A, { finalInc: 99999, paidInAt: stamp, paidOutAt: stamp }),
      row('saved-only'), row('unlock'), row('deleted'),
    ])]),
    installerWonOptionAdminStateV1: '[]',
    WonOptionAdminStateV1: JSON.stringify([marker('unlock', { unlockedAt: stamp })]),
  }));
  await profile(4, 'former@example.invalid', data([], { installerSavedQuoteSetsV1: JSON.stringify([saved([row('former-member')])]) }));
  await profile(5, 'admin@example.invalid', data([
    row('admin-stored'), row('current-win', A, { finalInc: 999999, paidInAt: stamp, paidOutAt: stamp }),
    row('other-win', B, { finalInc: 999999 }),
  ]));
  await profile(7, 'markers@example.invalid', {
    installerDeletedWonOptionsV1: JSON.stringify([marker('deleted', { deletedAt: stamp })]),
    installerWonOptionAdminStateV1: JSON.stringify([marker('unlock', { updatedAt: '2026-11-10T00:00:00Z' })]),
  });
  const originalStructure = await quoteStructure();
  await db.exec('begin');
  await db.exec(sql);
  await db.exec(indexSql);
  await db.exec('rollback');
  check((await q("select to_regclass('business_won_private.source_directory') is null and to_regprocedure('public.read_business_won_jobs(uuid)') is null as clean")).rows[0].clean, 'combined migration rolls back all table/index/function changes atomically');
  await db.exec('begin');
  await db.exec(sql);
  await db.exec(indexSql);
  await db.exec('commit');
  await db.exec(sql);
  check((await q("select indisvalid and indisready as ready from pg_index where indexrelid='business_won_private.business_won_jobs_directory_keys_idx'::regclass")).rows[0].ready, 'directory index is ready; read SQL is repeatable');
  assert.deepEqual(await quoteStructure(), originalStructure, 'original quote indexes, triggers, constraints, RLS and grants unchanged'); checks++;
  check((await q("select to_regclass('public.business_won_jobs_source_keys_idx') is null as absent")).rows[0].absent, 'old expression index is absent and unnecessary');
  check((await q("select bool_and(provolatile='v') as valid from pg_proc where oid in ('business_won_private.read_v1(uuid)'::regprocedure,'public.read_business_won_jobs(uuid)'::regprocedure)")).rows[0].valid, 'both cache-writing RPC functions are VOLATILE');
  assert.deepEqual((await q(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='business_won_private' and has_function_privilege('authenticated',p.oid,'EXECUTE') order by p.proname`)).rows.map((p) => p.proname),
  ['read_v1'], 'only the private read entry point is executable by authenticated users'); checks++;
  check((await q(`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='business_won_private' and has_function_privilege('anon',p.oid,'EXECUTE')`)).rows[0].n === 0, 'anonymous users have no private helper execute privileges');

  console.log('Business Won Jobs: checking authorization, isolation, canonical sources and grants.');
  const initialChecksums = await checksum();
  await as('anon');
  await rejected(() => read(), /permission denied/, 'anonymous RPC is denied');
  await as('authenticated', null);
  await rejected(() => read(), /access denied/, 'JWT user ID is required');
  await as('authenticated', OWNER, 'unapproved@example.invalid');
  await rejected(() => read(), /access denied/, 'unapproved caller denied');
  await as('authenticated', SELLER, 'seller@example.invalid');
  await rejected(() => read(), /access denied/, 'salespeople cannot call the owner RPC even when assigned');
  await as();
  await rejected(() => read(B), /access denied/, 'business A owner cannot read business B');
  await rejected(() => read(null), /access denied/, 'null business denied');
  await rejected(() => q('select business_won_private.money_v1($1)', ['1']), /permission denied/, 'non-index private helpers cannot be invoked directly');
  await rejected(() => q('select business_won_private.source_keys_v1($1,$2,$3)', ['{}', OWNER, 'owner@example.invalid']), /permission denied/, 'data parser grants are no longer needed by quote writes');
  await rejected(() => q('select * from business_won_private.source_directory'), /permission denied/, 'private directory is not exposed to callers');
  check((await q('select user_id from user_calculator_data')).rows.every((r) => r.user_id === OWNER), 'existing profile RLS still exposes only self');
  let result = await read();
  assert.deepEqual(Object.keys(result).sort(), ['businessId', 'businessName', 'jobs']); checks++;
  check(result.businessId === A && result.businessName === 'Fictional Business A', 'business envelope is scoped');
  let byName = new Map(result.jobs.map((job) => [job.quoteName, job]));
  for (const name of ['current-win', 'legacy', 'current-before-saved', 'saved-only', 'former-member', 'admin-stored', 'missing-money', 'malformed-money', 'numeric-money', 'Definition Quote']) {
    check(byName.has(name), `${name} is included`);
  }
  for (const name of ['other-win', 'mixed', 'unknown', 'conflicting', 'unlock', 'deleted', 'open']) {
    check(!byName.has(name), `${name} is excluded, not partially returned`);
  }
  check(byName.get('current-win').rows[0].finalInc === 12345.67, 'salesperson-owned copy wins over admin-stored duplicate');
  check(result.jobs.filter((job) => job.quoteName === 'current-win').length === 1, 'cross-profile duplicate is one job');
  check(byName.get('current-before-saved').rows[0].finalInc === 100, 'current copy precedes same-owner saved copy even if saved payment flags differ');
  assert.deepEqual(byName.get('missing-money').rows[0], { brand: 'Fixture', model: 'OUT / IN', type: 'split', size: '3.5', install: 'replacement', finalInc: null, rebate: null, netProfit: null }); checks++;
  const malformedMoney = byName.get('malformed-money').rows[0];
  check(malformedMoney.brand === null && malformedMoney.model === null && malformedMoney.finalInc === null && malformedMoney.rebate === null && malformedMoney.netProfit === null, 'nested scalar fields and malformed money do not escape');
  check(byName.get('numeric-money').rows[0].finalInc === 10.25 && byName.get('numeric-money').rows[0].rebate === 0 && byName.get('numeric-money').rows[0].netProfit === -2.5, 'stored numeric strings and zero are retained without recalculation');
  check(!JSON.stringify(result).includes('NEVER_RETURN'), 'raw state and profile data do not escape');
  for (const job of result.jobs) {
    assert.deepEqual(Object.keys(job).sort(), ['key', 'quoteName', 'wonAt', 'salespersonName', 'address', 'installationDate', 'rows'].sort());
    for (const publicRow of job.rows) {
      assert.deepEqual(Object.keys(publicRow).sort(), ['brand', 'model', 'type', 'size', 'install', 'finalInc', 'rebate', 'netProfit'].sort());
      check(Object.values(publicRow).every((v) => v === null || ['string', 'number'].includes(typeof v)), 'row output is scalar-only');
    }
  }
  const stableKeys = result.jobs.map((job) => job.key);
  assert.deepEqual((await read()).jobs.map((job) => job.key), stableKeys); checks++;
  await as('authenticated', OTHER_OWNER, 'other-owner@example.invalid');
  result = await read(B);
  check(result.jobs.length === 1 && result.jobs[0].quoteName === 'other-win', 'business B sees only its own deduplicated job');
  check(result.jobs[0].key.startsWith(B + ':'), 'dedupe key is business-scoped');
  await as('authenticated', ADMIN, 'admin@example.invalid');
  check((await read()).jobs.length > 0, 'approved admin requires no business membership');
  await as('authenticated', PLATFORM_OWNER, 'danieldipalma88@gmail.com');
  check((await read()).jobs.length > 0, 'platform-owner canManage semantics are retained');
  await root();
  await q("update approved_users set business_id=null where email='other-owner@example.invalid'");
  await as('authenticated', OTHER_OWNER, 'other-owner@example.invalid');
  await rejected(() => read(B), /access denied/, 'null primary and no membership fail closed');
  await root();
  await q("update approved_users set business_id=$1 where email='other-owner@example.invalid'", [B]);
  await db.exec('alter index business_won_private.business_won_jobs_directory_keys_idx rename to fixture_hidden_directory_idx');
  await as();
  await rejected(() => read(), /directory index is not ready/, 'missing private directory index fails closed');
  await root();
  await db.exec('alter index business_won_private.fixture_hidden_directory_idx rename to business_won_jobs_directory_keys_idx');
  await q("update pg_catalog.pg_index set indisvalid=false where indexrelid='business_won_private.business_won_jobs_directory_keys_idx'::regclass");
  await as();
  await rejected(() => read(), /directory index is not ready/, 'invalid private directory index fails closed');
  await root();
  await q("update pg_catalog.pg_index set indisvalid=true where indexrelid='business_won_private.business_won_jobs_directory_keys_idx'::regclass");
  await root();
  await q("update approved_users set is_locked=true where email='danieldipalma88@gmail.com'");
  await as('authenticated', PLATFORM_OWNER, 'danieldipalma88@gmail.com');
  await rejected(() => read(), /access denied/, 'even platform owner is denied when locked');
  await root();
  await q("update approved_users set is_locked=false where email='danieldipalma88@gmail.com'");
  await q("insert into approved_user_businesses values('other-owner@example.invalid',$1)", [A]);
  await as('authenticated', OTHER_OWNER, 'other-owner@example.invalid');
  check((await read()).jobs.length > 0, 'business owner can read another assigned business under existing global role model');
  await root();
  await q("delete from approved_user_businesses where email='other-owner@example.invalid' and business_id=$1", [A]);
  await as('authenticated', OTHER_OWNER, 'other-owner@example.invalid');
  await rejected(() => read(), /access denied/, 'removed membership is checked on next RPC');
  await root();
  await q("update approved_users set is_locked=true where email='owner@example.invalid'");
  await as();
  await rejected(() => read(), /access denied/, 'approval lock is checked on every RPC');
  await root();
  await q("update approved_users set is_locked=false where email='owner@example.invalid'");
  assert.deepEqual(await checksum(), initialChecksums, 'all profile data, owner records and timestamps remain byte-equivalent after reads'); checks++;

  await instrumentParsers();
  console.log('Business Won Jobs: checking malformed aliases with unmodified quote-write paths.');
  const aliasRows = [row('alias-win')];
  const aliasOptions = [{ id: 'definition-only', name: 'Stale alias definition', wonAt: stamp }];
  const aliasCases = [
    ['malformed canonical string', '{', false], ['canonical JSON null string', 'null', false],
    ['canonical object', {}, false], ['canonical boolean true', true, false],
    ['canonical nonzero number', 1, false], ['canonical native empty array', [], false],
    ['canonical encoded empty array', '[]', false], ['canonical empty string', '', true],
    ['canonical boolean false', false, true], ['canonical numeric zero', 0, true], ['canonical null', null, true],
    ['canonical double encoded array', JSON.stringify(JSON.stringify(aliasRows)), false],
  ];
  for (const [label, value, expected] of aliasCases) {
    await profile(20, 'aliases@example.invalid', { installerMasterQuoteLogV1: value, greenEnergyMasterQuoteLogV1: JSON.stringify(aliasRows) });
    await as();
    check((await read()).jobs.some((job) => job.quoteName === 'alias-win') === expected, label);
  }
  await profile(20, 'aliases@example.invalid', data([row('definition-only', A, { wonAt: '' })], {
    installerQuoteOptionDefsV1: '{', QuoteOptionDefsV1: JSON.stringify(aliasOptions),
    installerSavedQuoteSetsV1: '{', SavedQuoteSetsV1: JSON.stringify([saved([row('stale-saved')])]),
  }));
  await as(); result = await read();
  check(!result.jobs.some((job) => ['Stale alias definition', 'stale-saved'].includes(job.quoteName)), 'malformed canonical definitions and saved-set aliases never fall through');
  await profile(20, 'aliases@example.invalid', data([], { installerSavedQuoteSetsV1: [saved(JSON.stringify(aliasRows))] }));
  await as();
  check(!(await read()).jobs.some((job) => job.quoteName === 'alias-win'), 'nested saved quotes must be native arrays like the admin reader');
  for (const malformed of [null, false, 1, 'broken', [], { installerMasterQuoteLogV1: '[null, {}, 2, []]' }]) {
    await root();
    check(Array.isArray((await q('select business_won_private.source_keys_v1($1,$2,$3) as keys', [JSON.stringify(malformed), OWNER, 'owner@example.invalid'])).rows[0].keys), 'index parser accepts malformed profile without throwing');
  }
  await as();
  for (const malformed of ['{', {}, true, 'null', '"[1]"']) {
    await q('update user_calculator_data set data=$1,updated_at=clock_timestamp() where user_id=$2', [JSON.stringify({ installerMasterQuoteLogV1: malformed, greenEnergyMasterQuoteLogV1: JSON.stringify(aliasRows) }), OWNER]);
  }
  check(true, 'authenticated self writes work with all parser execute grants revoked and malformed canonical aliases');
  await profile(1, 'owner@example.invalid', data([]));
  await profile(20, 'aliases@example.invalid', data([row('option_1'), null], { installerQuoteOptionDefsV1: [{ id: 'option_1', wonAt: stamp }] }));
  await as();
  check(!(await read()).jobs.some((job) => job.quoteName === 'Option'), 'malformed sibling row rejects the complete job');
  await profile(20, 'aliases@example.invalid', {});
  await as(); await read();
  await root();
  await db.exec('set enable_seqscan=off');
  const deletedIdentity = (await q('select business_won_private.identity_v1($1,$2,$3,$4) as identity', [SELLER, 'seller@example.invalid', 'deleted', stamp])).rows[0].identity;
  for (const [operator, token] of [['@>', `b:${A}`], ['&&', `j:${createHash('md5').update(deletedIdentity).digest('hex')}`]]) {
    const plan = await q(`explain(format json) select user_id from business_won_private.source_directory d where d.source_keys ${operator} $1::text[]`, [[token]]);
    check(JSON.stringify(plan.rows).includes('business_won_jobs_directory_keys_idx'), `${operator} source/fence discovery is indexed only on the private cache`);
  }
  await db.exec('reset enable_seqscan');
  const fences = (await q('select business_won_private.source_keys_v1(data,user_id,email) as keys from user_calculator_data where user_id=$1', [MARKERS])).rows[0].keys;
  check(fences.some((key) => key.startsWith('j:')) && fences.every((key) => !key.startsWith('b:')), 'marker-only profiles are discoverable without a tenant row or membership');
  for (const malformedState of [true, 'not-state', []]) {
    check((await q('select business_won_private.row_business_v1($1) as business', [JSON.stringify({ state: malformedState, businessId: A })])).rows[0].business === null, 'malformed state cannot be laundered through a legacy business ID');
  }

  console.log('Business Won Jobs: checking bounded cache progress, metadata freshness and rollback.');
  for (let n = 40; n < 65; n++) await profile(n, `history-${n}@example.invalid`, data([row(`other-history-${n}`, B)]));
  const beforeProgress = await checksum();
  await resetParserCalls();
  await as();
  assert.deepEqual(await readRaw(), { status: 'refreshing', businessId: A, retryAfterMs: 1000 }); checks++;
  check(await parserCalls('keys') === 10, 'one RPC refreshes exactly ten of twenty-five changed profiles');
  await as(); await read();
  check(await parserCalls('keys') === 25, 'bounded retries catch up all changed profiles without reprocessing fresh entries');
  assert.deepEqual(await checksum(), beforeProgress, 'cache population never changes primary quotes or timestamps'); checks++;
  await resetParserCalls();
  await as(); await read();
  check(await parserCalls('keys') === 0 && await parserCalls(null, id(40)) === 0, 'warm metadata check parses no source keys and no unchanged other-business profile JSON');
  const legacyBefore = (await q('select updated_at::text,email,xmin::text as version from user_calculator_data where user_id=$1', [id(42)])).rows[0];
  await q('update user_calculator_data set data=$1 where user_id=$2', [JSON.stringify({ ...data([row('legacy-data-only-update')]), _fixtureProfileId: id(42) }), id(42)]);
  await resetParserCalls(); await as();
  check((await read()).jobs.some((job) => job.quoteName === 'legacy-data-only-update'), 'data-only legacy update is discovered with unchanged timestamp and email');
  check(await parserCalls('keys', id(42)) === 1, 'xmin invalidates exactly the changed legacy source');
  const legacyAfter = (await q(`select s.updated_at::text,s.email,s.xmin::text as version,d.profile_version
    from user_calculator_data s join business_won_private.source_directory d using(user_id) where s.user_id=$1`, [id(42)])).rows[0];
  check(legacyAfter.updated_at === legacyBefore.updated_at && legacyAfter.email === legacyBefore.email
    && legacyAfter.version !== legacyBefore.version && legacyAfter.profile_version === legacyAfter.version,
    'directory records the same MVCC version as the data SELECT without relying on writer timestamps');
  await profile(40, 'history-40@example.invalid', data([row('newly-scoped-history', A)]));
  await resetParserCalls();
  await as();
  check((await read()).jobs.some((job) => job.quoteName === 'newly-scoped-history'), 'previously unselected changed profile is discovered on the next explicit read');
  check(await parserCalls('keys', id(40)) === 1, 'changed source is parsed once for its exact new metadata version');
  await profile(7, 'markers@example.invalid', { installerDeletedWonOptionsV1: JSON.stringify([
    marker('deleted', { deletedAt: stamp }),
    marker('newly-scoped-history', { dataUserId: id(40), dataOwnerEmail: 'history-40@example.invalid', deletedAt: stamp }),
  ]), installerWonOptionAdminStateV1: JSON.stringify([marker('unlock', { unlockedAt: stamp })]) });
  await as();
  check(!(await read()).jobs.some((job) => job.quoteName === 'newly-scoped-history'), 'changed marker-only profile is refreshed and suppresses a historical source job');
  await profile(65, 'new-history@example.invalid', data([row('new-profile-history')]));
  await as();
  check((await read()).jobs.some((job) => job.quoteName === 'new-profile-history'), 'new unlinked profile is discovered without membership inference');
  await root();
  await q('update user_calculator_data set email=$1 where user_id=$2', ['renamed-history@example.invalid', id(65)]);
  await as(); await read();
  await root();
  check((await q('select profile_email from business_won_private.source_directory where user_id=$1', [id(65)])).rows[0].profile_email === 'renamed-history@example.invalid', 'email-only metadata changes invalidate the cache even without a timestamp change');
  await q('delete from auth.users where id=$1', [id(65)]);
  await as();
  check(!(await read()).jobs.some((job) => job.quoteName === 'new-profile-history'), 'deleted primary source is omitted and its private orphan removed');
  await root();
  check((await q('select count(*)::int as n from business_won_private.source_directory where user_id=$1', [id(65)])).rows[0].n === 0, 'directory has no FK or delete hook on original quote storage');
  await q('insert into business_won_private.test_read_hook values($1,$2,true)', [id(41), JSON.stringify({ ...data([row('late-source-change')]), _fixtureProfileId: id(41) })]);
  await as();
  assert.deepEqual(await readRaw(), { status: 'refreshing', businessId: A, retryAfterMs: 1000 }, 'a synthetic source change during projection must hide the entire report'); checks++;
  check((await read()).jobs.some((job) => job.quoteName === 'late-source-change'), 'next RPC catches up the late changed source');
  await root();
  await q('delete from business_won_private.source_directory where user_id=$1', [id(40)]);
  const cacheBeforeRollback = (await q('select * from business_won_private.source_directory order by user_id')).rows;
  await db.exec('begin');
  await as();
  check((await readRaw()).jobs.length > 0, 'cache can catch up inside the caller transaction');
  await db.exec('rollback');
  await root();
  assert.deepEqual((await q('select * from business_won_private.source_directory order by user_id')).rows, cacheBeforeRollback, 'caller rollback removes cache upserts safely'); checks++;
  await as(); await read();

  console.log('Business Won Jobs: checking hard capacity limits, never truncation.');
  const capacityRows = Array.from({ length: 1001 }, (_, i) => row(`capacity-${i}`, C));
  await profile(30, 'capacity@example.invalid', data(capacityRows));
  await as('authenticated', ADMIN, 'admin@example.invalid');
  await rejected(() => read(C), /1000 job limit/, '1001 jobs throws instead of truncating');
  await root();
  check((await q('select count(*)::int as n from business_won_private.source_directory where user_id=$1', [id(30)])).rows[0].n === 0, 'projection error rolls back cache changes from that RPC');
  await profile(30, 'capacity@example.invalid', data(capacityRows.slice(0, 1000)));
  await as('authenticated', ADMIN, 'admin@example.invalid');
  check((await read(C)).jobs.length === 1000, 'exactly 1000 jobs is permitted');
  await profile(30, 'capacity@example.invalid', data(Array.from({ length: 201 }, () => row('one-large-job', C))));
  await as('authenticated', ADMIN, 'admin@example.invalid');
  await rejected(() => read(C), /200 rows per job limit/, '201 rows in one job throws instead of truncating');
  const totalRows = Array.from({ length: 5001 }, (_, i) => row(`total-${Math.floor(i / 200)}`, C));
  await profile(30, 'capacity@example.invalid', data(totalRows.slice(0, 5000)));
  await as('authenticated', ADMIN, 'admin@example.invalid');
  check((await read(C)).jobs.reduce((total, job) => total + job.rows.length, 0) === 5000, 'exactly 5000 total rows is permitted');
  await profile(30, 'capacity@example.invalid', data(totalRows));
  await as('authenticated', ADMIN, 'admin@example.invalid');
  await rejected(() => read(C), /5000 total rows limit/, '5001 total rows throws instead of truncating');
  await profile(30, 'capacity@example.invalid', data([row('byte-cap', C, { brand: '' })]));
  await as('authenticated', ADMIN, 'admin@example.invalid');
  const emptyBrandBytes = (await q("select octet_length((public.read_business_won_jobs($1)->'jobs')::text) as bytes", [C])).rows[0].bytes;
  const byteLimit = 2097152;
  await profile(30, 'capacity@example.invalid', data([row('byte-cap', C, { brand: 'x'.repeat(byteLimit - emptyBrandBytes) })]));
  await as('authenticated', ADMIN, 'admin@example.invalid');
  check((await q("select octet_length((public.read_business_won_jobs($1)->'jobs')::text) as bytes", [C])).rows[0].bytes === byteLimit, 'exactly 2 MiB jobs JSON is permitted');
  await profile(30, 'capacity@example.invalid', data([row('byte-cap', C, { brand: 'x'.repeat(byteLimit - emptyBrandBytes + 1) })]));
  await as('authenticated', ADMIN, 'admin@example.invalid');
  await rejected(() => read(C), /2 MiB output limit/, 'one byte above 2 MiB throws instead of truncating');
  for (const [label, brand] of [['quoted', '"'.repeat(1048576)], ['UTF-8', '\u00e9'.repeat(1048576)]]) {
    await profile(30, 'capacity@example.invalid', data([row('encoded-byte-cap', C, { brand })]));
    await as('authenticated', ADMIN, 'admin@example.invalid');
    await rejected(() => read(C), /2 MiB output limit/, `${label} output uses serialized UTF-8 bytes, not unescaped character count`);
  }
  await profile(30, 'capacity@example.invalid', {});

  // Rejected expression-index design, completed historical run (not rerun here):
  // 7,325,389 bytes, 7 authenticated UPDATE rounds, baseline median 30.28 ms,
  // expression-index median 125.69 ms (+95.41 ms, 4.15x). Replaced, never deployed.
  console.log('Business Won Jobs: benchmarking uncoupled quote writes and bounded read-side refresh; no network.');
  await root();
  const benchRows = Array.from({ length: 50 }, (_, i) => row(`benchmark-${i % 10}`, B, {
    model: `FICTIONAL-${i % 5} / FIXTURE-${i % 3}`, wonAt: '',
    state: { businessId: B, systemType: 'split', selectedBrand: 'Fixture', selectedModel: `FICTIONAL-${i % 5}`,
      postcode: '2000', installType: 'replacement', indoorLocations: ['Living room', 'Bedroom'],
      materials: Array.from({ length: 10 }, (_, j) => ({ id: `material-${j}`, label: `Fictional installation material ${j}`, quantity: 2, incGst: 10.25 })),
      costs: { labourEx: 300, powerEx: 150, materialsInc: 200, travelEx: 0 },
      customer: { name: 'Fictional Customer', address: '10 Fictional Street, Example NSW', email: 'fictional@example.invalid' },
    },
  }));
  const benchSaved = saved(benchRows);
  const targetBytes = 6 * 1024 * 1024;
  const savedCount = Math.ceil(targetBytes / Buffer.byteLength(JSON.stringify(benchSaved)));
  const benchData = data(benchRows, { _fixtureProfileId: id(88), installerSavedQuoteSetsV1: JSON.stringify(Array.from({ length: savedCount }, (_, i) => ({ ...benchSaved, id: `fictional-${i}` }))) });
  const benchJson = JSON.stringify(benchData);
  const bytes = Buffer.byteLength(benchJson);
  check(bytes >= targetBytes, 'benchmark snapshot is at least 6 MiB, made of repeated fictional quote snapshots');
  await q('insert into auth.users values($1,$2)', [id(88), 'large-save@example.invalid']);
  const hugeScalar = 'quoted"\\\n'.repeat(4096);
  const malformedLarge = data([row('hostile-id', hugeScalar)], {
    installerWonOptionAdminStateV1: JSON.stringify([marker('hostile-marker', { wonAt: hugeScalar, userEmail: hugeScalar })]),
    fixturePadding: 'x'.repeat(targetBytes),
  });
  await resetParserCalls();
  await as('authenticated', id(88), 'large-save@example.invalid');
  await q('insert into user_calculator_data(user_id,email,data) values($1,$2,$3)', [id(88), 'large-save@example.invalid', JSON.stringify(malformedLarge)]);
  check(true, 'actual authenticated malformed 6 MiB INSERT succeeds with no quote-table hook or parser grant');
  const malformedEncoded = JSON.stringify([row('malformed-large', A, { model: 'x'.repeat(targetBytes) })]).slice(0, -1);
  for (const storageKey of ['installerMasterQuoteLogV1', 'installerSavedQuoteSetsV1', 'installerWonOptionAdminStateV1']) {
    await q('update user_calculator_data set data=$1,updated_at=clock_timestamp() where user_id=$2', [JSON.stringify({ [storageKey]: malformedEncoded }), id(88)]);
    check(true, `actual authenticated malformed 6 MiB ${storageKey} UPDATE never invokes a cache parser`);
  }
  await q('update user_calculator_data set data=$1,updated_at=clock_timestamp() where user_id=$2', [benchJson, id(88)]);
  check(await parserCalls() === 0, 'large malformed and realistic normal quote INSERT/UPDATE invoke zero cache or projection parsers');
  await root();
  const keys = (await q('select business_won_private.source_keys_v1($1,$2,$3) as keys', [JSON.stringify(malformedLarge), id(88), 'large-save@example.invalid'])).rows[0].keys;
  check(keys.every((key) => key.length <= 38) && !keys.some((key) => key.startsWith('b:')), 'explicit read-side parsing still uses bounded UUID/hash keys for large quoted scalars');
  await db.exec(`
    create table bench_baseline(like public.user_calculator_data including all);
    alter table bench_baseline add foreign key(user_id) references auth.users(id) on delete cascade;
    alter table bench_baseline enable row level security;
    create policy bench_self on bench_baseline to authenticated using(auth.uid()=user_id) with check(auth.uid()=user_id);
    grant select,insert,update on bench_baseline to authenticated;
  `);
  await q('insert into auth.users values($1,$2)', [id(90), 'benchmark@example.invalid']);
  await as('authenticated', id(90), 'benchmark@example.invalid');
  for (const table of ['bench_baseline', 'public.user_calculator_data']) {
    await q(`insert into ${table}(user_id,email,data) values($1,'benchmark@example.invalid',$2)`, [id(90), benchJson]);
  }
  await resetParserCalls();
  await as('authenticated', id(90), 'benchmark@example.invalid');
  const timings = { baseline: [], quoteTable: [] };
  const rounds = 7;
  for (let i = -1; i < rounds; i++) {
    for (const kind of i % 2 === 0 ? ['quoteTable', 'baseline'] : ['baseline', 'quoteTable']) {
      const table = kind === 'baseline' ? 'bench_baseline' : 'public.user_calculator_data';
      const start = performance.now();
      await q(`update ${table} set data=jsonb_set(data,'{fixtureRevision}',to_jsonb($1::integer)),updated_at=clock_timestamp() where user_id=$2`, [i + 1, id(90)]);
      const elapsed = performance.now() - start;
      if (i >= 0) timings[kind].push(elapsed);
    }
  }
  const stats = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2), minMs: +sorted[0].toFixed(2), maxMs: +sorted.at(-1).toFixed(2) };
  };
  const baseline = stats(timings.baseline), quoteTable = stats(timings.quoteTable);
  check(await parserCalls() === 0, 'all benchmark normal quote writes invoke zero read-side parsers');
  assert.deepEqual(await quoteStructure(), originalStructure, 'quote table still has precisely its original indexes, triggers, constraints, RLS and grants'); checks++;
  await as(); await read();
  const refreshTimings = [], warmTimings = [];
  for (let i = 0; i < 3; i++) {
    await as('authenticated', id(88), 'large-save@example.invalid');
    await q("update user_calculator_data set data=jsonb_set(data,'{fixtureRefresh}',to_jsonb($1::integer)),updated_at=clock_timestamp() where user_id=$2", [i, id(88)]);
    await resetParserCalls();
    await as();
    let start = performance.now();
    check((await readRaw()).jobs.length > 0, 'one changed large other-business profile is refreshed completely in an explicit RPC');
    refreshTimings.push(performance.now() - start);
    check(await parserCalls('keys') === 1 && await parserCalls('keys', id(88)) === 1, 'large refresh parses exactly the changed profile, not all profiles');
    await resetParserCalls(); await as();
    start = performance.now(); await readRaw(); warmTimings.push(performance.now() - start);
    check(await parserCalls('keys') === 0 && await parserCalls(null, id(88)) === 0 && await parserCalls(null, id(90)) === 0,
      'unchanged 6 MiB other-business profiles are metadata-only on the warm request');
  }
  const benchmark = {
    engine: 'isolated in-memory PGlite PostgreSQL; parser calls instrumented only by this verifier',
    operation: 'authenticated UPDATE: matching baseline table versus actual quote table with private read-side cache; no new quote-table indexes or hooks',
    exclusions: 'No network, Supabase/PostgREST, production backup triggers, concurrent sessions or hardware; advisory coalescing across sessions is not validated here',
    bytes, savedSets: savedCount, quoteRows: (savedCount + 1) * benchRows.length, rounds,
    baseline, quoteTable, normalWriteParserCalls: 0,
    medianDifferenceMs: +(quoteTable.medianMs - baseline.medianMs).toFixed(2),
    explicitSingleLargeProfileRefresh: stats(refreshTimings), warmReport: stats(warmTimings),
    refreshLimitPerRpc: 10, verifierRetryLimit: 20,
  };
  await root();
  const finalBenchmark = (await q('select md5(b.data::text)=md5(i.data::text) as same from bench_baseline b join user_calculator_data i using(user_id)')).rows[0];
  check(finalBenchmark.same, 'baseline and actual quote table benchmark snapshots have identical final JSON');
  console.log(JSON.stringify({ benchmark }, null, 2));
  console.log(`Business Won Jobs database: ${checks} checks passed. Unchanged quote schema/writes, private directory, bounded refresh, version revalidation, warm parser counts, historical sources/fences, isolation, strict aliases, projection limits and rollback verified locally.`);
} catch (error) {
  console.error('Business Won Jobs database verification failed:', {
    message: error.message, code: error.code, position: error.position, detail: error.detail, where: error.where,
  });
  if (error.position && error.query) console.error(error.query.slice(Math.max(0, Number(error.position) - 180), Number(error.position) + 180));
  process.exitCode = 1;
} finally {
  await db.close();
}
