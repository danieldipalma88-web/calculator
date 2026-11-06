import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const origin = "https://supabase.test";
const email = "private-fixture@example.test";
const businessId = "11111111-1111-4111-8111-111111111111";
const version = "2030-01-01T00:00:00.123456+00:00";
const priceKey = "installerManagedPricesV1";
const prices = '{"split|0":{"unitPriceInc":300,"locked":true}}';
const userTable = "user_calculator_data", businessTable = "business_calculator_data";
const fixture = () => ({
  auth: { user: { id: "fixture-user", email }, error: null },
  approval: { role: "user", business_id: businessId, is_locked: false },
  business: { business_id: businessId, data: { [priceKey]: prices }, updated_at: version },
  user: { user_id: "fixture-user", email, data: { draft: "stored" }, updated_at: version },
});

const modules = new Map();
let shortDeadline = false;
function load(relative) {
  const filename = path.resolve(root, path.extname(relative) ? relative : relative + ".ts");
  if (modules.has(filename)) return modules.get(filename);
  if (filename === path.resolve(root, "lib/supabase/config.ts")) return { supabaseUrl: origin, supabasePublishableKey: "fixture-key" };
  const module = { exports: {} };
  modules.set(filename, module.exports);
  const code = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const localRequire = name => {
    if (name === "next/headers") return { cookies: async () => ({ getAll: () => [], set() {} }) };
    if (name === "next/server") return { NextResponse: { json: Response.json } };
    if (name === "@supabase/ssr") return { createServerClient(url, key, options) {
      assert.equal(options.db.retry, false, "PostgREST retries must be disabled on writes");
      assert.equal(typeof options.global.fetch, "function");
      const client = createClient(url, key, {
        ...options, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      client.auth.getUser = async () => (await options.global.fetch(origin + "/auth/v1/user")).json();
      return client;
    } };
    if (name.startsWith(".")) {
      const imported = load(path.resolve(path.dirname(filename), name));
      if (name.endsWith("/calculator-data-save")) return {
        ...imported,
        withCalculatorSaveDeadline: (...args) => imported.withCalculatorSaveDeadline(...args, shortDeadline ? 60 : undefined),
      };
      return imported;
    }
    return require(name);
  };
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename })(localRequire, module, module.exports);
  return module.exports;
}

const route = load("app/api/calculator-data/route.ts");
const { sameCalculatorSaveData } = load("lib/calculator-data-save.ts");
const nativeFetch = globalThis.fetch;
let state, calls, intercept;
function reset() {
  state = fixture();
  calls = [];
  intercept = undefined;
  shortDeadline = false;
}
globalThis.fetch = async (input, init) => {
  const url = new URL(input);
  assert.equal(url.origin, origin, "No live requests");
  assert.ok(init.signal instanceof AbortSignal, "Auth and Data API must share request cancellation");
  const resource = url.pathname.split("/").at(-1);
  const call = { resource, method: init.method ?? "GET", signal: init.signal, filters: url.searchParams, data: init.body && JSON.parse(init.body) };
  calls.push(call);
  const intercepted = intercept?.(call);
  if (intercepted !== undefined) return intercepted;
  return respond(call);
};
function respond(call) {
  const { resource } = call;
  if (resource === "user") return Response.json({ data: { user: state.auth.user }, error: state.auth.error });
  if (resource === "approved_users") return Response.json(state.approval ? [state.approval] : []);
  if (resource === "approved_user_businesses") return Response.json([]);
  assert.ok([userTable, businessTable].includes(resource), resource);
  const key = resource === businessTable ? "business" : "user";
  const row = state[key];
  const matches = row && [...call.filters].every(([field, predicate]) => field === "select" ||
    (predicate === "is.null" ? row[field] === null : predicate === "eq." + row[field]));
  if (call.method === "GET") return Response.json(matches ? [row] : []);
  if (call.method === "PATCH") {
    if (!matches) return Response.json([]);
    state[key] = { ...row, ...call.data };
    return Response.json([state[key]]);
  }
  assert.equal(call.method, "POST");
  assert.equal(row, null);
  state[key] = call.data;
  return new Response(null, { status: 201 });
}

