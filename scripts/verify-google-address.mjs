import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const route = ts.transpileModule(read("../app/api/google-address/route.ts"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const json = (body, status = 200) => Response.json(body, { status });

function server({ env = { GOOGLE_PLACES_SERVER_KEY: "test-server-key" }, user = { email: "approved@example.test" }, approval = { email: "approved@example.test", is_locked: false }, fetcher } = {}) {
  const logs = [];
  const scope = {
    exports: {}, process: { env }, URL, Error, AbortSignal,
    fetch: fetcher || (() => { throw new Error("Unexpected Google request"); }),
    console: { error: (...args) => logs.push(args) },
    require(name) {
      if (name === "next/server") return { NextResponse: { json: (body, options) => Response.json(body, options) } };
      if (name.endsWith("/admin")) return { isOwnerEmail: () => false };
      if (name.endsWith("/config")) return { publicSiteUrl: "https://calculator.rebateportal.com.au" };
      if (name.endsWith("/server")) return { createSupabaseServerClient: async () => ({
        auth: { getUser: async () => ({ data: { user } }) },
        from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: approval, error: null }) }) }) }),
      }) };
      throw new Error(`Unexpected import ${name}`);
    },
  };
  vm.runInNewContext(route, scope);
  return { logs, post: (body) => scope.exports.POST({ json: async () => body }) };
}

assert.equal((await server({ user: null }).post({ action: "autocomplete", input: "Sydney" })).status, 401);
assert.equal((await server({ approval: { is_locked: true } }).post({ action: "autocomplete", input: "Sydney" })).status, 403);
assert.equal((await server({ approval: null }).post({ action: "autocomplete", input: "Sydney" })).status, 403);
assert.equal((await server({ env: {} }).post({ action: "autocomplete", input: "Sydney" })).status, 503);
assert.equal((await server().post({ action: "unknown" })).status, 400);
assert.equal((await server().post({ action: "details" })).status, 400);
assert.deepEqual(await (await server().post({ action: "autocomplete", input: "Sy" })).json(), { suggestions: [] });

let request;
const lookup = server({
  env: { GOOGLE_PLACES_SERVER_KEY: "test-server-key", GOOGLE_MAPS_BROWSER_KEY: "test-browser-key" },
  fetcher: async (url, init) => {
    request = { url, init };
    return json({ suggestions: [
      { placePrediction: { placeId: "place-1", text: { text: "Sydney NSW, Australia" } } },
      { placePrediction: { text: { text: "Incomplete" } } },
    ] });
  },
});
let response = await lookup.post({ action: "autocomplete", input: "Sydney", sessionToken: "session-1" });
assert.equal(response.status, 200);
assert.match(response.headers.get("Cache-Control"), /no-store/);
assert.deepEqual(await response.json(), { suggestions: [{ placeId: "place-1", text: "Sydney NSW, Australia" }] });
assert.equal(request.init.headers["X-Goog-Api-Key"], "test-server-key");
assert.equal(request.init.headers.Referer, undefined);
assert.equal(request.init.headers.Origin, undefined);
assert.ok(request.init.signal instanceof AbortSignal);
assert.deepEqual(JSON.parse(request.init.body).includedRegionCodes, ["au"]);

await server({ env: { GOOGLE_MAPS_BROWSER_KEY: "test-browser-key" }, fetcher: async (url, init) => {
  assert.equal(init.headers.Referer, "https://calculator.rebateportal.com.au/");
  return json({ suggestions: [] });
} }).post({ action: "autocomplete", input: "Sydney" });

response = await server({ fetcher: async (url, init) => {
  assert.match(url, /places\/place-1\?sessionToken=session-1$/);
  assert.equal(init.headers["X-Goog-FieldMask"], "id,formattedAddress,location");
  return json({ id: "place-1", formattedAddress: "Sydney NSW, Australia", location: { latitude: -33.86, longitude: 151.21 } });
} }).post({ action: "details", placeId: "place-1", sessionToken: "session-1" });
assert.deepEqual(await response.json(), { place: { placeId: "place-1", formattedAddress: "Sydney NSW, Australia", latitude: -33.86, longitude: 151.21 } });
assert.equal((await server({ fetcher: async () => json({ id: "place-1" }) }).post({ action: "details", placeId: "place-1" })).status, 422);

const denied = server({ fetcher: async () => json({ error: {
  status: "PERMISSION_DENIED", message: "Key AIza-testcredential rejected", details: [{ reason: "API_KEY_HTTP_REFERRER_BLOCKED" }],
} }, 403) });
response = await denied.post({ action: "autocomplete", input: "Sydney" });
assert.equal(response.status, 503);
assert.match((await response.json()).error, /configuration issue/);
assert.equal(denied.logs[0][1].reason, "API_KEY_HTTP_REFERRER_BLOCKED");
assert.doesNotMatch(JSON.stringify(denied.logs), /AIza-testcredential/);

