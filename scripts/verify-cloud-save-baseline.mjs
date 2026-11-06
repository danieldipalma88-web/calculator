import assert from "node:assert/strict";
import path from "node:path";
import vm from "node:vm";
import { createClient } from "@supabase/supabase-js";
import ts from "typescript";
import { loadTsModule, rawSource, root } from "./verify-business-configuration.mjs";

const origin = "https://baseline.test";
const currentEmail = "actor@example.test";
const otherEmail = "viewed@example.test";
const businessId = "11111111-1111-4111-8111-111111111111";
const savedUser = { installerMasterQuoteLogV1: '[{"id":"saved-row","optionId":"saved-option"}]' };
const savedBusiness = { installerDefaultCostRulesV1: '[{"id":"stored-cost-rule"}]' };
const catalogue = "<!doctype html><main>Calculator fixture</main><script></script>";
let activeClient, catalogueReads = 0;

// Load the whole route, including its real GET, snapshot reader and bootstrap.
// Only the framework, catalogue I/O and Supabase HTTP boundary are fixtures.
const filename = path.join(root, "app/calculator/raw/route.ts");
const code = ts.transpileModule(rawSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
function routeRequire(name) {
  if (name === "next/server") return { NextResponse: Response };
  if (name === "node:path") return { default: path };
  if (name === "node:fs/promises") return { readFile: async () => catalogue };
  if (name.endsWith("/supabase/server")) return { createSupabaseServerClient: async () => activeClient };
  if (name.endsWith("/model-catalogue")) return {
    readAddedModels: async () => { catalogueReads++; return []; },
    calculatorAddedProducts: products => products,
  };
  assert.ok(name.startsWith("."), name);
  return loadTsModule(path.resolve(path.dirname(filename), name));
}
vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename })(routeRequire, module, module.exports);
const { GET } = module.exports;

const poolTimeout = "PGRST003";
const columnError = (table, column, code) => ({
  code, status: 400,
  message: code === "42703"
    ? `column ${table}.${column} does not exist`
    : `Could not find the '${column}' column of '${table}' in the schema cache`,
});
const missingColumn = (table, column, code) => params =>
  params.get("select").split(",").includes(column) ? columnError(table, column, code) : null;

async function load({
  byEmail = savedUser, byId, business = savedBusiness, platform = null, errors = {},
  query = "businessId=" + businessId, role = "user", selectedBusiness = businessId,
  viewedApproved = true, locked = false, businessRecordPresent = true,
} = {}) {
  const requests = [];
  const startingCatalogueReads = catalogueReads;
  const profileRows = data => data === null || data === undefined ? [] : [{ data }];
  activeClient = createClient(origin, "fixture-key", {
    db: { retry: false },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { async fetch(input, init) {
      const url = new URL(input);
      assert.equal(url.origin, origin, "Verification never reaches a live service");
      assert.equal(init.method, "GET", "Baseline must not mutate data");
      const table = url.pathname.split("/").at(-1);
      const lookup = table === "user_calculator_data" ? (url.searchParams.has("email") ? "byEmail" : "byId") : table;
      const params = url.searchParams;
      requests.push({ lookup, params });
      const fixture = errors[lookup];
      const fault = typeof fixture === "function" ? fixture(params) : fixture;
      if (fault) {
        const { code, message = "private database diagnostics", status = 504 } = typeof fault === "string" ? { code: fault } : fault;
        return Response.json({ code, message, details: null, hint: null }, { status });
      }
      const project = row => Object.fromEntries(params.get("select").split(",").filter(key => key in row).map(key => [key, row[key]]));
      switch (lookup) {
        case "approved_users": {
          const email = params.get("email").slice(3);
          if (email === otherEmail && !viewedApproved) return Response.json([]);
          return Response.json([project({ email, role, business_id: selectedBusiness, is_locked: locked })]);
        }
        case "approved_user_businesses":
          return Response.json([]);
        case "businesses":
          return Response.json(businessRecordPresent ? [project({ id: selectedBusiness, name: "Fixture Business", operating_state: "NSW" })] : []);
        case "byEmail":
          return Response.json(profileRows(byEmail));
        case "byId":
          assert.equal(url.searchParams.get("user_id"), "eq.fixture-user");
          return Response.json(profileRows(byId));
        case "business_calculator_data":
          assert.equal(url.searchParams.get("business_id"), "eq." + selectedBusiness);
          return Response.json(profileRows(business));
        case "platform_certificate_values":
          return Response.json(platform === null ? [] : [platform]);
        default:
          assert.fail(`Unexpected lookup ${lookup}`);
      }
    } },
  });
  activeClient.auth.getUser = async () => ({ data: { user: { email: currentEmail, id: "fixture-user" } }, error: null });
  const response = await GET(new Request(`${origin}/calculator/raw${query ? "?" + query : ""}`));
  const body = await response.text();
  return { response, body, requests, catalogueLoads: catalogueReads - startingCatalogueReads };
}

