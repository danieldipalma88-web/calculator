import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { ResearchAgent } from '../lib/model-research/agent.mjs';
import { OpenAIProvider, ProviderError, tools, INSTRUCTIONS } from '../lib/model-research/provider.mjs';
import { activeRecord, canonical, originalMatches, Registry, researchInput, requestDetails, validateFinding } from '../lib/model-research/registry.mjs';
import { configuration, reservationMicros, costMicros, sydneyMonth, assertPricingCurrent, PRICING,
  CONTEXT_WINDOW, MAX_OUTPUT, MAX_SEARCHES, MAX_ROUNDS, MONTHLY_LIMIT_MICROS,
  INITIAL_SPENT_MICROS, INITIAL_SPENT_MONTH, PROVIDER_TIMEOUT_MS, REGISTRY_TIMEOUT_MS } from '../lib/model-research/config.mjs';

// This verifier is standalone and offline: no env files, credentials, SQLite, or live services.
globalThis.fetch = async () => { throw new Error('Unexpected live fetch in offline research tests'); };
const now = () => new Date('2026-11-09T03:00:00Z');
const config = configuration({});
const row = {
  _id: 3507, Brand: 'MITSUBISHI HEAVY INDUSTRIES', Model_No: 'DXC09ZTLA-WJ/DXK09ZTLA-WFJ',
  'Registration Number': 'AAC8848', SubmitStatus: 'Approved', 'Availability Status': 'Available',
  Sold_in: 'Australia,New Zealand', ExpDate: '2030-05-14', Configuration1: 'Non Ducted',
  Configuration2: 'Single Split System', 'Outdoor unit only': 'No', Phase: 'Single',
  'C-Total Cool Rated': '2.5', 'H-Total Heat Rated': '3.0', 'C-Power_Inp_Rated': '0.58',
  'Product Class': 'Class 8', 'Rated AEER': '4.1883', 'Rated ACOP': '4.432',
  'Residential TCSPF_mixed': '4.945', 'Residential HSPF_mixed': '4.846', 'Residential HSPF_cold': '4.417',
};
const midea = { ...row, _id: 4555, Brand: 'Midea', Model_No: 'UCMI200OC-3PH/DUCMI200IHC-3PH',
  'Registration Number': 'AAC9517', Configuration1: 'Ducted', Phase: 'Three', 'C-Total Cool Rated': '20.5' };
const request = requestDetails({ id: 'test-greg', brand: 'Mitsubishi Electric',
  model: 'DXK09ZTLA-WFJ DXC09ZTLA-WJ', capacity: '2.5', system_type: 'split',
  postcode: '2114', install_type: 'new', notes: 'Mitsubishi Ciara Range' });
const source = 'https://data.gov.au/data/api/3/action/datastore_search_sql?verified=test';
const registry = { search: async () => ({ sourceUrl: source, truncated: false, records: [row] }) };
const finding = (record = row) => ({ outcome: 'candidate', summary: 'Exact registered pairing found. Sent to the calculator for verification.',
  canonical: canonical(record), sourceUrls: [source], question: null });
const response = output => ({ id: 'response_test', model: 'gpt-6.1-sol', status: 'completed',
  usage: { input_tokens: 1000, output_tokens: 200 }, output });
const call = (callId = 'registry_1') => response([{ type: 'function_call', name: 'search_registry',
  call_id: callId, arguments: JSON.stringify({ code: 'DXK09ZTLA-WFJ' }) }]);
const final = (value = finding()) => response([{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }]);
function provider(sequence = [call(), final()], trace = []) {
  let count = 0;
  return { get count() { return count; }, respond: async () => {
    trace.push('provider');
    const value = sequence[count++];
    if (value instanceof Error) throw value;
    assert.ok(value, 'Unexpected extra paid API call');
    return structuredClone(value);
  } };
}

