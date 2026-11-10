import assert from 'node:assert/strict';
import vm from 'node:vm';
import { gunzipSync } from 'node:zlib';
import { bootstrapHtml } from './verify-business-configuration.mjs';

const tick = async () => { for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const success = () => ({ ok: true, status: 200, json: async () => ({ ok: true }), headers: { get: () => null } });
const unavailable = () => ({ ok: false, status: 503, json: async () => ({ error: 'offline' }), headers: { get: () => null } });

function browser({ cloud = { draft: 'seed' }, businessId = '11111111-1111-4111-8111-111111111111', email = 'fixture@example.test', viewingEmail = email, session = new Map(), initialStorage = {}, initialStorageFailure = {}, startupStorage = {}, compression = false } = {}) {
  const storage = new Map(Object.entries(initialStorage).map(([key, value]) => [key, String(value)]));
  const timeouts = new Map(), intervals = new Map(), documentHandlers = new Map(), windowHandlers = new Map();
  const calls = [], beacons = [], storageWrites = [];
  const storageFailure = { set: false, remove: false, ...initialStorageFailure };
  const sessionFailure = { set: false };
  let nextTimer = 0, responder = () => success();
  const sandbox = {
    AbortController, Blob, Event, CustomEvent, performance: { now: () => 0 },
    ...(compression ? { CompressionStream, Response } : {}),
    Math: Object.assign(Object.create(Math), { random: () => 0.25 }),
    setTimeout(fn, ms) { const id = ++nextTimer; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn, ms) { const id = ++nextTimer; intervals.set(id, { fn, ms }); return id; },
    clearInterval(id) { intervals.delete(id); },
    window: { addEventListener(name, fn) { windowHandlers.set(name, fn); }, dispatchEvent() {} },
    document: { body: null, readyState: 'loading', visibilityState: 'visible', getElementById: () => null,
      addEventListener(name, fn) { const list = documentHandlers.get(name) || []; list.push(fn); documentHandlers.set(name, list); } },
    localStorage: {
      get length() { return storage.size; }, key: index => [...storage.keys()][index],
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => { if (storageFailure.set) throw new Error('storage unavailable'); storageWrites.push(['set', key, String(value)]); storage.set(key, String(value)); },
      removeItem: key => { if (storageFailure.remove === true || storageFailure.remove === key) throw new Error('storage unavailable'); storageWrites.push(['remove', key]); storage.delete(key); },
      clear: () => { storageWrites.push(['clear']); storage.clear(); },
    },
    sessionStorage: {
      get length() { return session.size; }, key: index => [...session.keys()][index] ?? null,
      getItem: key => session.get(key) ?? null,
      setItem: (key, value) => { if (sessionFailure.set) throw new Error('session storage full'); session.set(key, String(value)); },
      removeItem: key => session.delete(key),
    },
    navigator: { sendBeacon: (...args) => { beacons.push(args); return true; } },
    fetch(url, options) {
      if (typeof options.body !== 'string') return options.body.arrayBuffer().then(bytes => {
        assert.equal(options.headers['Content-Type'], 'application/vnd.rebate-portal.calculator-save+gzip');
        calls.push({ url, options, body: JSON.parse(gunzipSync(bytes).toString()) });
        return responder(url, options);
      });
      calls.push({ url, options, body: JSON.parse(options.body || '{}') }); return responder(url, options);
    },
  };
  let html = bootstrapHtml(cloud, businessId).replaceAll('fixture@example.test', email);
  if (viewingEmail !== email) html = html.replace(`"viewingEmail":"${email}"`, `"viewingEmail":"${viewingEmail}"`);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'generated calculator bootstrap script exists');
  vm.runInNewContext(script, sandbox);
  Object.entries(startupStorage).forEach(([key, value]) => sandbox.localStorage.setItem(key, value));
  documentHandlers.get('DOMContentLoaded')?.find(fn => fn.name === 'finishRecoveryStartup')?.();
  return {
    sandbox, storage, session, storageWrites, storageFailure, sessionFailure, timeouts, intervals, documentHandlers, windowHandlers, calls, beacons,
    setResponder(fn) { responder = fn; },
    timer(ms) {
      const entry = [...timeouts].find(([, timer]) => timer.ms === ms);
      assert.ok(entry, `expected pending timer ${ms}ms; found ${[...timeouts.values()].map(timer => timer.ms).join(',')}`);
      timeouts.delete(entry[0]); entry[1].fn();
    },
    periodic() { const entry = [...intervals.values()].find(timer => timer.ms === 5000); assert.ok(entry); entry.fn(); },
    input() { for (const fn of documentHandlers.get('input') || []) fn({}); },
    profileChanged() { windowHandlers.get('storage')({ key: '__calculatorProfileEmail' }); },
    unload() {
      let prevented = false;
      const event = { preventDefault() { prevented = true; }, returnValue: undefined };
      windowHandlers.get('beforeunload')(event);
      return { prevented, returnValue: event.returnValue };
    },
    edit(value) { sandbox.localStorage.setItem('draft', value); },
  };
}

function recoveryKey(email = 'fixture@example.test', businessId = '11111111-1111-4111-8111-111111111111', viewingEmail = email) {
  const profile = `${viewingEmail}|${businessId}`;
  return `__calculatorPendingSaveV1:${email}|${profile}`;
}

function assertRecoverySemantic(actualJson, expectedJson, message) {
  const actual = JSON.parse(actualJson);
  const expected = JSON.parse(expectedJson);
  assert.equal(actual.version, expected.version, message);
  assert.equal(actual.profile, expected.profile, message);
  assert.deepEqual(actual.envelope, expected.envelope, message);
  assert.ok(Number.isFinite(Date.parse(actual.savedAt)), `${message}: savedAt is a valid timestamp`);
}

// A single in-flight request may retain only the newest later snapshot. Timer-driven,
// input-driven and explicit snapshots must respect the same scheduled backoff.
const recovery = browser();
const submittedBodies = [];
recovery.setResponder(async (_url, options) => {
  submittedBodies.push(JSON.parse(options.body).data.draft);
  return unavailable();
});
recovery.edit('old');
const initialWaiter = recovery.sandbox.window.__calculatorFlushCloudSave(60000).catch(error => error);
await tick();
assert.deepEqual(submittedBodies, ['old']);
assert.equal(recovery.sandbox.window.__calculatorCloudSaveState.tone, 'retrying');
assert.notEqual(recovery.sandbox.window.__calculatorCloudSaveState.tone, 'saved');
assert.deepEqual(recovery.unload(), { prevented: true, returnValue: '' });
assert.equal(recovery.beacons.length, 0, 'in-flight/retrying save warns and never races with a beacon');

