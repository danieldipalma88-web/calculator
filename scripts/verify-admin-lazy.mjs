import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const page = readFileSync(new URL("../app/admin/users/page.tsx", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../app/admin/users/admin-workspace.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("page.tsx", page, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = name => {
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, name);
  return node;
};
const execute = (source, globals) => {
  const context = vm.createContext(globals);
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInContext(js, context);
  return context;
};
const helper = declaration("wonJobsRequested").getText(ast);
const gate = execute(helper, {}).wonJobsRequested;
const deepLinks = [{ view: "jobs" }, { checkBackups: "1" }, { wonBatch: "batch-id" }, { wonBatchPage: "2" },
  { wonReport: "custom" }, { wonSalesperson: "fixture@example.invalid" }, { wonFrom: "2026-11-01" }, { wonTo: "2026-11-19" }];
for (const params of [undefined, {}, { view: "users" }, { setupBusiness: "fixture" }, { certificateHistoryRange: "month" }, { checkBackups: "0" }]) {
  assert.equal(gate(params), false);
}
for (const params of deepLinks) assert.equal(gate(params), true);
for (const view of ["businesses", "users", "prices"]) {
  for (const params of deepLinks) assert.equal(gate({ ...params, view }), false, "Other tabs must not scan retained Jobs parameters");
}

// Exercise the actual page's loader statements without rendering its unrelated forms.
const loader = declaration("AdminUsersPage");
const returned = loader.body.statements.find(ts.isReturnStatement);
const loaderSource = `async function loadPage({searchParams}) {${page.slice(loader.body.pos + 1, returned.pos)}
  return {loadWonJobs, wonResult, batchHistory, activeBatchResult}; }`;
const calls = [];
let denied = false;
const empty = name => async () => { calls.push(name); return { data: [], errorMessage: "" }; };
const globals = {
  Map, Set, Promise, Boolean, Number, String,
  requireAdmin: async () => { calls.push("authorize"); if (denied) throw new Error("denied"); return { supabase: {}, email: "admin@example.invalid", actorId: "fixture" }; },
  normalizeCertificateHistoryRange: value => value,
  isWonBatchId: value => value === "batch-id",
  listBusinesses: empty("businesses"), listApprovedUsers: empty("users"),
  listUserBusinessMemberships: empty("memberships"), listApprovedUserActivity: empty("activity"),
  getPlatformCertificateValues: async () => ({ data: { escSpotPrice: 0, prcSpotPrice: 0 }, businessValuesById: {} }),
  listPlatformCertificateValueHistory: empty("certificateHistory"),
  listWonBatches: async () => { calls.push("batches"); return { batches: [], unavailable: false, hasMore: false }; },
  getWonBatch: async () => { calls.push("activeBatch"); return { batch: null, error: null }; },
  listWonOptions: async (_client, _users, backups) => { calls.push(backups ? "profiles+backups" : "profiles"); return { data: [], errorMessage: "", currentUnavailable: false }; },
  applyActivityToUsers: users => users, applyMembershipsToUsers: users => users,
  wonBatchJobId: () => "fixture", isWonReportDefaultPerson: () => false,
  summarizeSalesBySalesperson: () => [], previousCertificateObservation: () => null, combinedCertificateSpotPrice: () => 0,
};
const context = execute(`${helper}\n${loaderSource}`, globals);
for (const params of [{}, { view: "users", checkBackups: "1", wonBatch: "batch-id" }, { view: "prices" }, { view: "businesses" }]) {
  calls.length = 0;
  const result = await context.loadPage({ searchParams: Promise.resolve(params) });
  assert.equal(result.loadWonJobs, false);
  assert.equal(calls[0], "authorize");
  assert.ok(!calls.some(name => /profiles|batches|activeBatch/.test(name)), JSON.stringify(calls));
}
for (const params of [{ view: "jobs" }, { checkBackups: "1" }, { wonBatch: "batch-id" }, { wonReport: "custom" }]) {
  calls.length = 0;
  await context.loadPage({ searchParams: Promise.resolve(params) });
  assert.equal(calls[0], "authorize");
  assert.equal(calls.filter(name => name === "batches").length, 1);
  assert.equal(calls.includes("profiles+backups"), params.checkBackups === "1");
  assert.equal(calls.includes("profiles"), params.checkBackups !== "1");
  assert.equal(calls.includes("activeBatch"), Boolean(params.wonBatch));
}
denied = true; calls.length = 0;
await assert.rejects(context.loadPage({ searchParams: Promise.resolve({ view: "jobs", checkBackups: "1" }) }), /denied/);
assert.deepEqual(calls, ["authorize"], "Query flags never bypass authorization");

const actionNames = ["unlockWonOption", "deleteWonOption", "updateWonPaymentStatus", "bulkUpdateWonOptions"];
let result = "", authorized = true, writes = 0;
const actions = execute(actionNames.map(name => declaration(name).getText(ast)).join("\n"), {
  FormData, String, encodeURIComponent,
  CURRENT_WON_SOURCE_ID: "current", WON_PAYMENT_ALREADY_RECORDED: "already",
  requireAdmin: async () => { if (!authorized) throw new Error("denied"); return { supabase: {}, email: "admin@example.invalid" }; },
  normalizeEmail: value => String(value || "").toLowerCase(), normalizeText: value => String(value || ""),
  updateWonOptionState: async () => { writes++; return result; },
  parseWonOptionSelections: value => value ? JSON.parse(value) : [], isWonBatchKind: () => false,
  revalidatePath: () => {}, redirect: url => { const error = new Error("redirect"); error.url = url; throw error; },
});
for (const name of actionNames) {
  for (const state of ["", "synthetic failure", "already"]) {
    result = state;
    const data = new FormData();
    data.set("userEmail", "fixture@example.invalid"); data.set("optionId", "fixture"); data.set("paymentMode", "paid_in");
    data.set("bulkMode", "unlock"); data.set("selectedWonOptions", JSON.stringify([{ userEmail: "fixture@example.invalid", optionId: "fixture" }]));
    await assert.rejects(actions[name](data), error => {
      const url = new URL(error.url, "https://fixture.invalid");
      return url.searchParams.get("view") === "jobs" && url.hash === "#won-options";
    });
  }
  await assert.rejects(actions[name](new FormData()), error => new URL(error.url, "https://fixture.invalid").searchParams.get("view") === "jobs");
}
authorized = false;
const before = writes;
for (const name of actionNames) await assert.rejects(actions[name](new FormData()), /denied/);
assert.equal(writes, before);
const batch = declaration("submitWonBatch").getText(ast);
assert.match(batch, /new URLSearchParams\(\{ view: "jobs"/);
assert.match(batch, /if \(includeBackups\) params.set\("checkBackups", "1"\)/);
assert.match(page, /jobsLoaded=\{loadWonJobs\}/);
assert.match(page, /\{loadWonJobs \? <div className="admin-section-body" data-won-backup-scope/);
assert.match(page, /Payment reminders not checked/);
assert.match(workspace, /router\.replace\(target, \{ scroll: false \}\)/);
assert.match(workspace, /router\.refresh\(\)/);
assert.doesNotMatch(workspace, /window\.location\.(assign|replace|reload)/);
console.log("PASS admin lazy loaders: zero Jobs reads on other tabs, deep links, explicit backups, authorization and Won-action redirects (synthetic writes only).");