// Mirrors local Store recovery and lease rules, with delayed async methods and durable snapshots.
class AsyncStore {
  constructor() {
    this.time = now(); this.jobs = new Map(); this.costs = []; this.trace = [];
    this.active = false; this.offline = false; this.serial = 0;
    this.seed = INITIAL_SPENT_MICROS;
  }
  now = () => this.time;
  async op(name, fn) {
    assert.equal(this.active, false, `Unawaited overlapping store operation: ${name}`);
    this.active = true; this.trace.push(`${name}:start`);
    try {
      await setImmediate();
      if (this.offline) throw new Error('Database unavailable');
      return fn();
    } finally { this.active = false; this.trace.push(`${name}:end`); }
  }
  check(id, lease) {
    const job = this.jobs.get(id);
    if (!job || job.state !== 'researching' || job.lease !== lease || job.lease_until <= this.time.getTime()) throw new Error('Research lease is no longer current');
    return job;
  }
  async enqueue(req = request) {
    return await this.op('enqueue', () => {
      const job = { id: `job_${++this.serial}`, request: structuredClone(req), state: 'queued', lease: null, checkpoint: null, events: [] };
      this.jobs.set(job.id, job);
      return structuredClone(job);
    });
  }
  async get(id) { return await this.op('get', () => structuredClone(this.jobs.get(id) || null)); }
  async claim(id) {
    return await this.op('claim', () => {
      const job = this.jobs.get(id);
      if (!job) return null;
      if (job.state === 'researching' && job.lease_until <= this.time.getTime()) {
        const costs = this.costs.filter(cost => cost.jobId === id);
        const ambiguous = costs.some(cost => ['pending', 'uncertain'].includes(cost.state))
          || costs.filter(cost => cost.state === 'settled').length > (job.checkpoint?.round || 0);
        job.state = ambiguous ? 'review' : 'queued'; job.lease = null;
      }
      if (job.state !== 'queued') return null;
      job.state = 'researching'; job.lease = `lease_${++this.serial}`;
      job.lease_until = this.time.getTime() + 180_000;
      return { job: structuredClone(job), lease: job.lease };
    });
  }
  async checkLease(id, lease) { return await this.op('checkLease', () => { this.check(id, lease); }); }
  async checkpoint(id, lease, value) {
    return await this.op(`checkpoint${value.round}`, () => {
      const job = this.check(id, lease);
      job.checkpoint = structuredClone(value); job.lease_until = this.time.getTime() + 180_000;
      this.afterCheckpoint?.(value);
    });
  }
  async yield(id, lease) {
    return await this.op('yield', () => {
      const job = this.check(id, lease);
      assert.ok(job.checkpoint, 'Yield requires durable checkpoint');
      assert.equal(this.costs.some(cost => cost.jobId === id && ['pending', 'uncertain'].includes(cost.state)), false);
      job.state = 'queued'; job.lease = null; job.lease_until = null;
    });
  }
  async finish(id, lease, state, value) {
    return await this.op('finish', () => {
      const job = this.check(id, lease);
      job.state = state; job.result = structuredClone(value); job.lease = null;
    });
  }
  async event(id, kind, detail) { return await this.op('event', () => { this.jobs.get(id).events.push({ kind, detail }); }); }
  async related(identity, excludeId) {
    return await this.op('related', () => [...this.jobs.values()].filter(job => job.id !== excludeId && job.result?.identity === identity).map(job => job.id));
  }
  async budget() {
    return await this.op('budget', () => ({ charged: this.seed + this.costs.reduce((sum, cost) => sum + cost.charged, 0),
      reserved: this.costs.filter(cost => ['pending', 'uncertain'].includes(cost.state)).reduce((sum, cost) => sum + cost.reserved, 0) }));
  }
  async reserve(id, lease, amount, limit) {
    return await this.op('reserve', () => {
      this.check(id, lease);
      const used = this.seed + this.costs.reduce((sum, cost) => sum + cost.charged + (['pending', 'uncertain'].includes(cost.state) ? cost.reserved : 0), 0);
      if (used + amount > limit || limit > MONTHLY_LIMIT_MICROS) throw new Error('Monthly research budget cannot cover another bounded API call');
      const cost = { id: `cost_${++this.serial}`, jobId: id, reserved: amount, charged: 0, state: 'pending' };
      this.costs.push(cost); this.afterReserve?.(); return cost.id;
    });
  }
  async settle(id, charged, providerId) {
    return await this.op('settle', () => {
      const cost = this.costs.find(cost => cost.id === id);
      assert.equal(cost.state, 'pending');
      if (charged > cost.reserved) { cost.state = 'uncertain'; return false; }
      Object.assign(cost, { charged, state: 'settled', providerId });
      this.afterSettle?.(); return true;
    });
  }
  async uncertain(id) { return await this.op('uncertain', () => { this.costs.find(cost => cost.id === id).state = 'uncertain'; }); }
  async rejected(id) { return await this.op('rejected', () => { this.costs.find(cost => cost.id === id).state = 'rejected'; }); }
}