recovery.edit('newer'); recovery.input(); recovery.timer(700); recovery.periodic();
const explicitWaiter = recovery.sandbox.window.__calculatorFlushCloudSave(60000).catch(error => error);
await tick();
assert.deepEqual(submittedBodies, ['old'], 'input, periodic and explicit snapshots cannot bypass backoff');
assert.ok([...recovery.timeouts.values()].some(timer => timer.ms === 3125), 'first retry uses 3s plus deterministic jitter');
recovery.timer(3125); await tick();
assert.deepEqual(submittedBodies, ['old', 'newer'], 'retry sends latest pending snapshot, not failed stale payload');
recovery.edit('latest'); recovery.input(); recovery.timer(700); recovery.periodic();
await tick();
assert.deepEqual(submittedBodies, ['old', 'newer']);
assert.ok([...recovery.timeouts.values()].some(timer => timer.ms === 10125), 'second retry uses 10s plus deterministic jitter');
recovery.timer(10125); await tick();
assert.deepEqual(submittedBodies, ['old', 'newer', 'latest']);
assert.match((await initialWaiter)?.message || '', /could not be confirmed/, 'bounded retry exhaustion rejects original confirmation');
assert.match((await explicitWaiter)?.message || '', /could not be confirmed/, 'bounded retry exhaustion rejects queued confirmation');
assert.equal(recovery.sandbox.window.__calculatorCloudSaveState.tone, 'error');
assert.equal(recovery.beacons.length, 0, 'paused save warns without beacon amplification');
assert.deepEqual(recovery.unload(), { prevented: true, returnValue: '' });
recovery.edit('paused-latest'); recovery.input(); recovery.timer(700); recovery.periodic(); await tick();
assert.deepEqual(submittedBodies, ['old', 'newer', 'latest'], 'input and interval snapshots cannot bypass paused state');

let manualResolved = false;
recovery.setResponder(async (_url, options) => {
  submittedBodies.push(JSON.parse(options.body).data.draft);
  return success();
});
recovery.edit('manual-newest');
const manual = recovery.sandbox.window.__calculatorFlushCloudSave(60000).then(() => { manualResolved = true; });
await tick();
assert.deepEqual(submittedBodies, ['old', 'newer', 'latest', 'manual-newest'], 'manual retry immediately sends the newest paused snapshot');
await manual; await tick();
assert.equal(manualResolved, true);
assert.equal(recovery.sandbox.window.__calculatorCloudSaveState.tone, 'saved');
assert.equal(recovery.beacons.length, 0);

// Response body must explicitly acknowledge the save; empty, malformed and negative
// 200 responses are failures, never Saved. A subsequent valid response recovers.
for (const badResponse of [
  { ok: true, status: 200, json: async () => ({}) },
  { ok: true, status: 200, json: async () => { throw new Error('invalid JSON'); } },
  { ok: true, status: 200, json: async () => ({ ok: false }) },
  { ok: false, status: 200, json: async () => ({ ok: true }) },
]) {
  const check = browser();
  let attempt = 0;
  check.setResponder(async () => ++attempt === 1 ? badResponse : success());
  check.edit('response-check');
  const pending = check.sandbox.window.__calculatorFlushCloudSave(60000);
  await tick();
  assert.equal(check.sandbox.window.__calculatorCloudSaveState.tone, 'retrying');
  assert.equal(attempt, 1);
  check.timer(3125); await pending; await tick();
  assert.equal(attempt, 2);
  assert.equal(check.sandbox.window.__calculatorCloudSaveState.tone, 'saved');
}

// Timeout races both an unresolving fetch and an unresolving response body. Abort may
// be ignored by the transport; the logical lock still clears and a scheduled retry runs.
for (const hangsInBody of [false, true]) {
  const check = browser();
  let release;
  let firstSignal;
  check.setResponder((_url, options) => {
    if (!firstSignal) {
      firstSignal = options.signal;
      return hangsInBody
        ? Promise.resolve({ ok: true, status: 200, json: () => new Promise(resolve => { release = resolve; }) })
        : new Promise(resolve => { release = resolve; });
    }
    return Promise.resolve(success());
  });
  check.edit('timeout');
  const pending = check.sandbox.window.__calculatorFlushCloudSave(60000);
  await tick();
  check.timer(12000); await tick();
  assert.equal(firstSignal.aborted, true, 'deadline aborts the request signal');
  assert.equal(check.sandbox.window.__calculatorCloudSaveState.tone, 'retrying');
  check.timer(3125); await pending; await tick();
  assert.equal(check.calls.length, 2, 'retry starts after deadline even if fetch/body ignores abort');
  if (release) release(success());
}

// Conflict is a hard fence. Recovery UI/API cannot silently resume this snapshot.
const conflict = browser();
conflict.setResponder(async () => ({ ok: false, status: 409, json: async () => ({ code: 'QUOTE_OPTION_CONFLICT', error: 'Review quote options' }) }));
conflict.edit('conflict');
await assert.rejects(conflict.sandbox.window.__calculatorFlushCloudSave(60000), /Review quote options/);
assert.equal(conflict.sandbox.window.__calculatorQuoteConflict.code, 'QUOTE_OPTION_CONFLICT');
conflict.periodic();
assert.equal(conflict.calls.length, 1);
assert.deepEqual(conflict.unload(), { prevented: true, returnValue: '' });
assert.equal(conflict.beacons.length, 0);
await assert.rejects(conflict.sandbox.window.__calculatorFlushCloudSave(60000), /Review quote options/);

// A clean, acknowledged snapshot leaves without a warning/beacon. Repeated manual
// flush of the same in-flight snapshot joins its acknowledgement, not a second PUT.
const clean = browser();
let finish;
clean.setResponder(() => new Promise(resolve => { finish = resolve; }));
clean.edit('once');
const first = clean.sandbox.window.__calculatorFlushCloudSave(60000);
await tick();
assert.deepEqual(clean.unload(), { prevented: true, returnValue: '' }, 'in-flight request warns before leaving');
assert.equal(clean.beacons.length, 0, 'in-flight request never races with unload beacon');
const joined = clean.sandbox.window.__calculatorFlushCloudSave(60000);
await tick();
assert.equal(clean.calls.length, 1, 'manual flush joins same in-flight payload');
finish(success());
await Promise.all([first, joined]); await tick();
assert.equal(clean.calls.length, 1, 'successful acknowledgement causes no extra PUT');
assert.deepEqual(clean.unload(), { prevented: false, returnValue: undefined });
assert.equal(clean.beacons.length, 0, 'unchanged acknowledged state has no unload beacon');

