import assert from 'node:assert/strict';
import vm from 'node:vm';
import { bootstrapHtml } from './verify-business-configuration.mjs';

const tick = async () => { for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const success = () => ({ ok: true, status: 200, json: async () => ({ ok: true }), headers: { get: () => null } });
const unavailable = () => ({ ok: false, status: 503, json: async () => ({ error: 'offline' }), headers: { get: () => null } });

function browser({ cloud = { draft: 'seed' }, businessId = '11111111-1111-4111-8111-111111111111', email = 'fixture@example.test', viewingEmail = email, session = new Map(), initialStorage = {}, initialStorageFailure = {} } = {}) {
  const storage = new Map(Object.entries(initialStorage).map(([key, value]) => [key, String(value)]));
  const timeouts = new Map(), intervals = new Map(), documentHandlers = new Map(), windowHandlers = new Map();
  const calls = [], beacons = [], storageWrites = [];
  const storageFailure = { set: false, remove: false, ...initialStorageFailure };
  let nextTimer = 0, responder = () => success();
  const sandbox = {
    AbortController, Blob, Event, CustomEvent, performance: { now: () => 0 },
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
      getItem: key => session.get(key) ?? null,
      setItem: (key, value) => session.set(key, String(value)),
      removeItem: key => session.delete(key),
    },
    navigator: { sendBeacon: (...args) => { beacons.push(args); return true; } },
    fetch(url, options) { calls.push({ url, options, body: JSON.parse(options.body || '{}') }); return responder(url, options); },
  };
  let html = bootstrapHtml(cloud, businessId).replaceAll('fixture@example.test', email);
  if (viewingEmail !== email) html = html.replace(`"viewingEmail":"${email}"`, `"viewingEmail":"${viewingEmail}"`);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'generated calculator bootstrap script exists');
  vm.runInNewContext(script, sandbox);
  return {
    sandbox, storage, session, storageWrites, storageFailure, timeouts, intervals, documentHandlers, windowHandlers, calls, beacons,
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
const reloaded = browser({
  cloud: { draft: 'cloud-current', installerMasterQuoteLogV1: JSON.stringify([{ id: 'cloud-row', model: 'CLOUD' }]) },
  session: interruptedSession,
});
const cloudQuote = reloaded.storage.get('installerMasterQuoteLogV1');
const writesAfterBootstrap = reloaded.storageWrites.length;
await assert.rejects(reloaded.sandbox.window.__calculatorFlushCloudSave(60000), /pending recovery/);
reloaded.input(); reloaded.periodic(); await tick();
assert.equal(reloaded.calls.length, 0, 'recovery-required page performs no automatic or manual save');
assert.equal(reloaded.storage.get('installerMasterQuoteLogV1'), cloudQuote, 'old pending quote never overwrites loaded cloud quote');
assert.equal(reloaded.storageWrites.length, writesAfterBootstrap, 'paused recovery performs no further app-storage writes');
assert.equal(interruptedSession.get(interruptedKey), interruptedStash);

const emptyCloudRecovery = browser({
  cloud: {}, session: interruptedSession,
  initialStorage: {
    __calculatorSignedInEmail: 'fixture@example.test',
    __calculatorProfileEmail: 'fixture@example.test|11111111-1111-4111-8111-111111111111',
    draft: 'old-local-draft',
    installerMasterQuoteLogV1: JSON.stringify([{ id: 'old-local-row', model: 'OLD-LOCAL' }]),
  },
});
assert.equal(emptyCloudRecovery.storage.has('installerMasterQuoteLogV1'), false, 'recovery-required empty-cloud boot clears discarded local quote');
assert.equal(emptyCloudRecovery.storage.has('draft'), false, 'recovery-required empty-cloud boot clears old draft before backfill');
const backfillTimer = [...emptyCloudRecovery.timeouts.values()].find(timer => timer.ms === 1000);
if (backfillTimer) emptyCloudRecovery.timer(1000);
await tick();
assert.equal(emptyCloudRecovery.calls.length, 0, 'empty-cloud recovery never uploads cleared old local data');
assert.equal(interruptedSession.get(interruptedKey), interruptedStash, 'pending recovery remains available for review');

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
await assert.rejects(fenced.sandbox.window.__calculatorFlushCloudSave(60000), /Review the pending recovery or reopen this workspace/);
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
const savedRowsOnReload = lostCopyReload.storage.get('installerMasterQuoteLogV1');
await assert.rejects(lostCopyReload.sandbox.window.__calculatorFlushCloudSave(60000), /pending recovery/);
await assert.rejects(lostCopyReload.sandbox.window.__calculatorQuoteRequest('quoteCopy', { ...lostCopyPayload, saveId: 'new-copy-id' }), /Review recovery/);
lostCopyReload.periodic(); await tick();
assert.equal(lostCopyReload.calls.length, 0, 'reload stash pauses autosave and new copy requests');
assert.equal(lostCopyReload.storage.get('installerMasterQuoteLogV1'), savedRowsOnReload, 'reload retains saved cloud quote without replaying uncertain local mutation');
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
assert.equal(lostCopyReload.sandbox.window.__calculatorCanRefresh(), false, 'pending recovery blocks refresh');
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

console.log('Cloud save recovery passed, including safe-refresh guards for dirty state, pending saves/mutations, conflicts, price edits, recovery and workspace changes.');