async function setup(p = provider(), reg = registry, cfg = config, options = {}) {
  const store = new AsyncStore(); const job = await store.enqueue();
  const agent = new ResearchAgent({ store, provider: p, registry: reg, config: cfg, ...options });
  return { store, job, agent, p };
}
async function investigate(p = provider(), reg = registry, cfg = config) {
  const ctx = await setup(p, reg, cfg);
  let result = await ctx.agent.run(ctx.job.id);
  while (result.state === 'queued') result = await ctx.agent.run(ctx.job.id);
  return { ...ctx, result };
}

test('one invocation performs one provider round, awaits all stores, saves full response/tool results, then returns queued', async () => {
  const p = provider(); const { store, agent, job } = await setup(p);
  const original = p.respond;
  p.respond = async input => {
    assert.equal(store.active, false); store.trace.push('provider');
    assert.equal(store.jobs.get(job.id).checkpoint.round, p.count);
    assert.equal(store.costs.at(-1).state, 'pending'); return await original(input);
  };
  const first = await agent.run(job.id);
  assert.equal(first.state, 'queued'); assert.equal(first.lease, null); assert.equal(p.count, 1);
  assert.equal(first.checkpoint.round, 1);
  assert.deepEqual(first.checkpoint.response, call());
  assert.deepEqual(first.checkpoint.input.slice(-2), [...call().output,
    { type: 'function_call_output', call_id: 'registry_1', output: JSON.stringify(await registry.search()) }]);
  assert.deepEqual(first.checkpoint.records, [row]);
  const index = name => store.trace.indexOf(name);
  assert.ok(index('checkpoint0:end') < index('reserve:start'));
  assert.ok(index('reserve:end') < index('provider'));
  assert.ok(index('settle:end') < index('checkpoint1:start'));
  assert.ok(index('checkpoint1:end') < index('yield:start'));
  assert.ok(index('yield:end') < store.trace.lastIndexOf('get:start'));
  const second = await agent.run(job.id);
  assert.equal(second.state, 'pending_verification'); assert.equal(p.count, 2);
  assert.equal(second.result.canonical.brand, row.Brand); assert.equal(second.checkpoint.round, 2);
  assert.deepEqual(second.checkpoint.response, final());
  assert.deepEqual(await agent.run(job.id), second); assert.equal(p.count, 2);
  assert.equal((await store.budget()).reserved, 0);
});

