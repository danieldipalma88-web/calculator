import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { bootstrapHtml, declaration, loadTsModule } from "./verify-business-configuration.mjs";

const raw = await readFile(new URL("../app/calculator/raw/route.ts", import.meta.url), "utf8");
const ui = await readFile(new URL("../index.html", import.meta.url), "utf8");

const retentionFunction = ui.match(/function removeExpiredQuoteRows\(rows\)\{([\s\S]*?)\n\}/)?.[1] || "";
assert.ok(retentionFunction, "The stored quote-row normalizer must exist.");
assert.match(
  retentionFunction,
  /return Array\.isArray\(rows\)\?rows:\[\];/,
  "Saved quote systems must be retained until the user removes them.",
);
assert.doesNotMatch(
  retentionFunction,
  /Date\.now|SEVEN_DAYS|timestamp|recordQuoteSyncDeletions/,
  "Saved quote systems must not be deleted based on age.",
);
assert.doesNotMatch(ui, /Working quotes are stored for 7 days/i, "The UI must not promise seven-day retention.");

assert.match(
  raw,
  /window\.__calculatorFlushCloudSave = function\(timeoutMs\)/,
  "The calculator wrapper must expose an explicit cloud-save confirmation.",
);
assert.match(
  raw,
  /settleCloudSaveWaiters\(request\.json, null\)/,
  "A successful server save must resolve the matching confirmation.",
);
assert.match(
  raw,
  /error\.permanent = response\.status >= 400/,
  "Permanent server rejections must be distinguished from retryable failures.",
);
assert.match(
  raw,
  /settleCloudSaveWaiters\(request\.json, error\)/,
  "A permanent server rejection must reject the matching confirmation.",
);

const completeWon = ui.match(/async function completeOptionWon\(id,details\)\{([\s\S]*?)\r?\n\}\r?\nasync function confirmWonDetails/)?.[1] || "";
assert.ok(completeWon, "The durable won-quote workflow must exist.");
assert.match(
  completeWon,
  /await window\.__calculatorFlushCloudSave\(20000\)/,
  "Won quotes must wait for server persistence before reporting success.",
);
assert.match(
  completeWon,
  /marked as won and saved/,
  "The success message must describe a confirmed save.",
);
assert.match(
  completeWon,
  /!isRetry&&error\?\.status===422&&error\.code==='WON_JOB_DETAILS_REQUIRED'/,
  "Rollback is limited to definitive first-attempt won validation rejection.",
);
assert.match(
  completeWon,
  /The server may already have saved it/,
  "An unconfirmed won save must describe the unknown outcome before retrying.",
);
assert.doesNotMatch(completeWon, /Nothing was marked as won/, "A lost response cannot prove the server did not commit.");
assert.ok(
  completeWon.indexOf("await window.__calculatorFlushCloudSave(20000)") <
    completeWon.indexOf("marked as won and saved"),
  "The UI must not announce a won quote before the server confirms it.",
);

const defsKey = "installerQuoteOptionDefsV1", rowsKey = "installerMasterQuoteLogV1";
const baseDefs = [{ id: "a", name: "Fixture Quote", quoteFamilyId: "a", syncUpdatedAt: 10 }];
const baseRows = [{ id: "row", optionId: "a", optionName: "Fixture Quote", quotePosition: 0, unitInc: 1000, syncUpdatedAt: 10 }];
const baseline = { [defsKey]: JSON.stringify(baseDefs), [rowsKey]: JSON.stringify(baseRows) };
const { mergeCalculatorData } = loadTsModule("lib/quote-sync.ts");
const { validateNewWonJobTransitions } = loadTsModule("lib/won-job-validation.ts");
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = (body, status = 200) => Response.json(body, { status });

