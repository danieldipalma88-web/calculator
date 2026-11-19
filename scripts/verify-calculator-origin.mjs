import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkOrigins, classifyOrigins, monitorOrigins, SLOW_MS, DEADLINE_MS } from "./monitor-calculator-origin.mjs";

for (const scenario of ["ok", "522", "wrong-body", "partial", "network"]) {
  const calls = [];
  const result = await checkOrigins(async (url, init) => {
    calls.push([init.method, new URL(url).pathname]);
    assert.equal(new URL(url).origin, "https://oslczpfasvsjthdbqeob.supabase.co");
    assert.equal(init.credentials, "omit");
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    if (scenario === "network") throw new Error("unknown upstream error with potentially private data");
    if (scenario === "522" || (scenario === "partial" && init.method === "GET")) return new Response(null, { status: 522 });
    if (scenario === "wrong-body") return new Response("<html>OK</html>");
    if (init.method === "GET") return Response.json({ name: "GoTrue", version: "v2" });
    assert.equal(new URL(url).search, "?select=id&limit=0");
    return new Response(null, { headers: { "Content-Range": "*/*" } });
  });
  assert.deepEqual(calls, [["GET", "/auth/v1/health"], ["HEAD", "/rest/v1/calculator_catalogue_additions"]]);
  assert.equal(result[0].ok, scenario === "ok");
  assert.equal(result[1].ok, ["ok", "partial"].includes(scenario));
  assert.doesNotMatch(JSON.stringify(result), /private data|publishable/);
}
const healthy = [{ service: "auth", ok: true, status: 200, ms: 100 }, { service: "database", ok: true, status: 200, ms: 200 }];
const slow = healthy.map(r => ({ ...r, ms: SLOW_MS }));
const failed = healthy.map(r => ({ ...r, ok: false, status: null, ms: DEADLINE_MS }));
for (const [rounds, expected] of [
  [[healthy], "healthy"], [[slow, slow], "slow"], [[failed, failed], "outage"],
  [[failed, slow], "slow"], [[failed, healthy], "transient"], [[slow, healthy], "transient"],
  [[slow], "monitor-incomplete"], [[healthy, healthy], "monitor-incomplete"],
  [[[]], "monitor-incomplete"], [null, "monitor-incomplete"],
  [[healthy.map(r => ({ ...r, status: 522 }))], "monitor-incomplete"],
]) assert.equal(classifyOrigins(rounds), expected);
for (const [rounds, expected] of [[[healthy], "healthy"], [[failed, failed], "outage"], [[slow, slow], "slow"], [[failed, healthy], "transient"]]) {
  let calls = 0;
  let sleeps = 0;
  const report = await monitorOrigins({ check: async () => rounds[calls++], sleep: async ms => { assert.equal(ms, 5000); sleeps++; } });
  assert.equal(report.state, expected);
  assert.equal(calls, rounds.length);
  assert.equal(sleeps, rounds.length - 1);
  assert.ok(!Number.isNaN(Date.parse(report.checkedAt)));
}
const workflow = readFileSync(new URL("../.github/workflows/calculator-origin-health.yml", import.meta.url), "utf8");
assert.match(workflow, /cron: '4,14,24,34,44,54/);
assert.match(workflow, /issues: write/);
assert.match(workflow, /needs: read-only-health/);
assert.match(workflow, /always\(\).*github\.repository == 'danieldipalma88-web\/calculator'/);
assert.match(workflow, /github\.event\.repository\.private == false/);
assert.match(workflow, /persist-credentials: false/);
assert.doesNotMatch(workflow, /SUPABASE_SERVICE|DATABASE_URL|RESEND_API|pull_request_target/);
console.log("Origin monitor: healthy, confirmed slow/outage, transient recovery, invalid 200, bounded retry, no writes or customer data passed.");