test('budget preserves A$20, the spent seed, conservative full-context/search reservation and 2.2 FX', () => {
  assert.equal(config.limitMicros, 20e6); assert.equal(INITIAL_SPENT_MICROS, 1063705); assert.equal(INITIAL_SPENT_MONTH, '2026-11');
  assert.equal(PRICING.inputPerMillion, 5); assert.equal(PRICING.outputPerMillion, 15); assert.equal(PRICING.search, 0.01);
  assert.equal(reservationMicros(2.2), 11_729_168);
  const usdMicros = BigInt(CONTEXT_WINDOW * 5 + MAX_OUTPUT * 15 + MAX_SEARCHES * 10000);
  assert.equal(reservationMicros(2.2), Number((usdMicros * 22n + 9n) / 10n));
  assert.throws(() => configuration({ MODEL_RESEARCH_MONTHLY_AUD: '21' }));
  assert.throws(() => configuration({ MODEL_RESEARCH_AUD_PER_USD: '1.2' }));
  for (const fx of [0, 2.1, NaN, Infinity, 11, '2.2']) assert.throws(() => reservationMicros(fx));
  assert.throws(() => costMicros(undefined, 0, 2.2));
  assert.throws(() => costMicros({ input_tokens: CONTEXT_WINDOW + 1, output_tokens: 1 }, 0, 2.2));
  assert.throws(() => costMicros({ input_tokens: 1, output_tokens: MAX_OUTPUT + 1 }, 0, 2.2));
  assert.throws(() => costMicros({ input_tokens: 1, output_tokens: 1 }, MAX_SEARCHES + 1, 2.2));
  assert.equal(sydneyMonth(new Date('2026-10-31T14:00:00Z')), '2026-11');
});

test('budget/seed exhaustion blocks before any provider call', async () => {
  const { store, agent, job, p } = await setup(); store.seed = 10e6;
  assert.equal((await agent.run(job.id)).state, 'budget_paused'); assert.equal(p.count, 0);
  const small = await investigate(provider(), registry, { ...config, limitMicros: 1000 });
  assert.equal(small.result.state, 'budget_paused'); assert.equal(small.p.count, 0);
});

test('missing approved spent seed fails closed independently of database migration defaults', async () => {
  const { store, agent, job, p } = await setup(); store.seed = 0;
  const result = await agent.run(job.id);
  assert.equal(result.state, 'review'); assert.match(result.result.summary, /spent seed/);
  assert.equal(p.count, 0); assert.equal(store.costs.length, 0);
});

test('constructor-injected budget cannot bypass ceiling or FX review', async () => {
  for (const cfg of [{ ...config, limitMicros: 21e6 }, { ...config, fx: 1 }]) {
    const { result, p } = await investigate(provider(), registry, cfg);
    assert.equal(result.state, 'review'); assert.equal(p.count, 0);
  }
});

test('uncertain API outage holds reservation and never retries paid calls', async () => {
  const { store, agent, job, p, result } = await investigate(provider([new ProviderError('Uncertain API response')]));
  assert.equal(result.state, 'review'); assert.ok((await store.budget()).reserved > 0);
  assert.equal((await agent.run(job.id)).state, 'review'); assert.equal(p.count, 1);
});

test('definitive rejection releases reservation without automatic retry', async () => {
  const { store, p, result } = await investigate(provider([new ProviderError('Rejected 429', true)]));
  assert.equal(result.state, 'review'); assert.equal((await store.budget()).reserved, 0); assert.equal(p.count, 1);
});

test('missing/over-bound usage, extra searches, missing ID and unexpected billed models keep full reservation', async () => {
  for (const value of [
    { ...call(), usage: undefined }, { ...call(), model: 'gpt-6-astra' }, { ...call(), id: undefined },
    { ...call(), model: 'gptX6Y1-sol' },
    { ...call(), usage: { input_tokens: CONTEXT_WINDOW + 1, output_tokens: 200 } },
    { ...call(), usage: { input_tokens: 1000, output_tokens: MAX_OUTPUT + 1 } },
    response(Array.from({ length: 3 }, () => ({ type: 'web_search_call' }))),
  ]) {
    const { store, p, result } = await investigate(provider([value]));
    assert.equal(result.state, 'review'); assert.ok((await store.budget()).reserved > 0); assert.equal(p.count, 1);
  }
});

test('an over-reservation settlement halts without checkpoint/yield', async () => {
  const { store, agent, job, p } = await setup();
  store.settle = async id => await store.op('settle', () => { store.costs.find(cost => cost.id === id).state = 'uncertain'; return false; });
  assert.equal((await agent.run(job.id)).state, 'review'); assert.equal(p.count, 1);
  assert.equal(store.jobs.get(job.id).checkpoint.round, 0);
  assert.ok((await store.budget()).reserved > 0); assert.equal(store.trace.includes('yield:start'), false);
});