function browser(respond) {
  const storage = new Map(), session = new Map(), timers = new Map(), elements = new Map();
  const calls = [], notices = [], alerts = [];
  let id = 0, clock = Date.parse("2026-11-06T05:00:00Z");
  let server = structuredClone(baseline), writes = 0, confirms = 0;
  const element = key => {
    if (!elements.has(key)) {
      const classes = new Set();
      elements.set(key, {
        value: "", style: {}, setAttribute() {}, addEventListener() {}, focus() {},
        classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name), toggle() {} },
      });
    }
    return elements.get(key);
  };
  const storageApi = map => ({
    get length() { return map.size; }, key: index => [...map.keys()][index],
    getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key), clear: () => map.clear(),
  });
  const sandbox = {
    AbortController, Blob, Event, CustomEvent, performance: { now: () => 0 },
    Date: class extends Date { static now() { return clock; } },
    setTimeout(fn, ms) { const handle = ++id; timers.set(handle, { fn, ms }); return handle; },
    clearTimeout(handle) { timers.delete(handle); },
    setInterval() {},
    document: { body: null, readyState: "loading", visibilityState: "visible", addEventListener() {}, getElementById: () => null },
    window: { addEventListener() {}, dispatchEvent() {}, crypto: { randomUUID: () => "fixture-session" } },
    localStorage: storageApi(storage), sessionStorage: storageApi(session), navigator: {},
    async fetch(_url, options) {
      assert.equal(options.method, "PUT");
      const body = JSON.parse(options.body);
      calls.push(body);
      const commit = () => {
        const next = mergeCalculatorData(server, body.data);
        assert.equal(validateNewWonJobTransitions(server, next).valid, true);
        if (JSON.stringify(server) !== JSON.stringify(next)) writes++;
        server = next;
      };
      return respond({ commit, attempt: calls.length });
    },
    $: element, OPTION_DEFS_STORAGE_KEY: defsKey, QUOTE_STORAGE_KEY: rowsKey,
    quoteOptionDefs: structuredClone(baseDefs), quotes: structuredClone(baseRows), ensureOptionDefs() {},
    canSeeOwnerDetails: () => true, quoteFamilyIsLocked: () => !!sandbox.quoteOptionDefs[0].wonAt,
    currentOptionSelection: () => ({ id: "a", def: sandbox.quoteOptionDefs[0] }),
    calculatorUserContext: () => ({ email: "fixture@example.test" }), quoteRowsMissingPriceModels: () => [],
    renderQuotes() { sandbox.quotes = structuredClone(sandbox.quotes); },
    showQuoteActionNotice: message => notices.push(message), alert: message => alerts.push(message),
    confirm: () => { confirms++; return true; },
  };
  vm.createContext(sandbox);
  vm.runInContext(bootstrapHtml(baseline, null, true).match(/<script>([\s\S]*?)<\/script>/)[1], sandbox);
  const names = ["optionDefById", "canUnlockWonOptions", "wonOptionOwnerName", "optionWonLabel", "persistOptionDefs", "persistQuotes",
    "restoreWonSaveSnapshot", "wonSaveRecordMatches", "wonSaveSnapshotMatches", "wonSaveStoredSnapshotMatches", "setWonSaveInProgress",
    "completeOptionWon", "confirmWonDetails", "markOptionWon", "unlockWonOption", "toggleCurrentOptionWon", "updateCurrentOptionWonButton"];
  const modal = ui.slice(ui.indexOf("let pendingWonOptionId="), ui.indexOf("function restoreWonSaveSnapshot("));
  vm.runInContext([modal, ...names.map(name => declaration(name))].join("\n"), sandbox);
  const run = code => vm.runInContext(code, sandbox);
  const fire = predicate => {
    const entry = [...timers].find(([, timer]) => predicate(timer.ms));
    assert.ok(entry, "Expected a matching timer");
    timers.delete(entry[0]);
    entry[1].fn();
  };
  const begin = () => {
    run("markOptionWon('a'); selectedWonGooglePlace={formattedAddress:'Fixture NSW',placeId:'fixture-place',latitude:null,longitude:null};");
    element("wonInstallDate").value = "2027-01-06";
    return run("confirmWonDetails()");
  };
  return { run, begin, element, calls, notices, alerts, storage,
    waitTimeout: () => fire(ms => ms === 20000),
    backoff: () => fire(ms => ms >= 3000 && ms < 3500),
    advanceClock: () => { clock += 10000; },
    state: () => ({ server, writes, confirms, def: sandbox.quoteOptionDefs[0], row: sandbox.quotes[0] }),
  };
}

