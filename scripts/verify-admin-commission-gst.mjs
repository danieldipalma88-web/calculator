import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

const admin = await readFile(new URL("../app/admin/users/page.tsx", import.meta.url), "utf8");
const syntax = ts.createSourceFile("admin.tsx", admin, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = [
  "salespersonGstRegistrationFromForm", "dbMessage", "schemaSetupMessage", "isSchemaCacheFunctionError",
  "isMissingSalespersonGstColumn", "asNumber", "isCommissionType", "normalizeApprovedUser",
  "listApprovedUsers", "saveApprovedUser", "saveSalespersonGstRegistration",
];
const helpers = syntax.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text));
assert.equal(helpers.length, names.length);
const memberships = [];
const scope = {
  isUserRole: value => ["admin", "business_owner", "agency", "salesperson", "user"].includes(value),
  saveUserBusinessMemberships: async (_supabase, email, ids) => { memberships.push({ email, ids }); return ""; },
};
vm.runInNewContext(ts.transpileModule(helpers.map(node => node.getText(syntax)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, scope);

assert.match(admin, /salesperson_gst_registered\?: boolean/, "ApprovedUser supports older records without a GST flag");
assert.equal((admin.match(/GST registered for commission/g) || []).length, 2, "New and existing user forms expose the GST checkbox");
assert.match(admin, /id="salespersonGstRegistered"[^>]*type="checkbox"[^>]*defaultChecked/, "New users default to GST registered");
assert.match(admin, /defaultChecked=\{approvedUser\.salesperson_gst_registered !== false\}/, "Existing nonregistered user remains unchecked");
assert.equal((admin.match(/type="hidden" name="salespersonGstRegistered" value="0"/g) || []).length, 2, "Unchecked checkboxes submit an explicit false");
for (const name of ["addApprovedUser", "updateApprovedUser"]) {
  const action = syntax.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(syntax);
  assert.ok(action.includes("salespersonGstRegistrationFromForm(formData)"), `${name} passes the submitted GST flag to the save helper`);
}
const absent = new FormData();
assert.equal(scope.salespersonGstRegistrationFromForm(absent), undefined, "Absent form fields must not change GST status");
const unchecked = new FormData(); unchecked.append("salespersonGstRegistered", "0");
assert.equal(scope.salespersonGstRegistrationFromForm(unchecked), false);
const checked = new FormData(); checked.append("salespersonGstRegistered", "0"); checked.append("salespersonGstRegistered", "1");
assert.equal(scope.salespersonGstRegistrationFromForm(checked), true);
assert.equal(scope.normalizeApprovedUser({ email: "test@example.test" }, []).salesperson_gst_registered, true);
assert.equal(scope.normalizeApprovedUser({ salesperson_gst_registered: false }, []).salesperson_gst_registered, false);

const ok = data => ({ data, error: null });
const missingColumn = { data: null, error: { code: "PGRST204", message: "Could not find the 'salesperson_gst_registered' column in the schema cache" } };
const missingFunction = { data: null, error: { message: "Could not find the function in the schema cache" } };
const denied = { data: null, error: { code: "42501", message: "permission denied" } };
function mockSupabase(responses) {
  const pending = responses.slice();
  const calls = [];
  function next() {
    assert.ok(pending.length, "Unexpected database request");
    return pending.shift();
  }
  return {
    calls,
    assertDone: () => assert.equal(pending.length, 0, "Every expected request was exercised"),
    rpc: async (name, payload) => { calls.push({ rpc: name, payload }); return next(); },
    from: table => {
      const call = { table }; calls.push(call);
      const query = {};
      for (const method of ["select", "update", "upsert", "eq", "order", "maybeSingle"]) {
        query[method] = (...args) => { call[method] = args; return query; };
      }
      query.then = (resolve, reject) => Promise.resolve(next()).then(resolve, reject);
      return query;
    },
  };
}

const email = "daniel@example.test";
async function save(responses, registered) {
  memberships.length = 0;
  const client = mockSupabase(responses);
  const error = await scope.saveApprovedUser(client, email, "Daniel", "salesperson", ["green"], "agency", 25, 50, registered);
  client.assertDone();
  return { client, error };
}
const savedFalse = ok({ email, salesperson_gst_registered: false });
for (const responses of [
  [ok(null), savedFalse],
  [missingFunction, ok(null), savedFalse],
  [missingFunction, { data: null, error: { message: "display_name missing" } }, ok(null), savedFalse],
]) {
  const { client, error } = await save(responses, false);
  assert.equal(error, "", "False flag persists through RPC, direct, and pre-name fallback saves");
  assert.equal(memberships.length, 1);
  const rpc = client.calls[0].payload;
  assert.equal(rpc.target_agency_commission_rate_override, 25);
  assert.equal(rpc.target_salesperson_commission_rate_override, 50);
  assert.equal(rpc.target_commission_type_override, "agency");
  for (const call of client.calls.filter(call => call.upsert)) {
    assert.equal(call.upsert[0].agency_commission_rate_override, 25, "Fallback retains agency override");
    assert.equal(call.upsert[0].salesperson_commission_rate_override, 50, "Fallback retains salesperson override");
    assert.equal(call.upsert[0].commission_type_override, "agency");
  }
  const updates = client.calls.filter(call => call.update);
  assert.equal(updates.length, 1);
  assert.deepEqual(Object.keys(updates[0].update[0]), ["salesperson_gst_registered"], "GST-only update cannot overwrite other user settings");
  assert.equal(updates[0].update[0].salesperson_gst_registered, false);
  assert.deepEqual(updates[0].eq, ["email", email]);
}
const omitted = await save([ok(null)], undefined);
assert.equal(omitted.error, "");
assert.ok(!omitted.client.calls.some(call => call.update), "Assignment/old submissions preserve existing GST overrides");
assert.equal((await save([ok(null), ok({ email, salesperson_gst_registered: true })], true)).error, "");
assert.equal((await save([ok(null), missingColumn], true)).error, "", "Missing schema retains the historical true default");
assert.match((await save([ok(null), missingColumn], false)).error, /latest business\/user SQL/, "Missing column must not silently accept a nonregistered choice");
assert.equal(memberships.length, 0);
assert.match((await save([ok(null), denied], true)).error, /permission denied/, "Permission failures are not a legacy-schema fallback");
assert.match((await save([ok(null), ok(null)], false)).error, /could not be verified/, "RLS/no-row updates must not report success");
assert.match((await save([ok(null), ok({ email, salesperson_gst_registered: true })], false)).error, /could not be verified/, "Read-back must match the selected flag");
assert.equal((await save([denied], false)).error, "permission denied");

const row = { email, role: "salesperson", agency_commission_rate_override: 25, salesperson_commission_rate_override: 50 };
for (const tail of [
  [ok([row])],
  [missingFunction, ok([row])],
  [missingFunction, { error: { message: "display_name missing" } }, ok([row])],
]) {
  const client = mockSupabase([ok([{ email, is_locked: false }]), ok([{ email, salesperson_gst_registered: false }]), ...tail]);
  const result = await scope.listApprovedUsers(client, []);
  client.assertDone();
  assert.equal(result.data[0].salesperson_gst_registered, false, "Separate GST lookup works with old RPC/direct fallbacks");
  assert.equal(result.data[0].agency_commission_rate_override, 25);
  assert.equal(result.data[0].salesperson_commission_rate_override, 50);
}
const legacyClient = mockSupabase([ok([]), missingColumn, ok([row])]);
assert.equal((await scope.listApprovedUsers(legacyClient, [])).data[0].salesperson_gst_registered, true);
legacyClient.assertDone();
const deniedClient = mockSupabase([ok([]), denied]);
const deniedList = await scope.listApprovedUsers(deniedClient, []);
assert.equal(deniedList.data.length, 0, "A failed GST lookup must not render false registrations as true");
assert.equal(deniedList.errorMessage, "permission denied");
deniedClient.assertDone();

console.log("Admin commission GST forms, persistence, and legacy fallback checks passed.");