test('December 9 pricing review is fail-closed after the approved date', async () => {
  assert.doesNotThrow(() => assertPricingCurrent(new Date('2026-12-09T23:59:59Z')));
  assert.throws(() => assertPricingCurrent(new Date('2026-12-10T00:00:00Z')), /pricing needs review/);
  const { store, agent, job, p } = await setup(); store.time = new Date('2026-12-10T01:00:00Z');
  assert.equal((await agent.run(job.id)).state, 'review'); assert.equal(p.count, 0);
});

test('deadline before reservation yields a durable queued job with zero calls', async () => {
  const { store, agent, job, p } = await setup(provider(), registry, config, { maxDurationMs: 140_000 });
  const result = await agent.run(job.id);
  assert.equal(result.state, 'queued'); assert.equal(result.checkpoint.round, 0); assert.equal(p.count, 0);
  assert.equal(store.costs.length, 0);
});

test('deadline after slow reservation releases unused reservation and yields before provider', async () => {
  let clock = 0;
  const { store, agent, job, p } = await setup(provider(), registry, config, { clock: () => clock });
  store.afterReserve = () => { clock = 200_000; };
  assert.equal((await agent.run(job.id)).state, 'queued'); assert.equal(p.count, 0);
  assert.equal((await store.budget()).reserved, 0);
});

test('slow reservation renews the 180-second lease before the bounded paid round', async () => {
  const { store, agent, job, p } = await setup();
  store.afterReserve = () => { store.time = new Date(store.time.getTime() + 60_000); };
  const original = p.respond;
  p.respond = async input => {
    assert.equal(store.jobs.get(job.id).lease_until, store.time.getTime() + 180_000);
    return await original(input);
  };
  assert.equal((await agent.run(job.id)).state, 'queued'); assert.equal(p.count, 1);
});

test('each registry fetch checks remaining deadline and still checkpoints matching tool outputs', async () => {
  let clock = 0; let searches = 0;
  const p = provider([response([...call('a').output, ...call('b').output])]);
  const { store, agent, job } = await setup(p, { search: async () => { searches++; clock = 260_000; return await registry.search(); } }, config, { clock: () => clock });
  const result = await agent.run(job.id);
  assert.equal(result.state, 'queued'); assert.equal(searches, 1); assert.equal(result.checkpoint.round, 1);
  const results = result.checkpoint.input.filter(item => item.type === 'function_call_output');
  assert.equal(results.length, 2); assert.match(JSON.parse(results[1].output).error, /not evidence of no match/);
  assert.equal((await store.budget()).reserved, 0);
});

test('superseded or changed lease after provider settles charge but never finishes a newer worker', async () => {
  for (const state of ['superseded', 'researching']) {
    const { store, agent, job, p } = await setup();
    const original = p.respond;
    p.respond = async input => {
      const value = await original(input); Object.assign(store.jobs.get(job.id), { state, lease: 'newer_lease' }); return value;
    };
    const result = await agent.run(job.id);
    assert.equal(result.state, state); assert.equal(result.lease, 'newer_lease');
    assert.equal(store.costs[0].state, 'settled'); assert.equal(store.trace.includes('finish:start'), false);
  }
});

test('lease lost just before paid call rejects unused reservation and leaves the newer job alone', async () => {
  const { store, agent, job, p } = await setup();
  store.afterReserve = () => { Object.assign(store.jobs.get(job.id), { state: 'superseded', lease: 'newer' }); };
  assert.equal((await agent.run(job.id)).state, 'superseded'); assert.equal(p.count, 0);
  assert.equal((await store.budget()).reserved, 0); assert.equal(store.trace.includes('finish:start'), false);
});

