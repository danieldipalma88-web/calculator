import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const raw = fs.readFileSync(new URL('../app/calculator/raw/route.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('raw.ts', raw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const generators = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['safeScriptJson', 'injectCloudStorageSync'].includes(node.name?.text));
const generator = { sanitizeCalculatorData: data => data, DCCEEW_CONTRACT_RATE: 30, DCCEEW_ELIGIBLE_POSTCODES: [], DCCEEW_ELIGIBLE_PRODUCT_KEYS: [] };
vm.runInNewContext(ts.transpileModule(generators.map(node => node.getText(ast)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, generator);
const tick = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
const rowsKey = 'installerMasterQuoteLogV1';
const patch = { defs: [{ id: 'a', name: 'Customer', quoteFamilyId: 'a' }], rows: [{ id: 'stored', optionId: 'a', quotePosition: 0 }],
  removedOptionIds: ['deleted-option'], removedRowIds: ['unsaved'], selectedOptionId: 'a' };
const conflictResponse = () => ({ ok: false, status: 409, json: async () => ({ error: 'Options changed', code: 'QUOTE_OPTION_CONFLICT', currentFamily: patch }) });
const okResponse = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });

function browser() {
  const storage = new Map();
  const timeouts = new Map(), intervals = new Map(), events = [], calls = [], beacons = [];
  const windowHandlers = new Map();
  let timerId = 0, responder = async () => okResponse();
  const sandbox = {
    AbortController, Event, CustomEvent, Blob, performance: { now: () => 0 },
    setTimeout(fn, ms) { const id = ++timerId; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn, ms) { const id = ++timerId; intervals.set(id, { fn, ms }); return id; },
    window: {
      addEventListener(name, fn) { windowHandlers.set(name, fn); },
      dispatchEvent(event) { events.push(event); },
    },
    document: { body: null, readyState: 'loading', visibilityState: 'visible', addEventListener() {}, getElementById: () => null },
    localStorage: {
      get length() { return storage.size; }, key: index => [...storage.keys()][index], getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key), clear: () => storage.clear(),
    },
    navigator: { sendBeacon: (...args) => { beacons.push(args); return true; } },
    fetch(url, options) { calls.push({ url, options }); return responder(url, options); },
  };
  const html = generator.injectCloudStorageSync('<script></script>', { [rowsKey]: '[]', unrelatedDraft: 'keep' },
    { email: 'user@test', viewingEmail: 'user@test', businessId: null, canSeeOwnerDetails: false });
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], sandbox);
  return { sandbox, storage, timeouts, intervals, events, calls, beacons,
    setResponder(value) { responder = value; },
    fire(ms) {
      const found = [...timeouts].find(([, value]) => value.ms === ms); assert.ok(found, `Missing ${ms} timer`);
      timeouts.delete(found[0]); found[1].fn();
    },
    periodic() { [...intervals.values()].find(value => value.ms === 5000).fn(); },
    unload() { windowHandlers.get('beforeunload')(); },
  };
}

const paused = browser();
let respond;
paused.setResponder(() => new Promise(resolve => { respond = resolve; }));
paused.sandbox.localStorage.setItem(rowsKey, JSON.stringify([{ id: 'unsaved', optionId: 'a', quotePosition: 0 }]));
const first = paused.sandbox.window.__calculatorFlushCloudSave(20000).catch(error => error);
paused.sandbox.localStorage.setItem('unrelatedDraft', 'newer local edit');
const queued = paused.sandbox.window.__calculatorFlushCloudSave(20000).catch(error => error);
assert.equal(paused.calls.length, 1);
const beforeConflict = new Map(paused.storage);
respond(conflictResponse());
await tick();
const firstError = await first, queuedError = await queued;
assert.equal(firstError.code, 'QUOTE_OPTION_CONFLICT');
assert.equal(queuedError.code, 'QUOTE_OPTION_CONFLICT', 'all queued flush waiters reject immediately');
assert.deepEqual(plain(firstError.currentFamily), patch);
assert.deepEqual(paused.storage, beforeConflict, 'conflict never overwrites local data');
assert.equal(paused.sandbox.window.__calculatorQuoteConflict.code, 'QUOTE_OPTION_CONFLICT');
assert.deepEqual(plain(paused.sandbox.window.__calculatorQuoteConflict.currentFamily), patch);
const event = paused.events.find(event => event.type === 'calculator-quote-conflict');
assert.ok(event);
assert.equal(event.detail, firstError);
assert.ok(![...paused.timeouts.values()].some(timer => timer.ms === 1800 || timer.ms === 20000), 'no retry timer or unresolved waiter remains');
paused.sandbox.localStorage.setItem('anotherLocalDraft', 'retained while paused');
paused.periodic(); paused.unload();
assert.equal(paused.calls.length, 1);
assert.equal(paused.beacons.length, 0, 'paused conflicts cannot bypass recovery through unload beacon');
await assert.rejects(paused.sandbox.window.__calculatorFlushCloudSave(), error => error.code === 'QUOTE_OPTION_CONFLICT');
await assert.rejects(paused.sandbox.window.__calculatorQuoteRequest('quoteArrange', {}), error => error.code === 'QUOTE_OPTION_CONFLICT');
assert.equal(paused.calls.length, 1, 'preflush rejects promptly rather than blocking or sending another mutation');

