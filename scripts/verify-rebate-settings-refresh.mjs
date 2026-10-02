import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import ts from "typescript";
import { createClient } from "@supabase/supabase-js";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const apiPath = path.join(root, "app/api/calculator-data/route.ts");
const rawPath = path.join(root, "app/calculator/raw/route.ts");
const raw = fs.readFileSync(rawPath, "utf8");
const modules = new Map();
let activeClient;
function loadTs(filename) {
  if (modules.has(filename)) return modules.get(filename);
  const module = { exports: {} };
  modules.set(filename, module.exports);
  const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(source, {
    module, exports: module.exports, URL, Request, Response,
    require: (specifier) => {
      if (specifier === "next/server") return { NextResponse: { json: Response.json } };
      if (specifier.endsWith("/supabase/server")) return { createSupabaseServerClient: async () => activeClient };
      if (specifier.endsWith(".json")) return require(path.resolve(path.dirname(filename), specifier));
      return specifier.startsWith(".")
        ? loadTs(path.resolve(path.dirname(filename), `${specifier}.ts`))
        : require(specifier);
    },
  }, { filename });
  return module.exports;
}
const handlers = loadTs(apiPath);
const certificates = loadTs(path.join(root, "lib/certificate-values.ts"));
const contract = loadTs(path.join(root, "lib/dcceew-contract-data.ts"));
const keys = Array.from(certificates.CERTIFICATE_VALUES_STORAGE_KEYS);
const plain = (value) => JSON.parse(JSON.stringify(value));
const settings = (data) => Object.fromEntries(keys.filter((key) => data[key] != null).map((key) => [key, data[key]]));
const currentEmail = "sales@example.test";
const targetEmail = "target@example.test";
const platform = { id: "global", esc_spot_price: 33.25, prc_spot_price: 4.1, source: "Verified", locked: true, updated_at: "2026-10-02T00:00:00Z" };
const userData = {
  installerMasterQuoteLogV1: JSON.stringify([{ id: "private-quote", customer: "Private customer" }]),
  installerCertificateValuesV1: JSON.stringify({ escSpotPrice: 999 }),
  installerWonOptionAdminStateV1: "private-admin-state",
  privateProfile: "private-profile",
};
const businessData = {
  installerManagedPricesV1: JSON.stringify({ model: { price: 1500 } }),
  installerDefaultCostRulesV1: JSON.stringify({ labour: 500 }),
  [keys[0]]: JSON.stringify({ escAgreementDeduction: 7.15, prcAgreementDeduction: 0.65 }),
};