const lost = browser(({ commit, attempt }) => {
  commit();
  if (attempt === 1) throw new Error("Response lost after commit");
  return response({ ok: true });
});
const saving = lost.begin();
await lost.run("confirmWonDetails()");
await tick();
assert.equal(lost.calls.length, 1, "A second click in flight cannot make another won attempt");
assert.equal(lost.state().writes, 1);
const wonAt = lost.state().def.wonAt;
lost.run("closeWonDetailsModal()");
assert.equal(lost.element("wonDetailsModal").classList.contains("open"), true, "Keep the modal open while confirmation is in progress");
lost.waitTimeout();
await saving;
assert.equal(lost.state().def.wonAt, wonAt);
assert.equal(lost.state().row.wonAt, wonAt);
assert.equal(lost.run("optionWonLabel(optionDefById('a'))"), "Won save unconfirmed");
assert.match(lost.element("wonDetailsHint").textContent, /may already have saved/);
assert.equal(lost.notices.length, 0, "A lost response must not announce success");
lost.run("unlockWonOption('a')");
assert.equal(lost.state().confirms, 0, "An administrator cannot unlock an unconfirmed win");
lost.run("closeWonDetailsModal()");
assert.equal(lost.element("wonDetailsModal").classList.contains("open"), false);
lost.advanceClock();
lost.run("toggleCurrentOptionWon()");
assert.equal(lost.element("wonDetailsSubmit").textContent, "Retry confirmation");
assert.equal(lost.element("wonInstallDate").disabled, true);
const retry = lost.run("confirmWonDetails()");
lost.backoff();
await retry;
assert.deepEqual(lost.calls[1], lost.calls[0], "Retry must send the same win and timestamp");
assert.equal(lost.state().writes, 1, "One authoritative win, no rollback or duplicate write");
assert.equal(JSON.parse(lost.state().server[defsKey])[0].wonAt, wonAt);
assert.match(lost.notices.at(-1), /marked as won and saved/);
assert.equal(lost.element("wonDetailsModal").classList.contains("open"), false);

const rejected = browser(() => response({ code: "WON_JOB_DETAILS_REQUIRED", error: "The installation date is not valid." }, 422));
await rejected.begin();
assert.deepEqual(rejected.state().def, baseDefs[0], "A definitive 422 restores the definition and its old version");
assert.deepEqual(rejected.state().row, baseRows[0], "A definitive 422 restores the live row even after rendering replaces it");
assert.equal(rejected.state().writes, 0);
assert.equal(rejected.element("wonDetailsSubmit").textContent, "Mark as won");
assert.equal(rejected.element("wonInstallDate").disabled, false);
assert.match(rejected.element("wonDetailsHint").textContent, /installation date is not valid/);
const rolledBackSnapshot = { [defsKey]: rejected.storage.get(defsKey), [rowsKey]: rejected.storage.get(rowsKey) };
assert.deepEqual(rolledBackSnapshot, baseline, "Rollback persists the previous versions, not a fresh unlock");
const mergedRollback = mergeCalculatorData(lost.state().server, rolledBackSnapshot);
assert.equal(JSON.parse(mergedRollback[defsKey])[0].wonAt, wonAt, "Even a rollback snapshot cannot outrank a committed win");
assert.equal(JSON.parse(mergedRollback[rowsKey])[0].wonAt, wonAt);

const offline = browser(({ attempt }) => {
  if (attempt === 1) throw new Error("No request reached the database");
  return response({ code: "WON_JOB_DETAILS_REQUIRED", error: "Cannot confirm this attempt." }, 422);
});
const offlineSave = offline.begin();
await tick();
offline.waitTimeout();
await offlineSave;
assert.equal(offline.state().writes, 0);
assert.ok(offline.state().def.wonAt, "No response is not proof that a win failed to commit");
assert.match(offline.element("wonDetailsHint").textContent, /not confirmed/);
assert.equal(offline.notices.length, 0);
offline.advanceClock();
const offlineRetry = offline.run("confirmWonDetails()");
offline.backoff();
await offlineRetry;
assert.deepEqual(offline.calls[1], offline.calls[0]);
assert.ok(offline.state().def.wonAt, "A rejection on retry cannot disprove an earlier unconfirmed commit");
assert.equal(offline.element("wonDetailsSubmit").textContent, "Retry confirmation");
assert.equal(offline.notices.length, 0);

console.log("Won quote durability checks passed: committed/lost response, exact retry, admin unlock fence, definitive rollback, and unconfirmed outage.");