const request = (body, { method = "PUT", business = true, signal, as } = {}) => {
  const url = new URL("https://calculator.test/api/calculator-data");
  if (business) url.searchParams.set("businessId", businessId);
  if (as) url.searchParams.set("as", as);
  return route[method](new Request(url, { method, body: JSON.stringify(body), signal }));
};
const mutations = () => calls.filter(call => call.method !== "GET");
const success = async response => {
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
};
const retryable = async (response, code = "CALCULATOR_SAVE_TIMEOUT") => {
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "3");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.code, code);
  assert.equal(body.ok, undefined);
  assert.doesNotMatch(JSON.stringify(body), /private-fixture|sensitive-marker/);
};

try {
  reset();
  const noop = { data: { [priceKey]: ' { "split|0": { "locked": true, "unitPriceInc": 300 } }', draft: "stored" } };
  for (const method of ["PUT", "POST", "PUT"]) await success(await request(noop, { method }));
  assert.deepEqual(mutations(), [], "Equivalent writes must not touch either hot row");
  assert.equal(state.business.updated_at, version);
  assert.equal(state.user.updated_at, version);
  await success(await request({ data: { ...noop.data, draft: "changed" } }));
  assert.deepEqual(mutations().map(call => call.resource), [userTable], "Only the changed row is written");
  assert.equal(mutations()[0].filters.get("updated_at"), "eq." + version);
  const orderedKey = "installerDefaultCostRulesV1";
  for (const [key, left, right] of [
    [orderedKey, "[1,2]", "[2,1]"], [orderedKey, "[0]", '["0"]'],
    [orderedKey, "[9007199254740992]", "[9007199254740993]"], ["draft", '{"n":1}', '{ "n":1 }'],
  ]) assert.equal(sameCalculatorSaveData({ [key]: left }, { [key]: right }), false);
  console.log("Save no-op: PUT and beacon POST, embedded JSON, unchanged timestamps, and changed user row only.");

  reset();
  let collisions = 0;
  intercept = call => {
    if (call.resource === businessTable && call.method === "PATCH" && collisions++ === 0) {
      state.business.data.other = "concurrent";
      state.business.updated_at = "2030-01-01T00:00:01.123456+00:00";
      return Response.json([]);
    }
  };
  await success(await request({ data: { [priceKey]: prices.replace("300", "301"), draft: "stored" } }));
  assert.deepEqual(mutations().map(call => call.filters.get("updated_at")), [
    "eq." + version, "eq.2030-01-01T00:00:01.123456+00:00",
  ]);
  assert.equal(state.business.data.other, "concurrent");
  assert.equal(JSON.parse(state.business.data[priceKey])["split|0"].unitPriceInc, 301);
  reset();
  state.user.email = null;
  await success(await request({ data: { draft: "stored" } }));
  assert.equal(state.user.email, email, "No-op must not skip legacy email backfill");
  assert.equal(mutations().length, 1);
  reset();
  state.user = null;
  await success(await request({ data: { draft: "new" } }));
  assert.equal(mutations()[0].method, "POST");
  reset();
  state.approval.is_locked = true;
  assert.equal((await request(noop)).status, 403);
  assert.deepEqual(mutations(), []);
  reset();
  state.approval = null;
  assert.equal((await request(noop)).status, 403);
  assert.deepEqual(mutations(), []);
  reset();
  state.auth = { user: null, error: { name: "AuthApiError", status: 401 } };
  assert.equal((await request(noop)).status, 401);
  assert.equal(calls.length, 1);
  reset();
  state.approval.business_id = null;
  const workspace = { accountEmail: email, viewingEmail: email, businessId };
  const workspaceConflict = async response => {
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "CALCULATOR_WORKSPACE_CHANGED");
    assert.deepEqual(mutations(), []);
    assert.equal(calls.some(call => [userTable, businessTable].includes(call.resource)), false, "Reject before reading or writing save rows");
  };
  await workspaceConflict(await request({ data: { [priceKey]: prices.replace("300", "301"), draft: "changed" } }));
  for (const [method, body] of [["PUT", { data: { draft: "changed" } }], ["POST", { quoteArrange: {} }]]) {
    reset();
    await workspaceConflict(await request(body, { method, as: " Other@example.test " }));
    assert.deepEqual(calls.map(call => call.resource), ["user", "approved_users"], "Revoked admin scope is denied before membership or mutation");
  }
  reset();
  await success(await request(noop, { as: " " + email.toUpperCase() + " " }));
  assert.deepEqual(mutations(), [], "Normalized explicit self scope is still valid");
  reset();
  await success(await request({ ...noop, expectedWorkspace: workspace }));
  assert.deepEqual(mutations(), []);
  reset();
  state.auth.user = { id: "different-cookie-user", email: "different@example.test" };
  await workspaceConflict(await request({ data: { draft: "changed" }, expectedWorkspace: workspace }, { method: "POST" }));
  reset();
  state.approval.role = "admin";
  await workspaceConflict(await request({ quoteArrange: {}, expectedWorkspace: workspace }, { as: "other@example.test" }));
  reset();
  await workspaceConflict(await request({ quoteCopy: {}, expectedWorkspace: null }));
  reset();
  await workspaceConflict(await request({ ...noop, expectedWorkspace: workspace }, { business: false }));
  reset();
  await success(await request({ ...noop, expectedWorkspace: { ...workspace, businessId: null } }, { business: false }));
  assert.deepEqual(mutations(), []);
  console.log("Save guards: exact-version CAS retry, legacy email backfill, first insert, and locked/unapproved/signed-out paths.");
  console.log("Workspace fence: matching and business-less workspaces, changed cookie, target account, malformed workspace and legacy inaccessible business.");

  const changed = { data: { [priceKey]: prices.replace("300", "400"), draft: "changed" } };
  const databaseFailure = code => Response.json({ code, message: "sensitive-marker", details: null, hint: null }, { status: 504 });
  for (const [resource, method, code] of [
    ["approved_users", "GET", "PGRST003"], ["approved_user_businesses", "GET", "PGRST003"],
    [businessTable, "PATCH", "PGRST003"], [businessTable, "PATCH", "55P03"],
    [userTable, "PATCH", "57014"],
  ]) {
    reset();
    intercept = call => call.resource === resource && call.method === method ? databaseFailure(code) : undefined;
    await retryable(await request(changed));
    assert.equal(calls.filter(call => call.resource === resource && call.method === method).length, 1);
    assert.equal(calls.at(-1).resource, resource, "No downstream work after upstream timeout");
  }
  reset();
  state.approval.role = "admin";
  intercept = call => call.resource === "approved_users" && call.filters.get("email") === "eq.other@example.test"
    ? databaseFailure("PGRST003") : undefined;
  await retryable(await request(changed, { as: "other@example.test" }));
  assert.deepEqual(mutations(), []);
  const unavailableMembership = () => Response.json({ code: "PGRST000", message: "sensitive-marker", details: null, hint: null }, { status: 503 });
  reset();
  state.approval.business_id = "22222222-2222-4222-8222-222222222222";
  intercept = call => call.resource === "approved_user_businesses" ? unavailableMembership() : undefined;
  await retryable(await request(changed), "CALCULATOR_SAVE_UNAVAILABLE");
  assert.equal(calls.at(-1).resource, "approved_user_businesses");
  assert.deepEqual(mutations(), [], "Unknown secondary membership must not write or permanently reject the workspace");
  intercept = call => call.resource === "approved_user_businesses" ? Response.json([{ business_id: businessId }]) : undefined;
  await success(await request(changed));
  assert.deepEqual(mutations().map(call => call.resource), [businessTable, userTable], "Verified membership allows the retained save to retry");
  reset();
  intercept = call => call.resource === "approved_user_businesses" ? unavailableMembership() : undefined;
  await success(await request(noop));
  assert.deepEqual(mutations(), [], "The approved primary business still verifies access without the secondary lookup");
  reset();
  state.auth = { user: null, error: { name: "AuthRetryableFetchError", status: 0 } };
  await retryable(await request(noop), "CALCULATOR_SAVE_UNAVAILABLE");
  assert.equal(calls.length, 1);
  console.log("Transient errors: PGRST003, unverified secondary membership (PGRST000), statement/lock timeout and Auth outage return 503 + Retry-After.");

  const warn = console.warn;
  const warnings = [];
  try {
    console.warn = (...args) => warnings.push(args);
    for (const [resource, upstreamMethod, method, phase] of [
      ["user", "GET", "PUT", "auth"],
      [businessTable, "PATCH", "POST", "business-save"],
      [userTable, "PATCH", "PUT", "user-save"],
    ]) {
      reset();
      shortDeadline = true;
      let heldSignal;
      intercept = call => {
        if (call.resource !== resource || call.method !== upstreamMethod) return;
        heldSignal = call.signal;
        return new Promise((_, reject) => call.signal.addEventListener("abort", () => reject(call.signal.reason), { once: true }));
      };
      await retryable(await request(changed, { method }));
      assert.equal(heldSignal?.aborted, true);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls.filter(call => call.resource === resource && call.method === upstreamMethod).length, 1);
      assert.equal(calls.at(-1).resource, resource);
      assert.deepEqual(warnings.pop(), ["Calculator save deadline exceeded", { method, phase }]);
    }
    reset();
    shortDeadline = true;
    let release;
    intercept = call => call.resource === "user" ? new Promise(resolve => { release = resolve; }) : undefined;
    await retryable(await request(changed));
    assert.equal(calls[0].signal.aborted, true);
    release(Response.json({ data: { user: state.auth.user }, error: null }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1, "Late upstream completion cannot start new network work");
    assert.deepEqual(warnings.pop(), ["Calculator save deadline exceeded", { method: "PUT", phase: "auth" }]);

    // A write can commit before the deadline even if its response is lost.
    for (const [resource, key, phase] of [[businessTable, "business", "business-save"], [userTable, "user", "user-save"]]) {
      reset();
      shortDeadline = true;
      let reply;
      intercept = call => {
        if (call.resource !== resource || call.method !== "PATCH") return;
        const committed = respond(call);
        return new Promise(resolve => { reply = () => resolve(committed); });
      };
      await retryable(await request(changed));
      const committedVersion = state[key].updated_at;
      assert.notEqual(committedVersion, version);
      assert.deepEqual(warnings.pop(), ["Calculator save deadline exceeded", { method: "PUT", phase }]);
      const timedOutCalls = calls.length;
      reply();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls.length, timedOutCalls, "Late success cannot continue the expired request");
      shortDeadline = false;
      intercept = undefined;
      await success(await request(changed));
      assert.equal(state[key].updated_at, committedVersion, "Retry confirms the commit without changing its version");
      assert.deepEqual(mutations().map(call => call.resource), [businessTable, userTable], "Each row is written only once across both requests");
      assert.equal(state.user.data.draft, "changed");
    }

    // If the expired request's PATCH reaches the DB late, its old CAS filter
    // must miss the winning write. The expired loop cannot reread and retry.
    reset();
    shortDeadline = true;
    let finishOldCas;
    intercept = call => {
      if (call.resource !== businessTable || call.method !== "PATCH") return;
      assert.equal(call.filters.get("updated_at"), "eq." + version);
      return new Promise(resolve => { finishOldCas = () => resolve(respond(call)); });
    };
    await retryable(await request(changed));
    assert.deepEqual(warnings.pop(), ["Calculator save deadline exceeded", { method: "PUT", phase: "business-save" }]);
    assert.equal(state.business.updated_at, version, "Old CAS hasn't committed");
    shortDeadline = false;
    intercept = undefined;
    await success(await request({ data: { [priceKey]: prices.replace("300", "500"), draft: "winning draft" } }));
    const winningState = structuredClone(state);
    const callsAfterWinner = calls.length;
    finishOldCas();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(state, winningState, "Late stale CAS cannot overwrite either row");
    assert.equal(calls.length, callsAfterWinner, "Expired CAS loop cannot reread or retry after a late miss");

    reset();
    const controller = new AbortController();
    intercept = call => {
      controller.abort();
      assert.equal(call.signal.aborted, true);
      return Promise.reject(call.signal.reason);
    };
    await retryable(await request(changed, { signal: controller.signal }), "CALCULATOR_SAVE_UNAVAILABLE");
    assert.equal(calls.length, 1);
    assert.deepEqual(warnings, [], "Client disconnect is not a server deadline");
  } finally {
    console.warn = warn;
  }
  console.log("Request deadline: Auth and both write paths abort, PUT and beacon POST, hung and late fetch, disconnect, redacted phase log.");
  console.log("Lost write response: retry confirms each committed row once; late stale CAS cannot overwrite or retry after a newer save.");
} finally {
  globalThis.fetch = nativeFetch;
}