function unavailable(result, name) {
  assert.equal(result.response.status, 503, name);
  assert.equal(result.response.headers.get("cache-control"), "no-store", name);
  assert.equal(result.response.headers.get("retry-after"), "3", name);
  assert.match(result.response.headers.get("content-type"), /^text\/html/);
  assert.match(result.body, /could not load your saved calculator/i);
  assert.match(result.body, /<a href="">Try again<\/a>/);
  assert.doesNotMatch(result.body, /<script\b|localStorage|sessionStorage|cloudData|Calculator fixture|private database diagnostics/i, name);
  assert.equal(result.catalogueLoads, 0, "Return before assembling calculator HTML");
}

function successful(result) {
  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.match(result.body, /Calculator fixture/);
  assert.match(result.body, /__calculatorFlushCloudSave/);
  assert.equal(result.catalogueLoads, 1);
  const data = result.body.match(/var cloudData = ([^\n]+);/);
  assert.ok(data, "Success injects the real cloud baseline");
  return JSON.parse(data[1]);
}

const lookups = (result, table) => result.requests.filter(({ lookup }) => lookup === table);
function noBaselineReads(result) {
  assert.ok(!result.requests.some(({ lookup }) => ["byEmail", "byId", "business_calculator_data", "platform_certificate_values"].includes(lookup)),
    "Resolver failure must stop before any snapshot reads");
}

const businessResolverFailure = await load({ errors: { businesses: poolTimeout } });
unavailable(businessResolverFailure, "Business resolution pool timeout is not a missing business");
noBaselineReads(businessResolverFailure);
assert.ok(lookups(businessResolverFailure, "businesses").length > 0);
assert.ok(lookups(businessResolverFailure, "businesses").every(({ params }) => params.get("select").includes("operating_state")),
  "Transient business failure must not try the legacy projection");

const membershipFailure = await load({ errors: { approved_user_businesses: poolTimeout } });
unavailable(membershipFailure, "Membership pool timeout is not an empty membership list");
noBaselineReads(membershipFailure);
assert.equal(lookups(membershipFailure, "approved_user_businesses").length, 1);

const actorApprovalFailure = await load({ errors: { approved_users: poolTimeout } });
unavailable(actorApprovalFailure, "Actor approval timeout is not denial or a legacy schema");
noBaselineReads(actorApprovalFailure);
assert.deepEqual(actorApprovalFailure.requests.map(({ lookup, params }) => [lookup, params.get("email")]),
  [["approved_users", "eq." + currentEmail]], "Actor lookup stops without falling back to a less restrictive query");

const viewedQuery = `as=${otherEmail}&businessId=${businessId}`;
const viewedApprovalFailure = await load({
  role: "admin", query: viewedQuery,
  errors: { approved_users: params => params.get("email") === "eq." + otherEmail ? poolTimeout : null },
});
unavailable(viewedApprovalFailure, "Viewed-user approval timeout must not use the actor's approval row");
noBaselineReads(viewedApprovalFailure);
assert.deepEqual(lookups(viewedApprovalFailure, "approved_users").map(({ params }) => params.get("email")),
  ["eq." + currentEmail, "eq." + otherEmail]);

const missingViewedApproval = await load({ role: "admin", query: viewedQuery, viewedApproved: false });
assert.equal(missingViewedApproval.response.status, 403, "A confirmed missing viewed user is denied");
assert.doesNotMatch(missingViewedApproval.body, /<script\b|localStorage|sessionStorage|cloudData/i);
assert.equal(missingViewedApproval.catalogueLoads, 0);
noBaselineReads(missingViewedApproval);