// The session recovery stash is a complete request envelope and is removed only
// when that exact envelope is acknowledged; a newer pending envelope survives an
// older in-flight acknowledgement.
const recoverySession = new Map();
const envelopeBrowser = browser({
  cloud: { draft: 'seed', installerManagedPricesV1: JSON.stringify({ model: { unitPriceInc: 150 } }) },
  session: recoverySession,
});
envelopeBrowser.sandbox.window.aadEquipmentPriceEditSnapshot = () => ({ model: { before: 100, after: 150 } });
let resolveFirstEnvelope, resolveSecondEnvelope;
envelopeBrowser.setResponder(() => new Promise(resolve => {
  if (!resolveFirstEnvelope) resolveFirstEnvelope = resolve;
  else resolveSecondEnvelope = resolve;
}));
envelopeBrowser.edit('envelope-old');
const firstEnvelopeAck = envelopeBrowser.sandbox.window.__calculatorFlushCloudSave(60000);
await tick();
const stashKey = recoveryKey();
const oldStash = JSON.parse(recoverySession.get(stashKey));
assert.equal(oldStash.version, 1);
assert.equal(oldStash.profile, stashKey);
assert.equal(oldStash.envelope.data.draft, 'envelope-old');
assert.deepEqual(JSON.parse(JSON.stringify(oldStash.envelope.equipmentPriceEdits)), { model: { before: 100, after: 150 } });
assert.deepEqual(JSON.parse(JSON.stringify(oldStash.envelope.expectedWorkspace)), {
  accountEmail: 'fixture@example.test', viewingEmail: 'fixture@example.test', businessId: '11111111-1111-4111-8111-111111111111',
});
envelopeBrowser.edit('envelope-new');
const secondEnvelopeAck = envelopeBrowser.sandbox.window.__calculatorFlushCloudSave(60000);
await tick();
assert.equal(envelopeBrowser.calls.length, 1, 'newer snapshot waits behind active request');
assert.equal(JSON.parse(recoverySession.get(stashKey)).envelope.data.draft, 'envelope-new');
resolveFirstEnvelope(success());
await firstEnvelopeAck; await tick();
assert.equal(envelopeBrowser.calls.length, 2);
assert.equal(JSON.parse(recoverySession.get(stashKey)).envelope.data.draft, 'envelope-new', 'old ack cannot clear newer recovery record');
resolveSecondEnvelope(success());
await secondEnvelopeAck; await tick();
assert.equal(recoverySession.has(stashKey), false, 'matching acknowledgement clears its recovery record');

// A new page with the same tab-scoped identity sees the stash, pauses all saves,
// and leaves the just-loaded cloud quote untouched rather than replaying old data.
const interruptedSession = new Map();
const interrupted = browser({
  cloud: { draft: 'cloud-current', installerMasterQuoteLogV1: JSON.stringify([{ id: 'cloud-row', model: 'CLOUD' }]) },
  session: interruptedSession,
});
interrupted.setResponder(() => new Promise(() => {}));
interrupted.edit('unsent-old');
interrupted.sandbox.window.__calculatorFlushCloudSave(60000).catch(() => {});
await tick();
const interruptedKey = recoveryKey();
const interruptedStash = interruptedSession.get(interruptedKey);
assert.ok(interruptedStash, 'attempted save persisted pending envelope in tab session storage');
const savedCloudRows = JSON.stringify([{ id: 'cloud-row', model: 'CLOUD' }]);
const normalizedRows = JSON.stringify([{ id: 'cloud-row', model: 'CLOUD', optionId: 'option_1', syncUpdatedAt: 99 }]);
const reloaded = browser({
  cloud: { draft: 'cloud-current', installerMasterQuoteLogV1: savedCloudRows },
  session: interruptedSession,
  startupStorage: { installerMasterQuoteLogV1: normalizedRows },
});
const cloudQuote = reloaded.sandbox.localStorage.getItem('installerMasterQuoteLogV1');
const writesAfterBootstrap = reloaded.storageWrites.length;
await reloaded.sandbox.window.__calculatorFlushCloudSave(60000);
reloaded.input(); reloaded.periodic(); await tick();
assert.equal(reloaded.calls.length, 0, 'recovery startup does not send its old draft or normalize saved quotes on the server');
assert.equal(reloaded.sandbox.localStorage.getItem('installerMasterQuoteLogV1'), cloudQuote, 'old pending quote never overwrites loaded cloud quote');
assert.equal(reloaded.storageWrites.length, writesAfterBootstrap, 'recovery performs no idle app-storage writes');
assert.equal(interruptedSession.get(interruptedKey), interruptedStash);
assert.equal(reloaded.sandbox.window.__calculatorCanRefresh(), true, 'a retained older draft does not block refresh');
reloaded.storage.set('draft', 'another tab unconfirmed');
reloaded.storage.set('installerMasterQuoteLogV1', '[{"id":"other-tab-quote","netProfit":999}]');
reloaded.periodic(); await tick();
assert.equal(reloaded.calls.length, 0, 'a same-workspace tab cannot upload edits through the recovered tab');
assert.equal(reloaded.sandbox.localStorage.getItem('draft'), 'cloud-current', 'review uses the isolated authoritative baseline');
reloaded.edit('fresh-edit');
await reloaded.sandbox.window.__calculatorFlushCloudSave(60000); await tick();
assert.equal(reloaded.calls[0].body.data.draft, 'fresh-edit');
assert.equal(reloaded.calls[0].body.data.installerMasterQuoteLogV1, savedCloudRows, 'an unrelated save leaves the authoritative quote untouched');
assert.equal(interruptedSession.get(interruptedKey), interruptedStash, 'saving new work cannot clear the old slot');
reloaded.sandbox.localStorage.setItem('installerMasterQuoteLogV1', JSON.stringify([...JSON.parse(normalizedRows), { id: 'fresh-row', model: 'NEW' }]));
await reloaded.sandbox.window.__calculatorFlushCloudSave(60000); await tick();
assert.deepEqual(JSON.parse(reloaded.calls.at(-1).body.data.installerMasterQuoteLogV1), [...JSON.parse(savedCloudRows), { id: 'fresh-row', model: 'NEW' }]);
assert.equal(interruptedSession.get(interruptedKey), interruptedStash, 'adding another quote leaves the older draft intact');
const generatedDef = { id: 'option_1', name: 'Quote 1', syncUpdatedAt: 99 };
const freshDef = { id: 'new-quote', name: 'New quote', syncUpdatedAt: 100 };
const noDefinitions = browser({
  cloud: { installerMasterQuoteLogV1: savedCloudRows }, session: interruptedSession,
  startupStorage: { installerMasterQuoteLogV1: normalizedRows, installerQuoteOptionDefsV1: JSON.stringify([generatedDef]) },
});
noDefinitions.sandbox.localStorage.setItem('installerQuoteOptionDefsV1', JSON.stringify([generatedDef, freshDef]));
await noDefinitions.sandbox.window.__calculatorFlushCloudSave(60000); await tick();
assert.deepEqual(JSON.parse(noDefinitions.calls[0].body.data.installerQuoteOptionDefsV1), [freshDef], 'new work does not publish startup-generated quote definitions');
const addToLegacyQuote = browser({
  cloud: { installerMasterQuoteLogV1: savedCloudRows }, session: interruptedSession,
  startupStorage: { installerMasterQuoteLogV1: normalizedRows, installerQuoteOptionDefsV1: JSON.stringify([generatedDef]) },
});
addToLegacyQuote.sandbox.localStorage.setItem('installerMasterQuoteLogV1', JSON.stringify([
  ...JSON.parse(normalizedRows), { id: 'new-system', model: 'NEW', optionId: generatedDef.id },
]));
await addToLegacyQuote.sandbox.window.__calculatorFlushCloudSave(60000); await tick();
assert.deepEqual(JSON.parse(addToLegacyQuote.calls[0].body.data.installerQuoteOptionDefsV1), [generatedDef], 'a new system retains the generated definition it actually needs');