test('checkpoint failure cannot leak through to reserve/provider', async () => {
  const { store, agent, job, p } = await setup();
  store.checkpoint = async () => { await setImmediate(); throw new Error('Checkpoint unavailable'); };
  assert.equal((await agent.run(job.id)).state, 'review'); assert.equal(p.count, 0); assert.equal(store.costs.length, 0);
});

test('database outage after paid response leaves pending charge and recovery never replays it', async () => {
  const { store, agent, job, p } = await setup(); const original = p.respond;
  p.respond = async input => { const value = await original(input); store.offline = true; return value; };
  await assert.rejects(() => agent.run(job.id), /Database unavailable/);
  store.offline = false; store.time = new Date(store.time.getTime() + 181_000);
  assert.equal((await agent.run(job.id)).state, 'review'); assert.equal(p.count, 1);
  assert.equal(store.costs[0].state, 'pending'); assert.ok((await store.budget()).reserved > 0);
});

test('crash after settlement but before durable post-call checkpoint never replays paid call', async () => {
  const { store, agent, job, p } = await setup(); store.afterSettle = () => { store.offline = true; };
  await assert.rejects(() => agent.run(job.id), /Database unavailable/);
  store.offline = false; store.time = new Date(store.time.getTime() + 181_000);
  assert.equal((await agent.run(job.id)).state, 'review'); assert.equal(p.count, 1);
  assert.equal(store.costs[0].state, 'settled'); assert.equal(store.jobs.get(job.id).checkpoint.round, 0);
});

test('crash after full tool checkpoint resumes only the next provider round', async () => {
  const { store, agent, job, p } = await setup();
  store.afterCheckpoint = value => { if (value.round === 1) store.offline = true; };
  await assert.rejects(() => agent.run(job.id), /Database unavailable/);
  store.offline = false; store.afterCheckpoint = null; store.time = new Date(store.time.getTime() + 181_000);
  assert.equal((await agent.run(job.id)).state, 'pending_verification'); assert.equal(p.count, 2);
});

test('crash after final checkpoint finalizes saved response without another provider call', async () => {
  const { store, agent, job, p } = await setup();
  await agent.run(job.id);
  store.afterCheckpoint = value => { if (value.round === 2) store.offline = true; };
  await assert.rejects(() => agent.run(job.id), /Database unavailable/);
  store.offline = false; store.afterCheckpoint = null; store.time = new Date(store.time.getTime() + 181_000);
  assert.equal((await agent.run(job.id)).state, 'pending_verification'); assert.equal(p.count, 2);
});

test('preexisting pending/unknown reservations are not resumed after crash', async () => {
  for (const state of ['pending', 'uncertain']) {
    const { store, agent, job, p } = await setup(); const claim = await store.claim(job.id);
    const cost = await store.reserve(job.id, claim.lease, reservationMicros(config.fx), config.limitMicros);
    if (state === 'uncertain') await store.uncertain(cost);
    store.time = new Date(store.time.getTime() + 181_000);
    assert.equal((await agent.run(job.id)).state, 'review'); assert.equal(p.count, 0);
  }
});

test('maximum round bound stops continuation without extra paid work', async () => {
  const { store, agent, job, p } = await setup(provider(Array.from({ length: MAX_ROUNDS }, (_, i) => call(`call_${i}`))));
  let result;
  for (let round = 0; round < MAX_ROUNDS; round++) result = await agent.run(job.id);
  assert.equal(result.state, 'review'); assert.equal(result.checkpoint.round, MAX_ROUNDS); assert.equal(p.count, MAX_ROUNDS);
  await agent.run(job.id); assert.equal(p.count, MAX_ROUNDS);
});

test('duplicate identities link via awaited related lookup without merging requests', async () => {
  const { store, agent, job } = await setup(); await agent.run(job.id); await agent.run(job.id);
  const second = await store.enqueue({ ...request, id: 'other' });
  const next = new ResearchAgent({ store, provider: provider(), registry, config }); await next.run(second.id);
  const result = await next.run(second.id);
  assert.deepEqual(result.result.relatedInvestigationIds, [job.id]); assert.equal(store.jobs.size, 2);
});