for (const action of ["autocomplete", "details"]) {
  for (const name of ["TimeoutError", "AbortError", "TypeError"]) {
    const failed = server({ fetcher: async () => { const error = new Error("failure"); error.name = name; throw error; } });
    const result = await failed.post({ action, input: "Sydney", placeId: "place-1" });
    assert.equal(result.status, name === "TypeError" ? 502 : 504);
  }
}
response = await server({ fetcher: async () => ({ ok: true, json: async () => { const error = new Error("Body stalled"); error.name = "TimeoutError"; throw error; } }) }).post({ action: "autocomplete", input: "Sydney" });
assert.equal(response.status, 504, "A timeout reading Google's response body must not become a successful empty search.");

const html = read("../index.html");
const clientSource = html.slice(html.indexOf("let pendingWonOptionId="), html.indexOf("function restoreWonSaveSnapshot("));
assert.ok(clientSource.includes("function googleAddressRequest("));

function client(fetcher) {
  const elements = new Map();
  const timers = new Map();
  let timerId = 0;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: "", disabled: false, textContent: "", style: {},
      classList: { toggle() {}, add() {}, remove() {} },
      setAttribute() {}, replaceChildren() {}, addEventListener() {}, focus() {}, querySelector() { return null; },
    });
    return elements.get(id);
  }
  const context = vm.createContext({
    AbortController, Error, fetch: fetcher, $: element,
    window: { crypto: { randomUUID: () => "new-session" } },
    optionDefById: () => ({ proposedInstallationDate: "" }),
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(clientSource, context);
  vm.runInContext("pendingWonOptionId='quote-1'; wonAddressSessionToken='session-1';", context);
  element("wonInstallDate").value = "2026-10-09";
  return { element, run: (code) => vm.runInContext(code, context),
    timer(ms) { const entry = [...timers].find(([, value]) => value.ms === ms); assert.ok(entry, `Expected ${ms}ms timer`); timers.delete(entry[0]); return entry[1].fn(); },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const place = { place: { formattedAddress: "Sydney NSW, Australia", placeId: "place-1", latitude: -33.86, longitude: 151.21 } };
for (const change of ["edit", "reopen", "other-quote"]) {
  const delayed = deferred();
  const state = client(() => delayed.promise);
  const selection = state.run("selectWonAddressSuggestion({placeId:'place-1',text:'Old address'})");
  if (change === "edit") {
    state.element("wonAddressInput").value = "Melbourne";
    state.run("searchWonAddresses('Melbourne')");
  } else {
    state.run("closeWonDetailsModal();");
    state.run(change === "reopen" ? "openWonDetailsModal('quote-1')" : "openWonDetailsModal('quote-2')");
  }
  delayed.resolve(json(place));
  await selection;
  assert.equal(state.run("selectedWonGooglePlace"), null, `Stale details after ${change} must be ignored.`);
  assert.equal(state.element("wonDetailsSubmit").disabled, true);
  if (change === "edit") assert.equal(state.element("wonAddressInput").value, "Melbourne");
}

const working = client(async () => json(place));
await working.run("selectWonAddressSuggestion({placeId:'place-1',text:'Sydney'})");
assert.equal(working.run("selectedWonGooglePlace.placeId"), "place-1");
assert.equal(working.element("wonDetailsSubmit").disabled, false);
working.element("wonInstallDate").value = "";
working.run("updateWonDetailsSubmitState()");
assert.equal(working.element("wonDetailsSubmit").disabled, true, "An installation date must still be required.");

for (const bodyStalls of [false, true]) {
  const stalled = client(async (url, init) => {
    const wait = () => new Promise((resolve, reject) => {
      if (init.signal.aborted) reject(init.signal.reason);
      else init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
    return bodyStalls ? { ok: true, json: wait } : wait();
  });
  const selection = stalled.run("selectWonAddressSuggestion({placeId:'place-1',text:'Sydney'})");
  await Promise.resolve();
  await Promise.resolve();
  stalled.timer(12000);
  await selection;
  assert.equal(stalled.run("wonAddressBusy"), false);
  assert.match(stalled.element("wonAddressStatus").textContent, /took too long/);
  assert.equal(stalled.element("wonDetailsSubmit").disabled, true);
}

console.log("Google address access, error recovery, timeouts and stale-response safety verified.");