const scopedEnvelope = JSON.parse(interruptedStash);
const committed = structuredClone(scopedEnvelope);
committed.envelope.data = { draft: '{"b":2,"a":1}' };
const committedSession = new Map([[interruptedKey, JSON.stringify(committed)]]);
const alreadySaved = browser({ cloud: { draft: '{"a":1,"b":2}' }, session: committedSession });
assert.equal(committedSession.size, 0, 'an exact authoritative match clears only its recorded slot');
alreadySaved.periodic(); await tick();
assert.equal(alreadySaved.calls.length, 0, 'confirmation uses the saved read, not a write');
const priceDraft = structuredClone(committed);
priceDraft.envelope.equipmentPriceEdits = { test: { before: 500, after: 600 } };
const extraDraft = structuredClone(committed);
extraDraft.envelope.data.notPresentInCloud = 'draft only';
const wrongWorkspaceDraft = structuredClone(committed);
wrongWorkspaceDraft.envelope.expectedWorkspace.businessId = '22222222-2222-4222-8222-222222222222';
for (const kept of [priceDraft, extraDraft, wrongWorkspaceDraft]) {
  const records = new Map([[interruptedKey, JSON.stringify(kept)]]);
  browser({ cloud: { draft: '{"a":1,"b":2}' }, session: records });
  assert.equal(records.get(interruptedKey), JSON.stringify(kept), 'a price edit, missing data, or workspace mismatch is not silently cleared');
}
const parkedSlot = interruptedKey + ':draft:legacy-test';
const rollbackSession = new Map([[interruptedKey, JSON.stringify(committed)], [parkedSlot, JSON.stringify(priceDraft)]]);
browser({ cloud: { draft: '{"a":1,"b":2}' }, session: rollbackSession });
assert.equal(JSON.parse(rollbackSession.get(interruptedKey)).compatibilityMarker, true, 'pre-upgrade code can still detect outstanding recovery after the legacy slot is confirmed');
assert.equal(rollbackSession.get(parkedSlot), JSON.stringify(priceDraft));

const hydrationFailure = browser({ session: interruptedSession, initialStorage: { draft: 'stale local' }, initialStorageFailure: { set: true } });
await assert.rejects(hydrationFailure.sandbox.window.__calculatorFlushCloudSave(60000), /Reopen this workspace/);
hydrationFailure.periodic(); await tick();
assert.equal(hydrationFailure.calls.length, 0, 'an incomplete saved baseline cannot be written back');

const newFailure = browser({ session: interruptedSession, cloud: { draft: 'cloud-current' } });
newFailure.setResponder(() => new Promise(() => {}));
newFailure.edit('second unsaved draft');
void newFailure.sandbox.window.__calculatorFlushCloudSave(60000).catch(() => {});
await tick();
const newSlot = [...interruptedSession.keys()].find(key => key.startsWith(interruptedKey + ':draft:'));
assert.ok(newSlot);
assert.equal(JSON.parse(interruptedSession.get(newSlot)).envelope.data.draft, 'second unsaved draft');
const fullStorage = browser({ session: interruptedSession, cloud: { draft: 'cloud-current' } });
fullStorage.sessionFailure.set = true;
fullStorage.setResponder(() => new Promise(() => {}));
fullStorage.edit('new edit despite quota');
void fullStorage.sandbox.window.__calculatorFlushCloudSave(60000).catch(() => {});
await tick();
assert.equal(fullStorage.calls[0].body.data.draft, 'new edit despite quota');
assert.equal(fullStorage.sandbox.window.__calculatorCanRefresh(), false);
assert.equal(interruptedSession.get(interruptedKey), interruptedStash);
assert.equal(JSON.parse(interruptedSession.get(newSlot)).envelope.data.draft, 'second unsaved draft', 'quota failure never evicts earlier drafts');
const retiredFullTab = browser();
retiredFullTab.sessionFailure.set = true;
let failRetiredSave;
retiredFullTab.setResponder(() => new Promise((resolve, reject) => { failRetiredSave = reject; }));
retiredFullTab.edit('only copy of draft in memory');
void retiredFullTab.sandbox.window.__calculatorFlushCloudSave(60000).catch(() => {});
await tick();
const backedUp = [];
const status = { dataset: {}, children: [], set textContent(value) { this.children = []; }, setAttribute() {}, appendChild(child) { this.children.push(child); } };
retiredFullTab.sandbox.document.body = {};
retiredFullTab.sandbox.document.getElementById = id => id === 'cloudSaveStatus' ? status : null;
retiredFullTab.sandbox.document.createElement = () => ({ click() {} });
retiredFullTab.sandbox.URL = { createObjectURL(blob) { backedUp.push(blob); return 'blob:fixture'; }, revokeObjectURL() {} };
retiredFullTab.storage.set('__calculatorRecoveryIsolatedCache', '1');
retiredFullTab.windowHandlers.get('storage')({ key: '__calculatorRecoveryIsolatedCache' });
failRetiredSave(new Error('late connection failure'));
await tick();
const backup = status.children.find(child => child.textContent === 'Back up');
assert.ok(backup, 'retired tab still offers a backup when recovery storage is full');
backup.onclick();
assert.match(await backedUp[0].text(), /only copy of draft in memory/);
retiredFullTab.storage.set('__calculatorSignedInEmail', 'other@example.test');
backup.onclick();
assert.equal(backedUp.length, 1, 'old backup control cannot export after an actual account change');