test('write tools, excessive/duplicate calls and extra arguments never execute', async () => {
  for (const output of [
    [{ type: 'function_call', name: 'publish_product', call_id: 'bad', arguments: '{}' }],
    [...call('a').output, ...call('b').output, ...call('c').output],
    [...call('a').output, ...call('a').output],
    [{ ...call().output[0], arguments: JSON.stringify({ code: 'DXK09', email: 'no' }) }],
  ]) {
    const { result } = await investigate(provider([response(output)])); assert.equal(result.state, 'review');
  }
});

test('registry outage/truncation cannot turn into fabricated identity or no-rebate finding', async () => {
  for (const reg of [
    { search: async () => { throw new Error('503'); } },
    { search: async () => ({ sourceUrl: source, truncated: true, records: [row] }) },
  ]) {
    const { result, p } = await investigate(provider(), reg);
    assert.equal(result.state, 'review'); assert.equal(result.result.canonical, undefined); assert.equal(p.count, 2);
  }
});

test('forged citations, malformed JSON and incomplete generation fail closed', async () => {
  for (const sequence of [
    [call(), final({ ...finding(), sourceUrls: ['https://invented.example'] })],
    [response([{ type: 'message', content: [{ type: 'output_text', text: '{' }] }])],
    [{ ...call(), status: 'incomplete' }],
  ]) { assert.equal((await investigate(provider(sequence))).result.state, 'review'); }
});

test('outgoing provider request keeps model, domains, timeouts and strict read-only tools', async () => {
  let body; let signal;
  const p = new OpenAIProvider('fake-offline-key', async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(init.redirect, 'error');
    body = JSON.parse(init.body); signal = init.signal; return new Response('fake-offline-key', { status: 401 });
  });
  await assert.rejects(() => p.respond([]), error => error.definitive && !error.message.includes('fake-offline-key'));
  assert.ok(signal instanceof AbortSignal); assert.equal(PROVIDER_TIMEOUT_MS, 90_000); assert.equal(REGISTRY_TIMEOUT_MS, 20_000);
  assert.equal(body.model, 'gpt-6.1-sol'); assert.equal(body.service_tier, 'default'); assert.equal(body.store, false);
  assert.equal(body.max_tool_calls, 2); assert.equal(body.max_output_tokens, 4096); assert.equal(body.parallel_tool_calls, false);
  assert.deepEqual(body.reasoning, { effort: 'medium' });
  assert.equal(body.text.format.strict, true); assert.equal(body.tools.length, 2);
  assert.deepEqual(tools.filter(tool => tool.type === 'function').map(tool => tool.name), ['search_registry']);
  assert.ok(tools[1].filters.allowed_domains.includes('data.gov.au'));
  assert.equal(tools[1].filters.allowed_domains.includes('example.com'), false);
  assert.match(INSTRUCTIONS, /Never guess or strip model suffixes/);
});

test('transport/server/unreadable provider responses are uncertain; definitive rejections release only known failures', async () => {
  for (const status of [400, 401, 403, 404, 422, 429, 500, 502]) {
    await assert.rejects(() => new OpenAIProvider('fake', async () => new Response('', { status })).respond([]),
      error => error.definitive === (status < 500));
  }
  await assert.rejects(() => new OpenAIProvider('fake', async () => { throw new Error('network'); }).respond([]), error => !error.definitive);
  await assert.rejects(() => new OpenAIProvider('fake', async () => new Response('{')).respond([]), error => !error.definitive);
  await assert.rejects(() => new OpenAIProvider('', async () => assert.fail('must not fetch')).respond([]), error => error.definitive);
});