for (const code of ["42703", "PGRST204"]) {
  const legacyBusiness = await load({ errors: { businesses: missingColumn("businesses", "operating_state", code) } });
  assert.deepEqual(successful(legacyBusiness), { ...savedUser, ...savedBusiness }, `${code}: missing legacy operating_state`);
  const projections = lookups(legacyBusiness, "businesses").map(({ params }) => params.get("select").split(","));
  assert.ok(projections.some(columns => columns.includes("operating_state")));
  assert.ok(projections.some(columns => !columns.includes("operating_state")));

  for (const optional of ["salesperson_gst_registered", "commission_type_override"]) {
    const errors = { approved_users: missingColumn("approved_users", optional, code) };
    const legacyApproval = await load({ errors });
    const approvals = lookups(legacyApproval, "approved_users").map(({ params }) => params.get("select").split(","));
    assert.ok(approvals[0].includes(optional));
    assert.ok(!approvals.at(-1).includes(optional));
    assert.ok(approvals.every(columns => columns.includes("is_locked") && columns.includes("business_id")),
      "Compatibility must retain approval locks and business scope");
    assert.deepEqual(successful(legacyApproval), { ...savedUser, ...savedBusiness }, `${code}: missing optional approval column ${optional}`);
    const legacyLocked = await load({ errors, locked: true });
    assert.equal(legacyLocked.response.status, 403, `${code}: a locked account remains denied under ${optional} fallback`);
    noBaselineReads(legacyLocked);
  }

  const missingLock = await load({ errors: { approved_users: missingColumn("approved_users", "is_locked", code) } });
  unavailable(missingLock, `${code}: required approval lock column cannot be omitted`);
  noBaselineReads(missingLock);
}

const unavailableLegacyBusiness = await load({
  errors: { businesses: params => missingColumn("businesses", "operating_state", "42703")(params) || poolTimeout },
});
unavailable(unavailableLegacyBusiness, "Pool timeout on legacy business projection must also fail closed");
noBaselineReads(unavailableLegacyBusiness);

for (const code of ["42P01", "PGRST205"]) {
  const legacyMembership = await load({ errors: { approved_user_businesses: { code, status: 404, message: "Membership table is missing" } } });
  assert.deepEqual(successful(legacyMembership), { ...savedUser, ...savedBusiness }, `${code}: missing legacy membership table retains the approved primary business`);
  assert.ok(lookups(legacyMembership, "approved_user_businesses").length > 0);
}

unavailable(await load({ byId: savedUser, errors: { byEmail: poolTimeout } }), "Email lookup failure is not a fallback signal");
unavailable(await load({ byEmail: null, errors: { byId: poolTimeout } }), "Required legacy fallback lookup failed");
unavailable(await load({ errors: { business_calculator_data: poolTimeout } }), "Selected business baseline failed");
unavailable(await load({ errors: { platform_certificate_values: poolTimeout } }), "Platform financial baseline failed");
unavailable(await load({
  role: "admin", query: `as=${otherEmail}&businessId=${businessId}`, errors: { byEmail: poolTimeout },
}), "Admin target lookup failure must not bootstrap an empty viewed profile");

const validEmail = await load({ errors: { byId: poolTimeout } });
assert.deepEqual(successful(validEmail), { ...savedUser, ...savedBusiness }, "Unused fallback errors cannot block a valid email baseline");
assert.deepEqual(successful(await load({ byEmail: {}, errors: { byId: poolTimeout } })), savedBusiness, "An existing empty profile does not use fallback");
assert.deepEqual(successful(await load({ byEmail: null, byId: savedUser })), { ...savedUser, ...savedBusiness }, "Legacy user-ID fallback works");
assert.deepEqual(successful(await load({ byEmail: null, business: null })), {}, "Successful no-row reads bootstrap a genuinely empty account");
const noBusiness = await load({ byEmail: null, query: "", selectedBusiness: null });
assert.deepEqual(successful(noBusiness), {});
assert.ok(!noBusiness.requests.some(({ lookup }) => lookup === "business_calculator_data"), "No business read without a selected business");
const verifiedNoBusiness = await load({ byEmail: null, businessRecordPresent: false });
assert.deepEqual(successful(verifiedNoBusiness), {}, "Verified no-row business metadata is distinct from an error");
assert.ok(!lookups(verifiedNoBusiness, "business_calculator_data").length);
const viewed = await load({ role: "admin", query: `as=${otherEmail}&businessId=${businessId}`, byEmail: null, byId: savedUser });
assert.deepEqual(successful(viewed), savedBusiness);
assert.equal(viewed.requests.find(({ lookup }) => lookup === "byEmail").params.get("email"), "eq." + otherEmail);
assert.ok(!viewed.requests.some(({ lookup }) => lookup === "byId"), "Admin view never falls back to the actor's profile");
const withPlatformRates = successful(await load({
  platform: { id: "global", esc_spot_price: 33.25, prc_spot_price: 4.1, source: "Fixture rates", locked: true },
}));
const certificateValues = JSON.parse(withPlatformRates.installerCertificateValuesV1);
assert.equal(certificateValues.escSpotPrice, 33.25);
assert.equal(certificateValues.prcSpotPrice, 4.1);

console.log("Cloud save baseline: real GET fails closed on resolver and snapshot read errors, denies a missing viewed approval, and permits verified empty and supported legacy reads.");