const emptyCloudRecovery = browser({
  cloud: {}, session: interruptedSession,
  initialStorage: {
    __calculatorSignedInEmail: 'fixture@example.test',
    __calculatorProfileEmail: 'fixture@example.test|11111111-1111-4111-8111-111111111111',
    draft: 'old-local-draft',
    installerMasterQuoteLogV1: JSON.stringify([{ id: 'old-local-row', model: 'OLD-LOCAL' }]),
  },
});
assert.equal(emptyCloudRecovery.sandbox.localStorage.getItem('installerMasterQuoteLogV1'), null, 'a verified empty cloud does not hydrate a stale local quote');
assert.equal(emptyCloudRecovery.sandbox.localStorage.getItem('draft'), null, 'a verified empty cloud does not backfill an old draft');
assert.equal(emptyCloudRecovery.storage.get('draft'), 'old-local-draft', 'isolated hydration does not wipe shared local edits');
const backfillTimer = [...emptyCloudRecovery.timeouts.values()].find(timer => timer.ms === 1000);
if (backfillTimer) emptyCloudRecovery.timer(1000);
await tick();
assert.equal(emptyCloudRecovery.calls.length, 0, 'empty-cloud recovery never uploads cleared old local data');
assert.equal(interruptedSession.get(interruptedKey), interruptedStash, 'pending recovery remains available for review');
const freshSameWorkspace = browser({ cloud: {}, initialStorage: Object.fromEntries(emptyCloudRecovery.storage) });
assert.equal(freshSameWorkspace.sandbox.localStorage.getItem('installerMasterQuoteLogV1'), null, 'a new tab cannot display the same workspace\'s old native draft');
freshSameWorkspace.edit('fresh tab edit');
await freshSameWorkspace.sandbox.window.__calculatorFlushCloudSave(60000); await tick();
assert.doesNotMatch(JSON.stringify(freshSameWorkspace.calls[0].body), /OLD-LOCAL|old-local-draft/, 'a new tab cannot upload the old native draft');
assert.equal(interruptedSession.get(interruptedKey), interruptedStash);
const olderTab = browser();
olderTab.storage.set('draft', 'another tab\'s unconfirmed edit');
olderTab.storage.set('__calculatorRecoveryIsolatedCache', '1');
olderTab.windowHandlers.get('storage')({ key: '__calculatorRecoveryIsolatedCache' });
olderTab.periodic(); await tick();
assert.equal(olderTab.calls.length, 0, 'a previously opened tab cannot autosave the retired shared cache');
await assert.rejects(olderTab.sandbox.window.__calculatorFlushCloudSave(60000), /Reopen this workspace/);
const oldNativeQuote = '[{"id":"previously-failed","model":"FAILED-NATIVE-QUOTE"}]';
const parkedNativeDraft = structuredClone(scopedEnvelope);
parkedNativeDraft.envelope.data = { installerMasterQuoteLogV1: oldNativeQuote, draft: 'captured before reload' };
const parkedNativeSession = new Map([[interruptedKey, JSON.stringify(parkedNativeDraft)]]);
const clearedNative = browser({
  cloud: {}, session: parkedNativeSession, initialStorage: {
    __calculatorSignedInEmail: 'fixture@example.test',
    __calculatorProfileEmail: 'fixture@example.test|11111111-1111-4111-8111-111111111111',
    installerMasterQuoteLogV1: oldNativeQuote,
    draft: 'different and newer local work',
  },
});
assert.equal(clearedNative.storage.has('installerMasterQuoteLogV1'), false, 'older readers cannot pick up the already preserved draft');
assert.equal(clearedNative.storage.get('draft'), 'different and newer local work', 'cleanup leaves unmatched native values alone');
assert.equal(parkedNativeSession.get(interruptedKey), JSON.stringify(parkedNativeDraft), 'cache cleanup never removes the preserved draft');
const olderReader = browser({ cloud: {}, initialStorage: Object.fromEntries([...clearedNative.storage].filter(([key]) => key !== '__calculatorRecoveryIsolatedCache')) });
olderReader.edit('new user edit');
await olderReader.sandbox.window.__calculatorFlushCloudSave(60000); await tick();
assert.doesNotMatch(JSON.stringify(olderReader.calls[0].body), /FAILED-NATIVE-QUOTE/, 'even a reader without the marker cannot replay the parked quote');
const foreignCache = browser({
  cloud: {}, session: interruptedSession,
  initialStorage: {
    __calculatorSignedInEmail: 'another@example.test',
    __calculatorProfileEmail: 'another@example.test|22222222-2222-4222-8222-222222222222',
    installerMasterQuoteLogV1: '[{"id":"foreign-row","model":"DO-NOT-IMPORT"}]',
  },
});
assert.equal(foreignCache.storage.has('installerMasterQuoteLogV1'), false, 'a recovered workspace cannot relabel another account\'s native cache');
const freshTab = browser({ cloud: {}, initialStorage: Object.fromEntries(foreignCache.storage) });
assert.equal(freshTab.sandbox.localStorage.getItem('installerMasterQuoteLogV1'), null);
freshTab.edit('new account edit');
await freshTab.sandbox.window.__calculatorFlushCloudSave(60000); await tick();
assert.doesNotMatch(JSON.stringify(freshTab.calls[0].body), /DO-NOT-IMPORT/);

// Recovery keys prefix the unchanged legacy viewing-profile marker with account.
// Neither account nor business may consume another workspace's envelope.
for (const otherIdentity of [
  { email: 'other@example.test', businessId: '11111111-1111-4111-8111-111111111111' },
  { email: 'fixture@example.test', businessId: '22222222-2222-4222-8222-222222222222' },
]) {
  const sharedSession = new Map([[interruptedKey, interruptedStash]]);
  const isolated = browser({ cloud: { draft: 'other-cloud' }, session: sharedSession, ...otherIdentity });
  isolated.setResponder(async () => success());
  isolated.edit('other-workspace-draft');
  await isolated.sandbox.window.__calculatorFlushCloudSave(60000); await tick();
  assert.equal(isolated.calls.length, 1, 'different identity is not blocked by another identity recovery');
  assert.equal(isolated.calls[0].body.data.draft, 'other-workspace-draft');
  assert.equal(isolated.calls[0].body.expectedWorkspace.accountEmail, otherIdentity.email);
  assert.equal(isolated.calls[0].body.expectedWorkspace.businessId, otherIdentity.businessId);
  assert.equal(sharedSession.get(interruptedKey), interruptedStash, 'other identity cannot clear original recovery data');
}

// Startup claims the signed-in account marker before the legacy profile marker,
// clear, and hydrate. This covers an account switch with the same view/business.
const startupProfile = 'fixture@example.test|11111111-1111-4111-8111-111111111111';
const startup = browser({
  email: 'other@example.test', viewingEmail: 'fixture@example.test',
  businessId: '11111111-1111-4111-8111-111111111111',
  cloud: { draft: 'account-b-cloud', installerMasterQuoteLogV1: JSON.stringify([{ id: 'b-row', model: 'ACCOUNT-B' }]) },
  initialStorage: {
    __calculatorSignedInEmail: 'fixture@example.test',
    __calculatorProfileEmail: startupProfile,
    draft: 'account-a-local',
    installerMasterQuoteLogV1: JSON.stringify([{ id: 'a-row', model: 'ACCOUNT-A' }]),
  },
});
const accountMarkerIndex = startup.storageWrites.findIndex(([action, key, value]) => action === 'set' && key === '__calculatorSignedInEmail' && value === 'other@example.test');
const markerWriteIndex = startup.storageWrites.findIndex(([action, key, value]) => action === 'set' && key === '__calculatorProfileEmail' && value === startupProfile);
const firstOldDataRemoval = startup.storageWrites.findIndex(([action, key]) => action === 'remove' && key === 'installerMasterQuoteLogV1');
const businessBHydrate = startup.storageWrites.findIndex(([action, key, value]) => action === 'set' && key === 'installerMasterQuoteLogV1' && value.includes('b-row'));
assert.ok(accountMarkerIndex >= 0 && accountMarkerIndex < markerWriteIndex && markerWriteIndex < firstOldDataRemoval && firstOldDataRemoval < businessBHydrate,
  'account then legacy profile markers are claimed before clearing and hydrating same-view/business account data');