// Use the installed Supabase client; only the DB HTTP boundary is mocked.
function database(config = {}) {
  const queries = [];
  const writes = [];
  const email = config.email || currentEmail;
  const row = { email, role: config.role || "salesperson", business_id: "business-a", is_locked: Boolean(config.locked) };
  const business = config.businessData ?? businessData;
  const tables = {
    approved_users: [...(config.missingApproval ? [] : [row]), { email: targetEmail, role: "salesperson", business_id: "business-b" }],
    approved_user_businesses: [{ email, business_id: "business-a" }, { email, business_id: "business-b" }],
    user_calculator_data: [
      { email, user_id: "current-id", data: config.userData ?? userData },
      { email: targetEmail, user_id: "target-id", data: { ...userData, privateProfile: "target-profile" } },
    ],
    business_calculator_data: [
      { business_id: "business-a", data: business },
      { business_id: "business-b", data: { ...business, [keys[0]]: JSON.stringify({ escAgreementDeduction: 1.25, prcAgreementDeduction: 0 }) } },
    ],
    platform_certificate_values: config.platform === null ? [] : [config.platform ?? platform],
  };
  const client = createClient("https://mock.invalid", "mock-key", {
    db: { retry: false },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, options) => {
      if (options.method !== "GET") writes.push({ url: String(input), method: options.method });
      assert.equal(options.method, "GET", "Verification must never write records");
      const url = new URL(String(input));
      const table = url.pathname.split("/").at(-1);
      const select = url.searchParams.get("select");
      const filters = [...url.searchParams].filter(([key]) => key !== "select");
      queries.push({ table, select, filters });
      if (config.approvalNetworkFailure && table === "approved_users") throw new Error("mock network failure");
      if (config.errors?.includes(table) || (config.legacyApproved && table === "approved_users" && select.includes("is_locked"))) {
        return Response.json({ message: "mock read error", code: "42703" }, { status: 400 });
      }
      let rows = (tables[table] || []).filter((item) => filters.every(([key, value]) => value === `eq.${item[key]}`));
      if (config.missingEmailProfile && table === "user_calculator_data" && url.searchParams.has("email")) rows = [];
      rows = rows.map((item) => Object.fromEntries(select.split(",").map((column) => {
        const projection = column.match(/^(\w+):data->(\w+)$/);
        return projection ? [projection[1], item.data?.[projection[2]] ?? null] : [column, item[column]];
      })));
      return Response.json(rows);
    } },
  });
  client.auth.getUser = async () => ({ data: { user: config.signedOut ? null : { email, id: "current-id" } } });
  return { client, queries, writes };
}
async function get(query, config = {}, method = "GET") {
  const db = database(config);
  activeClient = db.client;
  const request = new Request(`https://calculator.test/api/calculator-data${query ? `?${query}` : ""}`, method === "GET" ? undefined : {
    method, headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { privateProfile: "attempted write", installerManagedPricesV1: businessData.installerManagedPricesV1 } }),
  });
  let bodyReads = 0;
  const readJson = request.json.bind(request);
  request.json = () => { bodyReads++; return readJson(); };
  const response = await handlers[method](request);
  return { status: response.status, body: await response.json(), headers: response.headers, queries: db.queries, writes: db.writes, bodyReads };
}
let cases = 0;
async function parity(name, query, config = {}) {
  const full = await get(query, config);
  const light = await get(`${query ? `${query}&` : ""}mode=rebate-settings`, config);
  assert.equal(light.status, full.status, name);
  assert.deepEqual(light.body, { dcceewContract: full.body.dcceewContract, data: settings(full.body.data) }, name);
  assert.equal(light.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(light.queries.filter((item) => item.table === "user_calculator_data").length, 0, `${name}: no profile/quote reads`);
  const fullProfileReads = full.queries.filter((item) => item.table === "user_calculator_data").length;
  assert.equal(full.queries.length - light.queries.length, fullProfileReads, `${name}: only profile reads removed`);
  assert.deepEqual(light.queries.filter((item) => item.table !== "business_calculator_data"), full.queries.filter((item) => !["business_calculator_data", "user_calculator_data"].includes(item.table)), `${name}: identical authorization and platform queries`);
  for (const read of light.queries.filter((item) => item.table === "business_calculator_data")) {
    assert.equal(read.select, keys.map((key) => `${key}:data->${key}`).join(","), `${name}: DB must project only certificates`);
    assert.deepEqual(read.filters, full.queries.find((item) => item.table === "business_calculator_data").filters);
  }
  cases++;
  return { full, light };
}

const normal = await parity("normal", "businessId=business-a");
assert.equal(normal.full.body.data.privateProfile, "private-profile", "Old clients retain their profile");
assert.equal(normal.full.body.data.installerManagedPricesV1, businessData.installerManagedPricesV1);
assert.ok(!("installerWonOptionAdminStateV1" in normal.full.body.data));
const rates = JSON.parse(normal.light.body.data[keys[0]]);
assert.equal(rates.escRate, 26.1);
assert.equal(rates.prcRate, 3.45);
assert.equal(rates.escAgreementDeduction, 7.15);
assert.deepEqual(normal.light.body.dcceewContract, plain({ rate: contract.DCCEEW_CONTRACT_RATE, postcodes: contract.DCCEEW_ELIGIBLE_POSTCODES, productKeys: contract.DCCEEW_ELIGIBLE_PRODUCT_KEYS }));
await parity("membership business", "businessId=business-b");
await parity("unauthorized business", "businessId=not-a-member");
await parity("non-admin as ignored", `as=${targetEmail}&businessId=business-a`);
await parity("no business", "");
const fallbackProfile = await parity("user-id profile fallback", "businessId=business-a", { missingEmailProfile: true });
assert.equal(fallbackProfile.full.body.data.privateProfile, "private-profile");
await parity("admin preview", "businessId=business-b&preview=admin", { role: "admin" });
const as = await parity("admin as", `as=${targetEmail}&businessId=business-b`, { role: "admin" });
assert.equal(as.full.body.data.privateProfile, "target-profile");
assert.equal(JSON.parse(as.light.body.data[keys[0]]).escAgreementDeduction, 1.25);
await parity("platform owner as", `as=${targetEmail}&businessId=business-b`, { email: "danieldipalma88@gmail.com" });
await parity("business owner not platform admin", `as=${targetEmail}&businessId=not-a-member`, { role: "business_owner" });
await parity("membership read failure", "businessId=business-b", { errors: ["approved_user_businesses"] });
await parity("business read failure", "businessId=business-a", { errors: ["business_calculator_data"] });
await parity("platform read failure", "businessId=business-a", { errors: ["platform_certificate_values"] });
await parity("platform row absent", "businessId=business-a", { platform: null });
for (const key of keys) {
  await parity(`legacy fee key ${key}`, "businessId=business-a", { businessData: { [key]: JSON.stringify({ escAgreementDeduction: 0, prcAgreementDeduction: 1.1 }) } });
}
await parity("malformed primary falls through", "businessId=business-a", { businessData: { [keys[0]]: "broken", [keys[1]]: { escAgreementDeduction: 2.8 } } });
await parity("missing fee defaults", "businessId=business-a", { businessData: {} });
await parity("missing platform and fees", "businessId=business-a", { businessData: {}, platform: null });
const changed = await parity("fresh spot update", "businessId=business-a", { platform: { ...platform, esc_spot_price: 40, updated_at: "2026-10-02T01:00:00Z" } });
assert.equal(JSON.parse(changed.light.body.data[keys[0]]).escRate, 32.85, "No cached certificate response");
assert.notEqual(normal.light.body.data[keys[0]], as.light.body.data[keys[0]], "Business fees must not cross accounts");
assert.deepEqual((await get("businessId=business-a&mode=unknown")).body, normal.full.body, "Unknown mode must remain a full GET");
for (const config of [{ signedOut: true }, { locked: true, role: "admin" }]) {
  const full = await get("businessId=business-a", config);
  const light = await get("businessId=business-a&mode=rebate-settings", config);
  assert.equal(light.status, config.signedOut ? 401 : 403);
  assert.deepEqual(light.body, full.body);
  assert.deepEqual(light.queries, full.queries);
  assert.ok(!light.queries.some((item) => ["business_calculator_data", "user_calculator_data", "platform_certificate_values"].includes(item.table)));
}
let denialCases = 0;
for (const context of [
  { name: "normal", config: {} },
  { name: "admin", config: { role: "admin" } },
  { name: "platform owner", config: { email: "danieldipalma88@gmail.com" } },
]) {
  for (const denial of [
    { name: "missing approval", config: { missingApproval: true }, status: 403, message: "Account not approved" },
    { name: "lookup error", config: { errors: ["approved_users"] }, status: 503, message: "Unable to verify account approval" },
    { name: "lock-column lookup error", config: { legacyApproved: true }, status: 503, message: "Unable to verify account approval" },
    { name: "network lookup error", config: { approvalNetworkFailure: true }, status: 503, message: "Unable to verify account approval" },
    { name: "locked approval", config: { locked: true }, status: 403, message: "Account locked" },
    { name: "signed out", config: { signedOut: true }, status: 401, message: "Not signed in" },
  ]) {
    for (const [method, mode] of [["GET", ""], ["GET", "&mode=rebate-settings"], ["PUT", ""], ["POST", ""]]) {
      const name = `${context.name}: ${denial.name}: ${method}${mode}`;
      const result = await get(`as=${targetEmail}&businessId=business-b${mode}`, { ...context.config, ...denial.config }, method);
      assert.equal(result.status, denial.status, name);
      assert.deepEqual(result.body, { error: denial.message }, `${name}: no data/error-detail leakage`);
      assert.equal(result.queries.length, denial.config.signedOut ? 0 : 1, `${name}: no lock-omitting fallback`);
      assert.ok(result.queries.every((query) => query.table === "approved_users"), `${name}: deny before memberships, profiles or settings`);
      assert.equal(result.writes.length, 0, `${name}: deny before any data write`);
      assert.equal(result.bodyReads, 0, `${name}: deny before parsing save payload`);
      denialCases++;
    }
  }
}
console.log(`Approval guards passed: ${denialCases} full/settings GET and PUT/POST denial cases, including admin/owner, before any data access or write`);
const quoteError = { errors: ["user_calculator_data"] };
assert.equal((await get("businessId=business-a", quoteError)).status, 500, "Full GET errors remain compatible");
assert.equal((await get("businessId=business-a&mode=rebate-settings", quoteError)).status, 200, "Settings do not depend on quotes");
console.log(`API passed: ${cases} full/lightweight parity cases; normal queries ${normal.full.queries.length} -> ${normal.light.queries.length}, no quote loads`);

// Compile the actual bootstrap generator, then run its whole emitted script.
const sourceFile = ts.createSourceFile(rawPath, raw, ts.ScriptTarget.Latest, true);
const functions = sourceFile.statements.filter((node) => ts.isFunctionDeclaration(node) && ["safeScriptJson", "injectCloudStorageSync"].includes(node.name?.text));
assert.equal(functions.length, 2);
const generator = { ...contract, sanitizeCalculatorData: (data) => data };
vm.runInNewContext(ts.transpileModule(functions.map((node) => node.getText(sourceFile)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText, generator);
const flush = () => new Promise((resolve) => setImmediate(resolve));
function browser(context = {}, hidden = false) {
  const timeouts = new Map();
  const intervals = new Map();
  const windowEvents = new Map();
  const documentEvents = new Map();
  const storage = new Map();
  const calls = [];
  const applied = [];
  let timerId = 0;
  let fetchImpl = async () => ({ ok: true, json: async () => normal.light.body });
  const sandbox = {
    AbortController, Blob, performance: { now: () => 0 },
    setTimeout: (fn, ms) => { const id = ++timerId; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timeouts.delete(id),
    setInterval: (fn, ms) => { const id = ++timerId; intervals.set(id, { fn, ms }); return id; },
    window: {
      addEventListener: (name, fn) => windowEvents.set(name, fn),
      applyAuthoritativeRebateSettings: (...args) => applied.push(plain(args)),
    },
    document: {
      readyState: "loading", visibilityState: hidden ? "hidden" : "visible", body: null,
      addEventListener: (name, fn) => documentEvents.set(name, fn),
      getElementById: () => null,
    },
    localStorage: {
      get length() { return storage.size; }, key: (index) => [...storage.keys()][index],
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key), clear: () => storage.clear(),
    },
    navigator: { sendBeacon: (url) => calls.push({ url, beacon: true }) },
    fetch: (url, options) => { calls.push({ url, options }); return fetchImpl(url, options); },
  };
  const html = generator.injectCloudStorageSync("<script></script>", {}, { email: currentEmail, viewingEmail: currentEmail, businessId: "business-a", ...context });
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], sandbox);
  return {
    sandbox, calls, applied, storage, timeouts, intervals,
    setFetch: (fn) => { fetchImpl = fn; },
    focus: () => windowEvents.get("focus")(),
    visible: (value) => { sandbox.document.visibilityState = value ? "visible" : "hidden"; documentEvents.get("visibilitychange")(); },
    fireTimeout: (ms) => {
      const entry = [...timeouts].find(([, timer]) => timer.ms === ms);
      assert.ok(entry, `Missing ${ms}ms timeout`);
      timeouts.delete(entry[0]); entry[1].fn();
    },
    periodic: () => [...intervals.values()].find((timer) => timer.ms === 60000).fn(),
    unload: () => windowEvents.get("beforeunload")(),
  };
}
const bridge = browser();
assert.equal(bridge.calls.length, 0, "Refresh must not start before first check");
bridge.fireTimeout(2000);
await flush();
assert.equal(bridge.calls.length, 1);
assert.equal(bridge.calls[0].url, "/api/calculator-data?businessId=business-a&mode=rebate-settings");
assert.equal(bridge.calls[0].options.cache, "no-store");
assert.equal(bridge.calls[0].options.method, "GET");
assert.ok(bridge.calls[0].options.signal instanceof AbortSignal);
assert.deepEqual(bridge.applied[0], [normal.light.body.dcceewContract, normal.light.body.data[keys[0]]]);
assert.ok(![...bridge.timeouts.values()].some((timer) => timer.ms === 12000), "Success clears deadline");
bridge.visible(false);
bridge.periodic();
await flush();
assert.equal(bridge.calls.length, 1, "Hidden intervals do no network work");
bridge.visible(true);
await flush();
assert.equal(bridge.calls.length, 2, "Becoming visible refreshes immediately");
bridge.focus();
await flush();
assert.equal(bridge.calls.length, 3, "Focus refreshes immediately");
bridge.periodic();
await flush();
assert.equal(bridge.calls.length, 4, "Visible 60-second refresh remains");

let lateResolve;
bridge.setFetch(() => new Promise((resolve) => { lateResolve = resolve; }));
bridge.focus();
await flush();
const hung = bridge.calls.at(-1);
bridge.focus(); bridge.periodic();
await flush();
assert.equal(bridge.calls.at(-1), hung, "In-flight refreshes deduplicate");
bridge.fireTimeout(12000);
await flush();
assert.equal(hung.options.signal.aborted, true, "Timeout aborts hung fetch");
bridge.setFetch(async () => ({ ok: true, json: async () => changed.light.body }));
bridge.focus();
await flush();
assert.equal(bridge.calls.length, 6, "Timed-out guard must recover for retry");
assert.equal(bridge.applied.at(-1)[1], changed.light.body.data[keys[0]]);
const appliedBeforeLate = bridge.applied.length;
lateResolve({ ok: true, json: async () => normal.light.body });
await flush();
assert.equal(bridge.applied.length, appliedBeforeLate, "Late timed-out response cannot overwrite fresh settings");

bridge.setFetch(async () => ({ ok: true, json: () => new Promise(() => {}) }));
bridge.focus(); await flush();
bridge.fireTimeout(12000); await flush();
for (const failure of [
  () => { throw new Error("synchronous fetch failure"); },
  async () => { throw new Error("network failure"); },
  async () => ({ ok: false }),
  async () => ({ ok: true, json: async () => { throw new Error("invalid JSON"); } }),
]) {
  bridge.setFetch(failure);
  const before = bridge.calls.length;
  bridge.focus(); await flush();
  bridge.focus(); await flush();
  assert.equal(bridge.calls.length, before + 2, "Every error path releases the guard");
  assert.ok(![...bridge.timeouts.values()].some((timer) => timer.ms === 12000), "Errors clear deadlines");
}
assert.equal(bridge.applied.length, appliedBeforeLate, "Failures preserve current settings");
bridge.setFetch(async () => ({ ok: true, json: async () => normal.light.body }));
bridge.focus(); await flush();
assert.equal(bridge.applied.length, appliedBeforeLate + 1, "Body hangs and failures remain retryable");

const hidden = browser({}, true);
hidden.fireTimeout(2000); await flush();
assert.equal(hidden.calls.length, 1, "The initial two-second check is retained even when hidden");
hidden.periodic(); await flush();
assert.equal(hidden.calls.length, 1);
const noAbortController = browser();
delete noAbortController.sandbox.AbortController;
noAbortController.setFetch(() => new Promise(() => {}));
noAbortController.focus(); await flush();
noAbortController.fireTimeout(12000); await flush();
noAbortController.setFetch(async () => ({ ok: true, json: async () => normal.light.body }));
noAbortController.focus(); await flush();
assert.equal(noAbortController.calls.length, 2, "Deadline remains retryable without AbortController");
for (const context of [{ businessId: null }, { viewingEmail: targetEmail, businessId: "business-b" }]) {
  const client = browser(context);
  client.focus(); await flush();
  const url = new URL(client.calls[0].url, "https://calculator.test");
  assert.equal(url.searchParams.get("mode"), "rebate-settings");
  assert.equal(url.searchParams.get("businessId"), context.businessId);
  assert.equal(url.searchParams.get("as"), context.viewingEmail || null);
  client.unload();
  assert.ok(!client.calls.at(-1).url.includes("mode="), "Beacon saves must retain the original full URL");
  client.sandbox.localStorage.setItem("privateQuote", "updated quote");
  await client.sandbox.window.__calculatorFlushCloudSave();
  const save = client.calls.at(-1);
  assert.equal(save.options.method, "PUT");
  assert.ok(!save.url.includes("mode="), "PUT saves must retain the original full URL");
  assert.equal(JSON.parse(save.options.body).data.privateQuote, "updated quote");
}
delete bridge.sandbox.window.applyAuthoritativeRebateSettings;
const legacyCalls = [];
bridge.sandbox.window.applyAuthoritativeDcceewContractData = (value) => legacyCalls.push(value);
bridge.focus(); await flush();
assert.deepEqual(legacyCalls[0], normal.light.body.dcceewContract, "Legacy contract hook remains supported");
assert.equal(bridge.storage.get(keys[0]), normal.light.body.data[keys[0]], "Certificate local storage refresh is preserved");
console.log("Browser passed: first check, focus/visibility, hidden periodic skip, 12s fetch/body timeout, late-response guard, retry and original save URL");