// The coordinator-owned UI backs up first, applies only the patch, then explicitly resumes.
paused.sandbox.localStorage.setItem('installerSavedQuoteSetsV1', JSON.stringify([{ id: 'backup-before-recovery', quotes: JSON.parse(paused.storage.get(rowsKey)) }]));
paused.sandbox.localStorage.setItem(rowsKey, JSON.stringify(patch.rows));
paused.setResponder(async () => okResponse());
await paused.sandbox.window.__calculatorResolveQuoteConflict();
await tick();
assert.equal(paused.sandbox.window.__calculatorQuoteConflict, null);
assert.equal(paused.calls.length, 2, 'only corrected snapshot is sent after explicit resume');
const resumed = JSON.parse(paused.calls[1].options.body).data;
assert.deepEqual(JSON.parse(resumed[rowsKey]), patch.rows);
assert.equal(resumed.unrelatedDraft, 'newer local edit');
assert.equal(resumed.anotherLocalDraft, 'retained while paused');
assert.equal(JSON.parse(resumed.installerSavedQuoteSetsV1)[0].quotes[0].id, 'unsaved');

const transient = browser();
let attempts = 0;
transient.setResponder(async () => ++attempts === 1 ? ({ ok: false, status: 409, json: async () => ({ error: 'CAS changed; retry' }) }) : okResponse());
transient.sandbox.localStorage.setItem('draft', 'ordinary edit');
let settled = false;
const confirmation = transient.sandbox.window.__calculatorFlushCloudSave().then(() => { settled = true; });
await tick();
assert.equal(settled, false, 'transient CAS conflict keeps its flush waiter pending');
assert.equal(transient.sandbox.window.__calculatorQuoteConflict, null);
assert.equal(transient.sandbox.window.__calculatorCloudSaveState.tone, 'retrying');
assert.ok(!transient.events.some(event => event.type === 'calculator-quote-conflict'));
transient.fire(1800);
await confirmation; await tick();
assert.equal(transient.calls.length, 2);
assert.equal(settled, true);
assert.deepEqual(JSON.parse(transient.calls[0].options.body), JSON.parse(transient.calls[1].options.body), 'transient retries preserve their exact payload');

const raced = browser();
raced.sandbox.localStorage.setItem('draft', 'local');
raced.setResponder(async () => conflictResponse());
await assert.rejects(raced.sandbox.window.__calculatorFlushCloudSave(), error => error.code === 'QUOTE_OPTION_CONFLICT');
await tick();
await assert.rejects(raced.sandbox.window.__calculatorResolveQuoteConflict(), error => error.code === 'QUOTE_OPTION_CONFLICT');
await tick();
assert.equal(raced.sandbox.window.__calculatorQuoteConflict.code, 'QUOTE_OPTION_CONFLICT', 'a new conflict during recovery re-enters the paused state');
console.log('Quote conflict wrapper checks passed: whole emitted bootstrap; permanent pause/event/state; all waiter rejection; explicit resume; local draft/backup preservation; unload guard; transient CAS retries; recovery races.');