assert.equal(startup.storage.get('installerMasterQuoteLogV1'), JSON.stringify([{ id: 'b-row', model: 'ACCOUNT-B' }]));

// Missing account marker is a legacy state, not evidence of an account change;
// preserve existing data when the legacy viewing-profile marker still matches.
const legacyNoAccountMarker = browser({
  email: 'other@example.test', viewingEmail: 'fixture@example.test',
  businessId: '11111111-1111-4111-8111-111111111111', cloud: {},
  initialStorage: { __calculatorProfileEmail: startupProfile, draft: 'legacy-shared-data' },
});
assert.equal(legacyNoAccountMarker.storage.get('draft'), 'legacy-shared-data', 'missing legacy account marker does not clear app data');

// Quote-arrangement recovery is persisted before the mutation request. Only a
// valid response plus the exact saveId acknowledgement may clear that envelope.
const arrangementSession = new Map();
const arrangement = browser({ session: arrangementSession });
const arrangePayload = {
  saveId: 'arrange-save-1', optionId: 'quote-a', targetOptionId: 'quote-b', rowId: 'row-1',
  expected: { defs: [], rows: [] },
};
let resolveArrange;
arrangement.setResponder(() => new Promise(resolve => { resolveArrange = resolve; }));
const arrangePromise = arrangement.sandbox.window.__calculatorQuoteRequest('quoteArrange', arrangePayload);
await tick();
const arrangeKey = recoveryKey();
const arrangeStash = JSON.parse(arrangementSession.get(arrangeKey));
assert.deepEqual(JSON.parse(JSON.stringify(arrangeStash.envelope.quoteArrange)), arrangePayload, 'arrangement is stashed before request is sent');
assert.equal(arrangement.sandbox.window.__calculatorAcknowledgeQuoteArrange('arrange-save-1'), false, 'in-flight mutation cannot be acknowledged');
resolveArrange({ ok: true, status: 200, json: async () => ({
  ok: true, defs: [{ id: 'quote-a' }, { id: 'quote-b' }], rows: [{ id: 'row-1', optionId: 'quote-b' }],
  removedOptionIds: [], removedRowIds: [],
}) });
await arrangePromise; await tick();
assert.equal(arrangementSession.has(arrangeKey), true, 'valid response alone leaves recovery envelope until caller patches local state');
assert.equal(arrangement.sandbox.window.__calculatorAcknowledgeQuoteArrange('wrong-save-id'), false);
assert.equal(arrangementSession.has(arrangeKey), true, 'wrong saveId cannot clear pending arrangement');
assert.equal(arrangement.sandbox.window.__calculatorAcknowledgeQuoteArrange('arrange-save-1'), true);
assert.equal(arrangementSession.has(arrangeKey), false, 'matching acknowledgement clears arrangement envelope');
assert.equal(arrangement.sandbox.window.__calculatorAcknowledgeQuoteArrange('arrange-save-1'), false, 'duplicate acknowledgement is rejected');

for (const kind of ['quoteEdit', 'quoteCopy']) {
  const mutationSession = new Map();
  const mutation = browser({ session: mutationSession });
  const payload = kind === 'quoteEdit'
    ? { saveId: 'edit-save-1', rowId: 'row-1', optionId: 'option-1', patch: { model: 'UPDATED' } }
    : { saveId: 'copy-save-1', sourceOptionId: 'option-1', name: 'Customer copy' };
  let calls = 0, resolveRetry;
  mutation.setResponder(() => {
    calls += 1;
    if (calls === 1) return Promise.reject(new Error('response lost'));
    return new Promise(resolve => { resolveRetry = resolve; });
  });
  const lostMutation = mutation.sandbox.window.__calculatorQuoteRequest(kind, payload).catch(error => error);
  await tick();
  assert.match((await lostMutation)?.message || '', /response lost/);
  const key = recoveryKey();
  const pending = JSON.parse(mutationSession.get(key));
  assert.deepEqual(JSON.parse(JSON.stringify(pending.envelope[kind])), payload, `${kind} envelope is stashed before sending`);

  mutation.edit(`${kind}-local-edit`);
  mutation.periodic();
  assert.deepEqual(mutation.unload(), { prevented: true, returnValue: '' });
  assert.equal(mutation.beacons.length, 0, `${kind} pending request suppresses unload beacon`);
  assert.equal(calls, 1, `${kind} pending request fences periodic autosave`);
  assert.deepEqual(JSON.parse(mutationSession.get(key)).envelope[kind], payload, 'local edits cannot replace pending mutation recovery');
  await assert.rejects(mutation.sandbox.window.__calculatorQuoteRequest(kind, { ...payload, saveId: 'different-save' }), /pending option change/);

  const retry = mutation.sandbox.window.__calculatorQuoteRequest(kind, payload);
  await tick();
  assert.equal(calls, 2, 'only identical payload can retry, without an autosave preflush');
  assert.deepEqual(JSON.parse(mutationSession.get(key)).envelope[kind], payload);
  assert.equal(mutation.sandbox.window.__calculatorAcknowledgeQuoteMutation(kind, payload.saveId), false);
  const result = kind === 'quoteEdit'
    ? { ok: true, row: { id: 'row-1', optionId: 'option-1' } }
    : { ok: true, def: { id: 'copy-1' }, rows: [{ id: 'copy-row', optionId: 'copy-1' }] };
  resolveRetry({ ok: true, status: 200, json: async () => result });
  await retry; await tick();
  assert.equal(mutationSession.has(key), true, 'response does not clear mutation recovery before local patch ack');
  assert.equal(mutation.sandbox.window.__calculatorAcknowledgeQuoteMutation(kind === 'quoteEdit' ? 'quoteCopy' : 'quoteEdit', payload.saveId), false);
  assert.equal(mutation.sandbox.window.__calculatorAcknowledgeQuoteMutation(kind, 'wrong-save-id'), false);
  assert.equal(mutationSession.has(key), true);
  assert.equal(mutation.sandbox.window.__calculatorAcknowledgeQuoteMutation(kind, payload.saveId), true);
  assert.equal(mutationSession.has(key), false, 'matching UI acknowledgement clears mutation recovery');
}

