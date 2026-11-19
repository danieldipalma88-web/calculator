// Run the actual middleware, SDK and page with synthetic cookies and an in-memory upstream.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".css"] = (mod) => { mod.exports = {}; };
for (const ext of [".ts", ".tsx"]) {
  require.extensions[ext] = (mod, path) => mod._compile(ts.transpileModule(fs.readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, path);
}
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fixture.invalid";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "fake-public-key";
const next = require("next/server");
let req;
require("next/headers");
require.cache[require.resolve("next/headers")].exports = { cookies: async () => req.cookies };
require.cache[require.resolve("next/server")].exports = { ...next, after: () => {} };
const { middleware } = require("../middleware.ts");
const page = require("../app/calculator/page.tsx").default;
const { withCalculatorAuthDeadline } = require("../lib/supabase/calculator-entry.ts");
const now = Math.floor(Date.now() / 1000);
const user = { id: "fixture-1", email: "fixture@example.invalid" };
const session = (exp) => ({
  access_token: ["header", JSON.stringify({ exp }), "signature"].map(v => Buffer.from(v).toString("base64url")).join("."),
  refresh_token: "fixture-refresh", token_type: "bearer", expires_at: exp, expires_in: exp - now, user,
});
function start(exp, path = "/calculator") {
  const headers = exp ? { cookie: "sb-fixture-auth-token=base64-" + Buffer.from(JSON.stringify(session(exp))).toString("base64url") } : {};
  req = new next.NextRequest("https://calculator.invalid" + path, { headers });
}
const calls = [];
let mode = "ok", aborts = 0;
global.fetch = async (input, options) => {
  const url = new URL(input.url || input);
  assert.equal(url.origin, "https://fixture.invalid");
  calls.push(url.pathname);
  if (mode === "hang") {
    return new Promise(() => { options.signal.addEventListener("abort", () => { aborts++; }, { once: true }); });
  }
  if (url.pathname === "/auth/v1/token") return Response.json(session(now + 3600));
  if (url.pathname === "/auth/v1/user") {
    if (mode === "revoked") return Response.json({ message: "Invalid session" }, { status: 401 });
    return Response.json(user);
  }
  if (url.pathname === "/rest/v1/approved_users") return Response.json(mode === "pending" ? [] : [{ ...user, role: "user", is_locked: mode === "locked" }]);
  if (url.pathname === "/rest/v1/approved_user_businesses") return Response.json([]);
  throw new Error("Unexpected path " + url.pathname);
};
const pageText = async () => JSON.stringify(await page({}));
async function run() {
  start();
  assert.equal((await middleware(req)).headers.get("x-middleware-next"), "1");
  await assert.rejects(page({}), e => e.digest?.startsWith("NEXT_REDIRECT;"));
  assert.deepEqual(calls, []);

  start(now + 3600);
  await middleware(req);
  assert.deepEqual(calls, [], "Fresh sessions must perform no remote check in middleware");
  assert.match(await pageText(), /calculator-shell/);
  assert.equal(calls.filter(p => p === "/auth/v1/user").length, 1);
  for (const [state, match] of [["locked", /account is locked/], ["pending", /not approved yet/]]) {
    mode = state;
    assert.match(await pageText(), match);
  }
  mode = "revoked";
  calls.length = 0;
  await assert.rejects(page({}), e => e.digest?.startsWith("NEXT_REDIRECT;"));
  assert.deepEqual(calls, ["/auth/v1/user"]);

  mode = "ok";
  start(now - 60);
  const rotated = await middleware(req);
  assert.ok(rotated.cookies.get("sb-fixture-auth-token")?.value);
  assert.equal(rotated.cookies.get("sb-fixture-auth-token").value, req.cookies.get("sb-fixture-auth-token").value);
  assert.ok(rotated.headers.get("x-middleware-request-cookie")?.includes(req.cookies.get("sb-fixture-auth-token").value));
  assert.match(await pageText(), /calculator-shell/);

  start(now + 3600, "/admin/users");
  calls.length = 0;
  await middleware(req);
  assert.deepEqual(calls, ["/auth/v1/user"], "Unrelated routes retain existing middleware verification");
  mode = "hang";
  start(now - 60);
  const oldCookie = req.headers.get("cookie");
  const then = Date.now();
  const unavailable = await middleware(req);
  assert.ok(Date.now() - then < 10000);
  assert.equal(unavailable.status, 503);
  assert.match(unavailable.headers.get("cache-control"), /no-store/);
  assert.equal(unavailable.headers.get("set-cookie"), null);
  assert.equal(req.headers.get("cookie"), oldCookie);
  start(now + 3600);
  calls.length = 0;
  const out = await pageText();
  assert.match(out, /Sign-in is taking longer/);
  assert.doesNotMatch(out, /calculator-shell/);
  assert.deepEqual(calls, ["/auth/v1/user"]);
  assert.equal(aborts, 2);
  await assert.rejects(withCalculatorAuthDeadline(() => new Promise(() => {}), 15), /timed out/);
  console.log("PASS: anonymous, fresh, expired/rotated, revoked, locked, pending, other routes, and two auth outages");
}
run().catch(e => { console.error(e); process.exitCode = 1; });