// Registry assertions ported from the isolated fake-provider/registry suites.
test('normalizes separators/order without guessing equipment suffixes', () => {
  assert.equal(originalMatches(request.model, row.Model_No), true);
  assert.equal(originalMatches('dxk09ztla-wfj / dxc09ztla-wj', row.Model_No), true);
  assert.equal(originalMatches('DXK09ZTLA-WFJ', row.Model_No), true);
  assert.equal(originalMatches('DXK09ZTLA-WF', row.Model_No), false);
  assert.equal(originalMatches('DXK09ZTLA-WFJ / DIFFERENT-OUT', row.Model_No), false);
});
test('accepts wrong brand only when exact independent equipment identity is proven', () => {
  const result = validateFinding(finding(), request, [row], new Set([source]), now());
  assert.equal(result.canonical.brand, row.Brand); assert.equal(result.registration, row);
});
test('accepts nominal capacity but never unrelated capacity', () => {
  const req = requestDetails({ ...request, model: midea.Model_No, brand: 'Midea', system_type: 'ducted', capacity: '20kw', phase: 'three' });
  assert.equal(validateFinding(finding(midea), req, [midea], new Set([source]), now()).canonical.capacityKw, 20.5);
  assert.throws(() => validateFinding(finding(midea), { ...req, capacity: '14' }, [midea], new Set([source]), now()), /Capacity discrepancy/);
});
test('rejects forged evidence, suffix/phase changes, absent records and duplicate registrations', () => {
  assert.throws(() => validateFinding(finding(), request, [], new Set([source]), now()), /independently fetched/);
  assert.throws(() => validateFinding({ ...finding(), sourceUrls: ['https://invented.example'] }, request, [row], new Set([source]), now()), /valid collected evidence/);
  assert.throws(() => validateFinding(finding(), { ...request, phase: 'three' }, [row], new Set([source]), now()), /phase conflicts/);
  assert.throws(() => validateFinding(finding(), { ...request, model: 'DXK09ZTLA-WF' }, [row], new Set([source]), now()), /suffix/);
  assert.throws(() => validateFinding(finding(), request, [row, { ...row, _id: 44 }], new Set([source]), now()), /exactly one/);
});
test('refuses expired, invalid-date, foreign, outdoor-only and unapproved registrations', () => {
  for (const override of [{ ExpDate: '2026-01-01' }, { ExpDate: '2030-02-31' }, { Sold_in: 'New Zealand' },
    { 'Outdoor unit only': 'Yes' }, { SubmitStatus: 'Pending' }, { 'Availability Status': 'Unavailable' }]) {
    assert.equal(activeRecord({ ...row, ...override }, now()), false);
  }
});
test('does not infer component pairing from package-only registration', () => {
  const packageRow = { ...row, Model_No: 'HAWJ9KR' };
  assert.throws(() => validateFinding({ ...finding(), canonical: { ...finding().canonical, model: 'HAWJ9KR' } },
    request, [packageRow], new Set([source]), now()), /package aliases/);
});
test('research input excludes IDs/contact details and scrubs replies', () => {
  const input = researchInput({ ...request, requester_email: 'private@example.com', notes: 'Ask private@example.com or 0424 230 307', messages: ['Call 0424 230 307'] });
  assert.equal(JSON.stringify(input).includes('private@example.com'), false); assert.equal(JSON.stringify(input).includes('0424'), false);
  assert.equal('id' in input, false);
});
test('request validation rejects unsupported systems, malformed context and oversized replies', () => {
  for (const override of [{ system_type: 'multi_split' }, { round: 0 }, { postcode: '12345' }, { messages: ['x'.repeat(2001)] }]) {
    assert.throws(() => requestDetails({ ...request, ...override }));
  }
});
test('registry uses fixed public endpoint, blocks SQL injection and distinguishes outages', async () => {
  let seen;
  const reg = new Registry(async (url, options) => {
    seen = url; assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ success: true, result: { records: [row] } }));
  });
  assert.equal((await reg.search('DXK09ZTLA-WFJ')).records.length, 1); assert.equal(seen.hostname, 'data.gov.au');
  await assert.rejects(() => reg.search("x'; DROP TABLE jobs; --"), /model code/);
  await assert.rejects(() => new Registry(async () => new Response('', { status: 503 })).search('DXK09'), /unavailable/);
});
