import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const next = { NextResponse: { json: (body, options) => Response.json(body, options) } };
let now = Date.parse("2026-10-02T00:00:00Z");
class TestDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
function load(file, dependencies) {
  const compiled = ts.transpileModule(read(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, Date: TestDate, URL,
    require: (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: file });
  return exports;
}

let state;
function reset(overrides = {}) {
  state = {
    user: { id: "self-id", email: "SELF@example.test" }, authError: null,
    approval: { email: "self@example.test", role: "salesperson", is_locked: false, last_active_at: null },
    approvalError: null, rpcError: null, rpcData: new TestDate().toISOString(),
    queries: [], calls: [], ...overrides,
  };
}
const supabase = {
  auth: { getUser: async () => ({ data: { user: state.user }, error: state.authError }) },
  from(table) {
    const query = { table };
    state.queries.push(query);
    return {
      select(fields) {
        query.fields = fields;
        return {
          eq(key, value) {
            Object.assign(query, { key, value });
            return { maybeSingle: async () => ({ data: state.approval, error: state.approvalError }) };
          },
        };
      },
    };
  },
  async rpc(...args) {
    state.calls.push(args);
    return { data: state.rpcData, error: state.rpcError };
  },
};
const server = { createSupabaseServerClient: async () => supabase };
const activityRoute = load("app/api/user-activity/route.ts", {
  "next/server": next, "../../../lib/supabase/server": server,
});
const session = load("lib/supabase/approved-calculator-session.ts", { "./server": server });
const admin = load("lib/admin.ts", {});
const adminRoute = load("app/api/admin/user-activity/route.ts", {
  "next/server": next, "../../../../lib/admin": admin,
  "../../../../lib/supabase/approved-calculator-session": session,
});
const request = (headers = {}, body = undefined) => new Request(
  "https://calculator.example.test/api/user-activity?as=victim@example.test&timestamp=2099-01-01",
  { method: "POST", headers: { origin: "https://calculator.example.test", ...headers }, body },
);
async function checkResponse(response, status) {
  assert.equal(response.status, status);
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  return response.json();
}

reset();
let result = await checkResponse(await activityRoute.POST(request({}, JSON.stringify({
  email: "victim@example.test", user_id: "victim-id", last_active_at: "2099-01-01T00:00:00Z",
}))), 200);
assert.equal(result.recorded, true, "Fake client time must not suppress the first real event");
assert.deepEqual(state.calls, [["record_current_user_activity"]], "RPC must receive no identity or time parameters");
assert.equal(state.queries[0].value, "self@example.test");
assert.equal(state.queries[0].key, "email");

for (const headers of [
  { origin: "https://evil.example.test" }, { origin: "null" }, { origin: "" },
  { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" },
]) {
  reset();
  await checkResponse(await activityRoute.POST(request(headers)), 403);
  assert.equal(state.queries.length, 0);
  assert.equal(state.calls.length, 0);
}
for (const [overrides, status] of [
  [{ user: null }, 401], [{ authError: { message: "invalid JWT" } }, 401],
  [{ user: { id: "missing-email" } }, 401], [{ approval: null }, 403],
  [{ approval: { is_locked: true } }, 403], [{ approvalError: { message: "lookup failed" } }, 503],
]) {
  reset(overrides);
  await checkResponse(await activityRoute.POST(request()), status);
  assert.equal(state.calls.length, 0);
}
for (const [lastActiveAt, recorded] of [
  [new Date(now).toISOString(), false], [new Date(now - 59999).toISOString(), false],
  [new Date(now - 60000).toISOString(), true], [null, true], ["invalid", true],
  [new Date(now + 60000).toISOString(), true],
]) {
  reset();
  state.approval.last_active_at = lastActiveAt;
  result = await checkResponse(await activityRoute.POST(request()), 200);
  assert.equal(result.recorded, recorded);
  assert.equal(state.calls.length, recorded ? 1 : 0);
}
reset({ rpcError: { message: "RPC unavailable" } });
await checkResponse(await activityRoute.POST(request()), 503);
reset({ rpcData: null });
await checkResponse(await activityRoute.POST(request()), 403);

for (const [overrides, status] of [
  [{ user: null }, 401], [{ approval: null }, 403],
  [{ approval: { role: "admin", is_locked: true } }, 403],
  [{ user: { email: "danieldipalma88@gmail.com" }, approval: { role: "admin", is_locked: true } }, 403],
  [{ user: { email: "danieldipalma88@gmail.com" }, approval: null }, 403],
  [{ approvalError: { message: "lookup failed" } }, 503],
  ...["salesperson", "agency", "business_owner"].map((role) => [{ approval: { role, is_locked: false } }, 403]),
]) {
  reset(overrides);
  await checkResponse(await adminRoute.GET(), status);
  assert.equal(state.calls.length, 0, "Unauthorized/locked callers must not reach the admin RPC");
}
for (const [email, role] of [["self@example.test", "admin"], ["danieldipalma88@gmail.com", "salesperson"]]) {
  reset({ user: { email }, approval: { role, is_locked: false }, rpcData: [
    { email: "historical@example.test", last_active_at: "2025-01-01T00:00:00Z", extra: "not exposed" },
    { email: "unknown@example.test", last_active_at: null },
  ] });
  result = await checkResponse(await adminRoute.GET(), 200);
  assert.deepEqual(result, {
    activity: [
      { email: "historical@example.test", last_active_at: "2025-01-01T00:00:00Z" },
      { email: "unknown@example.test", last_active_at: null },
    ], observedAt: new TestDate().toISOString(),
  });
  assert.deepEqual(state.calls, [["admin_list_approved_user_activity"]]);
}
reset({ approval: { role: "admin", is_locked: false }, rpcError: { message: "Not authorized" } });
await checkResponse(await adminRoute.GET(), 503);

const raw = read("app/calculator/raw/route.ts");
const block = raw.slice(raw.indexOf("  var lastActivityAttemptAt = null;"), raw.indexOf("  window.DCCEEW_CONTRACT_DATA ="));
assert.ok(block.includes("recordVisibleUserInteraction"));
function fakeDom(fetchImplementation = async () => ({})) {
  const listeners = new Map();
  const calls = [];
  let clock = 0;
  const document = {
    visibilityState: "visible",
    addEventListener(type, callback, options) {
      assert.equal(options.capture, true);
      assert.equal(options.passive, true);
      listeners.set(type, callback);
    },
  };
  vm.runInNewContext(block, {
    document, performance: { now: () => clock },
    fetch: (...args) => { calls.push(args); return fetchImplementation(...args); },
    setTimeout: () => assert.fail("Activity must not schedule timers"),
    setInterval: () => assert.fail("Activity must not schedule polling"),
  });
  return {
    document, calls, listeners,
    time: (value) => { clock = value; },
    event: (type, isTrusted = true) => listeners.get(type)?.({ type, isTrusted }),
  };
}
const dom = fakeDom();
assert.deepEqual([...dom.listeners.keys()], ["pointerdown", "keydown", "input", "change"]);
for (const type of dom.listeners.keys()) dom.event(type, false);
for (const type of ["focus", "mousemove", "visibilitychange", "beforeunload", "timer", "pricepoll"]) dom.event(type);
assert.equal(dom.calls.length, 0, "Synthetic events, focus, polling, and unload must not count");
dom.document.visibilityState = "hidden";
for (const type of dom.listeners.keys()) dom.event(type);
assert.equal(dom.calls.length, 0, "Trusted hidden events must not count");
dom.document.visibilityState = "visible";
dom.event("pointerdown");
assert.equal(dom.calls.length, 1, "The first real event at time zero must count");
dom.time(59999);
for (const type of dom.listeners.keys()) dom.event(type);
assert.equal(dom.calls.length, 1);
dom.time(60000);
dom.event("keydown");
assert.equal(dom.calls.length, 2, "One minute boundary must allow the next event");
dom.time(120000);
dom.document.visibilityState = "hidden";
dom.event("input");
dom.document.visibilityState = "visible";
dom.event("input");
assert.equal(dom.calls.length, 3, "Hidden events must not consume the next legitimate event");
dom.time(180000);
dom.event("change");
assert.equal(dom.calls.length, 4);
for (const [url, options] of dom.calls) {
  assert.equal(url, "/api/user-activity", "Never use the viewed user's sync URL");
  assert.deepEqual({ ...options }, { method: "POST", credentials: "same-origin", cache: "no-store" });
}
for (const failure of [() => Promise.reject(new Error("offline")), () => { throw new Error("offline"); }]) {
  const failed = fakeDom(failure);
  failed.event("pointerdown");
  failed.event("keydown");
  assert.equal(failed.calls.length, 1, "Failed requests must remain throttled");
  await Promise.resolve();
}

assert.doesNotMatch(read("app/api/calculator-data/route.ts"), /record_current_user_activity/);
assert.match(read("app/calculator/page.tsx"), /supabase\.rpc\("record_current_user_activity"\)/);
assert.equal((raw.match(/recordVisibleUserInteraction/g) || []).length, 2, "Only event listeners may invoke tracking");
const sql = read("supabase/user_activity_upgrade.sql");
assert.match(sql, /record_current_user_activity\(\)/);
assert.match(sql, /auth\.jwt\(\) ->> 'email'/);
assert.match(sql, /where lower\(email\) = current_email/);
assert.match(sql, /greatest\(au\.last_active_at, users\.last_sign_in_at\)/);
console.log("User activity: trusted visible events, throttling, self-only writes, access guards, and admin response checks passed.");