// A cross-tab profile switch fences both captured and future values: no newer
// workspace draft is written locally or sent to the old account/business URL.
// The viewing/business profile remains legacy-shaped; switch only the account marker.
const preDebounceSession = new Map();
const preDebounce = browser({ session: preDebounceSession });
preDebounce.edit('captured-account-a-before-debounce');
const preDebounceKey = recoveryKey();
const capturedEnvelope = JSON.parse(preDebounceSession.get(preDebounceKey));
assert.equal(capturedEnvelope.envelope.data.draft, 'captured-account-a-before-debounce', 'local edit is stashed synchronously before debounce');
assert.deepEqual(JSON.parse(JSON.stringify(capturedEnvelope.envelope.expectedWorkspace)), {
  accountEmail: 'fixture@example.test', viewingEmail: 'fixture@example.test', businessId: '11111111-1111-4111-8111-111111111111',
});
assert.equal(preDebounce.calls.length, 0);
preDebounce.storage.set('__calculatorSignedInEmail', 'account-b@example.test');
preDebounce.profileChanged();
const preDebounceWrites = preDebounce.storageWrites.length;
preDebounce.edit('account-b-draft');
preDebounce.timer(700); preDebounce.periodic(); await tick();
assert.equal(preDebounce.storageWrites.length, preDebounceWrites, 'account switch fences B local writes before debounce fires');
assert.equal(preDebounce.calls.length, 0, 'neither captured A data nor B data is uploaded after switch');
assert.equal(JSON.parse(preDebounceSession.get(preDebounceKey)).envelope.data.draft, 'captured-account-a-before-debounce');
assert.equal(preDebounce.beacons.length, 0);

const fenced = browser();
fenced.setResponder(async () => unavailable());
fenced.edit('account-a-pending');
const fencedConfirmation = fenced.sandbox.window.__calculatorFlushCloudSave(60000).catch(error => error);
await tick();
assert.equal(fenced.calls.length, 1);
const fencedOriginalEnvelope = JSON.parse(fenced.session.get(recoveryKey()));
fenced.storage.set('__calculatorSignedInEmail', 'account-b@example.test');
fenced.profileChanged();
await fencedConfirmation;
const writesBeforeBlockedEdit = fenced.storageWrites.length;
fenced.edit('account-b-draft');
fenced.periodic(); await tick();
await assert.rejects(fenced.sandbox.window.__calculatorFlushCloudSave(60000), /Reopen this workspace/);
assert.equal(fenced.storageWrites.length, writesBeforeBlockedEdit, 'profile fence blocks further local app-storage writes');
assert.equal(fenced.calls.length, 1, 'no save or retry is sent after profile switch');
assert.equal(fenced.calls[0].body.expectedWorkspace.accountEmail, 'fixture@example.test');
assert.equal(fenced.calls[0].body.data.draft, 'account-a-pending', 'account B draft never reaches account A URL');
assert.deepEqual(JSON.parse(fenced.session.get(recoveryKey())), fencedOriginalEnvelope, 'A recovery envelope stays isolated and intact');

// A terminal 401 on the exact retry cannot disprove a previous copy mutation:
// retain the original envelope/fence through reload, then recover only that ID.
const lostCopySession = new Map();
const lostCopy = browser({ session: lostCopySession, cloud: { draft: 'saved-cloud', installerMasterQuoteLogV1: JSON.stringify([{ id: 'saved-row', model: 'SAVED' }]) } });
const lostCopyPayload = { saveId: 'copy-original-id', sourceOptionId: 'option-original', name: 'Original copy' };
let lostCopyCalls = 0;
lostCopy.setResponder(async () => {
  lostCopyCalls += 1;
  if (lostCopyCalls === 1) throw new Error('response lost after possible commit');
  if (lostCopyCalls === 2) return { ok: false, status: 401, json: async () => ({ error: 'Authentication expired' }) };
  return { ok: true, status: 200, json: async () => ({ ok: true, def: { id: 'copy-original-id' }, rows: [{ id: 'copy-row', optionId: 'copy-original-id' }] }) };
});
await assert.rejects(lostCopy.sandbox.window.__calculatorQuoteRequest('quoteCopy', lostCopyPayload), /response lost/);
const lostCopyKey = recoveryKey();
const originalCopyEnvelope = lostCopySession.get(lostCopyKey);
assert.equal(JSON.parse(originalCopyEnvelope).envelope.quoteCopy.saveId, lostCopyPayload.saveId);
assert.ok(Number.isFinite(Date.parse(JSON.parse(originalCopyEnvelope).savedAt)), 'initial copy recovery savedAt is valid');
await assert.rejects(lostCopy.sandbox.window.__calculatorQuoteRequest('quoteCopy', lostCopyPayload), /Authentication expired/);
assert.equal(lostCopy.sandbox.window.__calculatorHasPendingQuoteRequest(), true, '401 retry keeps the original mutation fence');
assertRecoverySemantic(lostCopySession.get(lostCopyKey), originalCopyEnvelope, '401 retry preserves original profile and mutation envelope');
lostCopy.edit('edit-during-uncertain-copy'); lostCopy.periodic();
assert.deepEqual(lostCopy.unload(), { prevented: true, returnValue: '' });
assert.equal(lostCopy.beacons.length, 0);
await assert.rejects(lostCopy.sandbox.window.__calculatorQuoteRequest('quoteCopy', { ...lostCopyPayload, saveId: 'new-copy-id' }), /pending option change/);
await assert.rejects(lostCopy.sandbox.window.__calculatorQuoteRequest('quoteEdit', { saveId: 'new-kind-id' }), /pending option change/);
assert.equal(lostCopyCalls, 2, 'no changed mutation reaches the endpoint while original copy outcome is uncertain');

const lostCopyReload = browser({
  session: lostCopySession,
  cloud: { draft: 'saved-cloud', installerMasterQuoteLogV1: JSON.stringify([{ id: 'saved-row', model: 'SAVED' }]) },
});
const savedRowsOnReload = lostCopyReload.sandbox.localStorage.getItem('installerMasterQuoteLogV1');
await lostCopyReload.sandbox.window.__calculatorFlushCloudSave(60000);
lostCopyReload.periodic(); await tick();
assert.equal(lostCopyReload.calls.length, 0, 'reload does not replay an unconfirmed copy');
assert.equal(lostCopyReload.sandbox.localStorage.getItem('installerMasterQuoteLogV1'), savedRowsOnReload, 'reload retains saved cloud quote without replaying uncertain local mutation');
assertRecoverySemantic(lostCopySession.get(lostCopyKey), originalCopyEnvelope, 'reload preserves original profile and mutation envelope');

const originalCopyRecovery = lostCopy.sandbox.window.__calculatorQuoteRequest('quoteCopy', lostCopyPayload);
await tick();
assert.equal(lostCopyCalls, 3, 'recovery retries only the original copy ID');
await originalCopyRecovery; await tick();
assert.equal(lostCopySession.has(lostCopyKey), true, 'recovered response alone retains the envelope until UI acknowledgement');
assert.equal(lostCopy.sandbox.window.__calculatorAcknowledgeQuoteMutation('quoteCopy', lostCopyPayload.saveId), true);
assert.equal(lostCopySession.has(lostCopyKey), false, 'recovered original response plus matching acknowledgement clears the fence');

