import assert from "node:assert/strict";
import { incidentState, syncIncident } from "./report-calculator-origin-incident.mjs";

const good = [{ service: "auth", ok: true, status: 200, ms: 100 }, { service: "database", ok: true, status: 200, ms: 200 }];
const slow = good.map(r => ({ ...r, ms: 4000 }));
const bad = good.map(r => ({ ...r, ok: false, status: 522 }));
const healthy = { state: "healthy", rounds: [good] };
const warning = { state: "slow", rounds: [slow, slow] };
const outage = { state: "outage", rounds: [bad, bad] };
const transient = { state: "transient", rounds: [bad, good] };
assert.equal(incidentState(null), "monitor-incomplete");
assert.equal(incidentState({ ...outage, state: "healthy" }), "monitor-incomplete");
let issues = [];
let calls = [];
const options = { token: "fixture-only", runUrl: "https://github.com/danieldipalma88-web/calculator/actions/runs/123", fetchImpl: async (url, init) => {
  assert.ok(url.startsWith("https://api.github.com/repos/danieldipalma88-web/calculator/issues"));
  assert.equal(init.redirect, "error");
  assert.ok(init.signal);
  calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body) });
  return Response.json(init.method === "GET" ? issues : { number: 42 });
} };
const run = report => syncIncident({ ...options, report });
assert.equal(await run(healthy), "healthy-no-incident");
assert.equal(await run(transient), "transient-no-change");
assert.equal(calls.filter(c => c.method !== "GET").length, 0);
calls = [];
assert.equal(await run(warning), "opened");
const created = calls.find(c => c.method === "POST").body;
assert.deepEqual(created.assignees, ["danieldipalma88-web"]);
assert.doesNotMatch(created.body, /fixture-only|publishable|user_id|email/);
issues = [{ ...created, number: 42, user: { login: "github-actions[bot]" } }];
calls = [];
assert.equal(await run(warning), "unchanged");
assert.equal(calls.length, 1, "Unchanged incidents do not create duplicate follow-ups");
calls = [];
assert.equal(await run(transient), "transient-no-change");
assert.equal(calls.length, 1, "A single recovered retry cannot close a real incident");
calls = [];
assert.equal(await run(outage), "updated");
assert.equal(calls.filter(c => c.method === "POST").length, 1);
assert.equal(calls.filter(c => c.method === "PATCH").length, 1);
calls = [];
assert.equal(await run(healthy), "recovered");
assert.equal(calls.at(-1).body.state, "closed");
issues = [{ ...issues[0], user: { login: "another-user" } }];
calls = [];
assert.equal(await run(healthy), "healthy-no-incident");
assert.equal(calls.length, 1, "Never edit a manually created issue");
issues = [];
assert.equal(await run(null), "opened");
calls = [];
await run({ ...outage, rounds: [[{ service: "private-account-data" }]] });
assert.doesNotMatch(JSON.stringify(calls), /private-account-data/);
issues = [{ ...created, number: 42, user: { login: "github-actions[bot]" } }, { ...created, number: 43, user: { login: "github-actions[bot]" } }];
await assert.rejects(run(outage), /Multiple monitor incidents/);
await assert.rejects(syncIncident({ ...options, report: healthy, runUrl: "https://example.com" }), /Invalid incident/);
await assert.rejects(syncIncident({ ...options, report: healthy, fetchImpl: async () => new Response(null, { status: 403 }) }), /HTTP 403/);

// A sent comment with a lost acknowledgement or failed following PATCH must not be sent twice.
for (const report of [outage, healthy]) {
  for (const fault of ["lost-comment-reply", "failed-patch"]) {
    let current = { ...created, number: 42, user: { login: "github-actions[bot]" }, state: "open" };
    const comments = [];
    let failed = false;
    const replay = { ...options, report, fetchImpl: async (url, init) => {
      const isComments = new URL(url).pathname.endsWith("/comments");
      if (init.method === "GET") return Response.json(isComments ? comments : current.state === "open" ? [current] : []);
      if (init.method === "POST" && isComments) {
        const comment = { ...JSON.parse(init.body), user: { login: "github-actions[bot]" } };
        comments.push(comment);
        if (!failed && fault === "lost-comment-reply") { failed = true; throw new Error("lost acknowledgement"); }
        return Response.json(comment);
      }
      assert.equal(init.method, "PATCH");
      if (!failed && fault === "failed-patch") { failed = true; return new Response(null, { status: 503 }); }
      current = { ...current, ...JSON.parse(init.body) };
      return Response.json(current);
    } };
    await assert.rejects(syncIncident(replay), /lost acknowledgement|HTTP 503/);
    assert.equal(comments.length, 1);
    await syncIncident({ ...replay, runUrl: "https://github.com/danieldipalma88-web/calculator/actions/runs/124" });
    assert.equal(comments.length, 1, `${report.state}/${fault}: a later run must recognize the delivered notification`);
    assert.equal(report.state === "healthy" ? current.state === "closed" : current.body.includes("state:outage"), true);
  }
}
console.log("Origin incidents: slow/outage warnings, deduplication, recovery, unknown health and restricted public details passed.");
