import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import * as registry from '../lib/model-research/registry.mjs';
import { sendModelRequestContact } from '../lib/model-request-email.ts';

const require = createRequire(import.meta.url);
function load(path, stubs) {
  const source = readFileSync(new URL('../' + path, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInThisContext(`(function(exports, require){${code}\n})`)(exports, name => name in stubs ? stubs[name] : require(name));
  return exports;
}
const { verifyResearchJob } = load('lib/model-research/verification.ts', {
  './registry.mjs': registry, '../model-request-verification': {}, '../model-catalogue': {
    modelIdentity: (brand, model) => brand.toUpperCase() + '|' + model.split('/').map(x => x.trim()).sort().join('/'),
  },
});
const request = { id: '11111111-1111-4111-8111-111111111111', round: 1, brand: 'Wrong brand', model: 'OUT / IN',
  capacity: '20', phase: 'three', postcode: '2114', install_type: 'new', system_type: 'ducted', notes: 'Nominal capacity', messages: ['Read this reply'] };
const canonical = { brand: 'DAIKIN', model: 'OUT / IN', capacityKw: 20.5, phase: 'Three', systemType: 'ducted', registrationNumber: 'AAC-FIXTURE' };
const product = { ...canonical, brand: 'Daikin', series: 'Fixture' };
delete product.registrationNumber;
const evidence = { registry: { registrationNumber: canonical.registrationNumber, brand: canonical.brand, model: canonical.model }, certificates: { esc: 1, prc: 2 } };
const job = { id: 'job', external_id: request.id, round: 1, request, state: 'pending_verification', result: { outcome: 'candidate', canonical, summary: 'Verified identity', sourceUrls: ['https://data.gov.au/'] } };
const current = async () => structuredClone(request);
const emptyCatalogue = async () => ({ products: [] });
const verify = async input => {
  assert.equal(input.brand, 'DAIKIN'); assert.equal(input.capacity, '20.5');
  assert.deepEqual(input.messages, request.messages);
  return { kind: 'verified', product, evidence };
};
let result = await verifyResearchJob(job, current, verify, emptyCatalogue);
assert.equal(result.kind, 'ready_to_add'); assert.equal(result.product.brand, 'Daikin');
assert.equal(result.evidence.verification.kind, 'verified');
assert.equal(result.existing, false);
const catalogue = { products: [{ ...product, priceIncGst: 9876 }] };
result = await verifyResearchJob(job, current, verify, async () => catalogue);
assert.equal(result.existing, true); assert.equal(catalogue.products[0].priceIncGst, 9876);
result = await verifyResearchJob(job, current, verify, async () => ({ products: [{ ...product, systemType: 'split' }] }));
assert.equal(result.kind, 'review');
result = await verifyResearchJob(job, current, async () => ({ kind: 'no_rebate', product, evidence: { ...evidence, certificates: { esc: 0, prc: 0 } } }), emptyCatalogue);
assert.equal(result.kind, 'no_rebate'); assert.equal(result.evidence.verification.kind, 'no_rebate');
result = await verifyResearchJob(job, current, async () => ({ kind: 'no_rebate', product, evidence: { ...evidence, registry: { ...evidence.registry, registrationNumber: 'OTHER' } } }), emptyCatalogue);
assert.equal(result.kind, 'review', 'An unrelated zero result cannot resolve the request');
result = await verifyResearchJob(job, current, async () => { throw Error('Temporary outage'); }, emptyCatalogue);
assert.equal(result.kind, 'retry_verification');
result = await verifyResearchJob(job, async () => ({ ...request, messages: ['New evidence'] }), async () => assert.fail('Stale research reached verifier'), emptyCatalogue);
assert.equal(result.kind, 'superseded');
let reads = 0;
result = await verifyResearchJob(job, async () => ++reads === 1 ? request : { ...request, postcode: '2500' }, verify, emptyCatalogue);
assert.equal(result.kind, 'superseded');
result = await verifyResearchJob(job, current, async () => ({ kind: 'clarify', reason: 'Which installation postcode?', candidates: [] }), emptyCatalogue);
assert.equal(result.kind, 'needs_details'); assert.equal(result.question, 'Which installation postcode?');
result = await verifyResearchJob({ ...job, state: 'waiting_for_details', result: { question: 'Which installation type?' } }, current, verify, emptyCatalogue);
assert.equal(result.kind, 'needs_details');
result = await verifyResearchJob({ ...job, state: 'budget_paused', result: { summary: 'Monthly budget reached' } }, current, verify, emptyCatalogue);
assert.equal(result.kind, 'review');

const savedEnv = { ...process.env }, originalFetch = globalThis.fetch;
try {
  process.env.MODEL_RESEARCH_ENABLED = 'true'; process.env.VERCEL_ENV = 'production';
  process.env.MODEL_REQUEST_WORKER_SECRET = 'fixture-worker-secret-which-is-at-least-forty-characters';
  process.env.MODEL_RESEARCH_OPENAI_API_KEY = 'fixture-not-a-real-key';
  let active = { ...job, state: 'queued', applied_at: null }, runCount = 0, applied = [], events = [], kicks = [];
  let next = { ...active, checkpoint: { round: 1 } }, outcome = { kind: 'ready_to_add', product, evidence };
  const store = {
    enqueue: async () => active, get: async () => active, current,
    apply: async (id, value) => { applied.push({ id, value }); return { state: 'added' }; },
    event: async (...args) => events.push(args), rpc: async () => null,
  };
  const processor = load('lib/model-request-research.ts', {
    './model-research/store': { PostgresResearchStore: class { constructor() { return store; } } },
    './model-research/agent.mjs': { ResearchAgent: class { async run() { runCount++; return next; } } },
    './model-research/config.mjs': { configuration: env => { assert.equal(env.OPENAI_API_KEY, 'fixture-not-a-real-key'); return {}; } },
    './model-research/provider.mjs': { OpenAIProvider: class {} }, './model-research/registry.mjs': { Registry: class {} },
    './model-research/verification': { verifyResearchJob: async () => outcome },
  });
  globalThis.fetch = async (url, options) => { kicks.push({ url, options }); return Response.json({ accepted: true }, { status: 202 }); };
  result = await processor.processModelResearch({ requestId: request.id });
  assert.equal(runCount, 1); assert.equal(result.processed, true); assert.equal(kicks.length, 1);
  assert.equal(kicks[0].url, 'https://calculator.rebateportal.com.au/api/internal/model-research');
  assert.deepEqual(JSON.parse(kicks[0].options.body), { jobId: job.id });
  active = { ...job, applied_at: null }; applied = []; runCount = 0; kicks = [];
  result = await processor.processModelResearch({ researchJobId: job.id });
  assert.equal(runCount, 0); assert.equal(applied.length, 1); assert.equal(kicks.length, 0);
  outcome = { kind: 'retry_verification', reason: 'Service unavailable' }; applied = [];
  await processor.processModelResearch({ researchJobId: job.id });
  assert.equal(applied[0].value.kind, 'review'); assert.equal(applied[0].value.evidence.temporaryVerificationFailure, true);
  active = { ...job, applied_at: '2026-11-09' }; applied = [];
  assert.equal((await processor.processModelResearch()).processed, false); assert.equal(applied.length, 0);
  active = { ...job, state: 'queued', applied_at: null }; next = { ...active, state: 'researching' }; kicks = [];
  await processor.processModelResearch(); assert.equal(kicks.length, 0, 'A leased worker must not start a continuation storm');
  next = { ...active, state: 'queued', checkpoint: { round: 0 } }; events = [];
  await processor.processModelResearch(); assert.equal(kicks.length, 0, 'No-progress deadline yields must not self-kick indefinitely');
  assert.match(events.at(-1)[2], /No checkpoint progress/);
  next = { ...active, state: 'queued', checkpoint: { round: 1 } };
  globalThis.fetch = async () => { throw Error('Network unavailable'); };
  await processor.processModelResearch(); assert.equal(events.at(-1)[1], 'continuation_deferred');
  process.env.MODEL_RESEARCH_ENABLED = 'false'; runCount = 0;
  assert.equal((await processor.processModelResearch()).processed, false); assert.equal(runCount, 0);

  let enabled = true, callbacks = [], calls = [];
  const route = load('app/api/internal/model-research/route.ts', {
    'next/server': { after: callback => callbacks.push(callback), NextResponse: { json: (body, options) => Response.json(body, options) } },
    '../../../../lib/model-request-worker': { modelAutomationEnabled: () => true, processModelRequest: async (...args) => calls.push(args) },
    '../../../../lib/model-request-research': { researchAutomationEnabled: () => enabled, researchHealth: async () => ({ enabled: true, keyConfigured: true }) },
  });
  const body = { jobId: request.id };
  const post = (data = body, auth = true) => route.POST(new Request('https://calculator.example/api/internal/model-research', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + process.env.MODEL_REQUEST_WORKER_SECRET } : {}) }, body: JSON.stringify(data),
  }));
  assert.equal((await post(body, false)).status, 401); assert.equal(callbacks.length, 0);
  assert.equal((await post({ ...body, userData: 'not permitted' })).status, 400);
  enabled = false; assert.equal((await post()).status, 409); enabled = true;
  assert.equal((await post()).status, 202); assert.equal(callbacks.length, 1);
  await callbacks[0](); assert.deepEqual(calls, [[undefined, request.id]]);
  assert.equal((await route.GET(new Request('https://calculator.example/'))).status, 401);

  process.env.MODEL_REQUEST_FROM_EMAIL = 'notifications@mail.rebateportal.com.au'; process.env.RESEND_API_KEY = 'fixture-only';
  let sent;
  globalThis.fetch = async (url, options) => { assert.equal(url, 'https://api.resend.com/emails'); sent = JSON.parse(options.body); return Response.json({ id: 'fixture-mail' }); };
  await sendModelRequestContact({ mail_key: 'no-rebate/fixture/1', request_id: request.id, kind: 'no_rebate', recipient: 'installer@example.invalid', lease: 'fixture', state: 'sending',
    payload: { brand: '<script>alert(1)</script>', model: 'OUT / IN', registration: 'AAC-FIXTURE', postcode: '2114', install_type: 'new' } });
  assert.equal(sent.from, 'Rebate Portal <notifications@mail.rebateportal.com.au>');
  assert.equal(sent.reply_to, 'danieldipalma88@gmail.com'); assert.match(sent.text, /0 ESC and 0 PRC/);
  assert.match(sent.text, /postcode 2114/); assert.match(sent.text, /not every possible installation/);
  assert.doesNotMatch(sent.html, /<script>/); assert.match(sent.html, /&lt;script&gt;/);
} finally {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
}
console.log('Research integration: current snapshots, exact registry binding, positive/zero/outage outcomes, catalogue conflicts, one-step continuations, authorization, OFF switch and safe email passed.');