// The release notice is advisory and may offer a reload only after durable saves.
const refresh = browser();
assert.equal(refresh.sandbox.window.__calculatorCanRefresh(), true, 'acknowledged initial workspace permits explicit refresh');
refresh.edit('not-yet-saved');
assert.equal(refresh.sandbox.window.__calculatorCanRefresh(), false, 'dirty local edits block refresh before the debounce');
await refresh.sandbox.window.__calculatorFlushCloudSave(60000); await tick();
assert.equal(refresh.sandbox.window.__calculatorCanRefresh(), true, 'confirmed save permits refresh');
refresh.sandbox.window.aadEquipmentPriceEditSnapshot = () => ({ pending: true });
assert.equal(refresh.sandbox.window.__calculatorCanRefresh(), false, 'unacknowledged equipment price edits block refresh');
refresh.sandbox.window.aadEquipmentPriceEditSnapshot = () => { throw new Error('unavailable'); };
assert.equal(refresh.sandbox.window.__calculatorCanRefresh(), false, 'guard errors fail closed');
assert.equal(conflict.sandbox.window.__calculatorCanRefresh(), false, 'quote conflict blocks refresh');
assert.equal(fenced.sandbox.window.__calculatorCanRefresh(), false, 'changed workspace blocks refresh');
assert.equal(lostCopyReload.sandbox.window.__calculatorCanRefresh(), true, 'an archived copy does not block refresh');
const refreshingMutation = browser();
refreshingMutation.setResponder(() => new Promise(() => {}));
void refreshingMutation.sandbox.window.__calculatorQuoteRequest('quoteCopy', { saveId: 'refresh-copy', sourceOptionId: 'option-1' });
await tick();
assert.equal(refreshingMutation.sandbox.window.__calculatorCanRefresh(), false, 'in-flight quote mutation blocks refresh');
const refreshingSave = browser();
refreshingSave.setResponder(() => new Promise(() => {}));
refreshingSave.edit('saving');
void refreshingSave.sandbox.window.__calculatorFlushCloudSave(60000);
await tick();
assert.equal(refreshingSave.sandbox.window.__calculatorCanRefresh(), false, 'in-flight cloud save blocks refresh');
for (const flag of ['currentQuoteTotalsEditing', 'quoteLibraryEdit', 'quoteArrangeBusy', 'quoteArrangePending']) {
  const editor = browser(); editor.sandbox[flag] = true;
  assert.equal(editor.sandbox.window.__calculatorCanRefresh(), false, flag + ' blocks refresh');
  editor.sandbox[flag] = false;
  assert.equal(editor.sandbox.window.__calculatorCanRefresh(), true, flag + ' closes cleanly');
}
for (const operation of ['set', 'remove']) {
  const failedStorage = browser(); failedStorage.storageFailure[operation] = true;
  const write = () => operation === 'set' ? failedStorage.edit('unsaved') : failedStorage.sandbox.localStorage.removeItem('draft');
  assert.throws(write, /storage unavailable/);
  assert.equal(failedStorage.sandbox.window.__calculatorCanRefresh(), false, 'failed local ' + operation + ' blocks refresh');
  failedStorage.storageFailure[operation] = false;
  assert.equal(failedStorage.sandbox.window.__calculatorCanRefresh(), false, 'storage recovery alone cannot confirm the lost edit');
  write();
  assert.equal(failedStorage.sandbox.window.__calculatorCanRefresh(), false, 'successful local retry still requires cloud confirmation');
  await failedStorage.sandbox.window.__calculatorFlushCloudSave(60000); await tick();
  assert.equal(failedStorage.sandbox.window.__calculatorCanRefresh(), true, 'same-key retry plus cloud confirmation clears refresh fence');
}
const failedCleanup = browser({
  email: 'new-account@example.test', cloud: { draft: 'new-account-cloud' },
  initialStorage: { __calculatorSignedInEmail: 'old-account@example.test', __calculatorProfileEmail: startupProfile,
    installerMasterQuoteLogV1: JSON.stringify([{ id: 'old-account-quote' }]) },
  initialStorageFailure: { remove: 'installerMasterQuoteLogV1' },
});
assert.equal(failedCleanup.storage.get('__calculatorSignedInEmail'), 'new-account@example.test');
assert.match(failedCleanup.storage.get('installerMasterQuoteLogV1'), /old-account-quote/);
assert.equal(failedCleanup.sandbox.window.__calculatorCanRefresh(), false, 'failed pre-wrapper workspace cleanup blocks refresh');

const large = browser({ compression: true });
const largeDraft = 'quote "entry" '.repeat(400000);
large.edit(largeDraft);
assert.ok(Buffer.byteLength(JSON.stringify({ data: { draft: largeDraft } })) > 5_200_000);
await large.sandbox.window.__calculatorFlushCloudSave(60000); await tick();
assert.equal(large.calls.length, 1);
assert.ok(large.calls[0].options.body.size < 4_400_000);
assert.equal(large.calls[0].body.data.draft, largeDraft);
assert.equal(large.sandbox.window.__calculatorCloudSaveState.tone, 'saved');
assert.equal(large.session.size, 0, 'Recovery is cleared only after the exact compressed save is acknowledged');

const unsupported = browser();
unsupported.edit(largeDraft);
const rejectedLarge = unsupported.sandbox.window.__calculatorFlushCloudSave(60000).catch(error => error);
await tick();
assert.equal((await rejectedLarge).code, 'CALCULATOR_SAVE_TOO_LARGE');
assert.equal(unsupported.calls.length, 0, 'Do not repeatedly transmit a known oversized body on older browsers');
assert.equal(unsupported.storage.get('draft'), largeDraft);
assert.equal(unsupported.session.size, 1, 'Unsupported transport preserves the complete recovery snapshot');
assert.match(unsupported.sandbox.window.__calculatorCloudSaveState.message, /too large/i);

const hostRejected = browser();
hostRejected.setResponder(async () => ({ ok: false, status: 413, json: async () => { throw new Error('text/plain host error'); }, headers: { get: () => null } }));
hostRejected.edit('pending after host rejection');
const hostError = await hostRejected.sandbox.window.__calculatorFlushCloudSave(60000).catch(error => error);
assert.equal(hostError.code, 'CALCULATOR_SAVE_TOO_LARGE');
assert.equal(hostRejected.calls.length, 1, 'Host size rejection must not create a retry storm');
assert.equal(hostRejected.session.size, 1);
assert.match(hostRejected.sandbox.window.__calculatorCloudSaveState.message, /too large/);

const brokenCompression = browser({ compression: true });
brokenCompression.sandbox.CompressionStream = function() { throw new Error('Unsupported compression'); };
brokenCompression.edit('small enough for uncompressed fallback'.repeat(10000));
await brokenCompression.sandbox.window.__calculatorFlushCloudSave(60000); await tick();
assert.equal(brokenCompression.calls[0].options.headers['Content-Type'], 'application/json');
assert.equal(brokenCompression.calls[0].body.data.draft, brokenCompression.storage.get('draft'));

console.log('Cloud save recovery passed, including lossless compressed large histories, older-browser safeguards, dirty state, pending saves/mutations, conflicts, price edits, recovery and workspace changes.');
