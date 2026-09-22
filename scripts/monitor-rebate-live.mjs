import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LIVE_ORIGIN = "https://calculator.rebateportal.com.au";

export function verifyLiveCatalogue(source, catalogue) {
  const expected = crypto.createHash("sha256").update(source.replace(/\r\n/g, "\n")).digest("hex");
  assert.equal(catalogue.sourceVersion, expected, "Live release differs from the tested source; live coverage cannot be claimed");
  assert.ok(Array.isArray(catalogue.products) && catalogue.products.length > 0, "Live catalogue is empty");
  return expected;
}

async function readLive(endpoint, fetchImpl, json = true) {
  const response = await fetchImpl(`${LIVE_ORIGIN}${endpoint}`, {
    method: "GET", signal: AbortSignal.timeout(20_000), redirect: "error",
  });
  if (!response.ok) throw new Error(`Live endpoint returned HTTP ${response.status}`);
  return json ? response.json() : response.text();
}

export async function runLiveMonitor({ fetchImpl = fetch, source } = {}) {
  const report = {
    monitor: "weekly-rebate-live", startedAt: new Date().toISOString(),
    scope: "Public live release, login page and GEMS model search only. Formula checks run separately. No authenticated account, private pricing or browser UI coverage.",
    results: [], ok: false,
  };
  const cases = [
    ["live-catalogue-release", async () => {
      const html = source ?? await readFile(path.join(root, "index.html"), "utf8");
      report.sourceVersion = verifyLiveCatalogue(html, await readLive("/api/public-rebate-catalogue", fetchImpl));
    }],
    ["live-login-page", async () => {
      assert.match(await readLive("/", fetchImpl, false), /<html/i, "Live login page did not return HTML");
    }],
    ["live-gems-model-search", async () => {
      const search = await readLive("/api/gems-model-search?brand=DAIKIN&q=RZAS71C2V1", fetchImpl);
      assert.ok(search.models?.some(item => item.model.replace(/\s/g, "") === "RZAS71C2V1/FDYA71AV19"), "Live GEMS search did not return the known paired model");
    }],
  ];
  for (const [name, check] of cases) {
    const started = Date.now();
    try {
      await check();
      report.results.push({ case: name, status: "passed", durationMs: Date.now() - started });
    } catch (error) {
      report.results.push({ case: name, status: "failed", message: String(error.message).slice(0, 1000), durationMs: Date.now() - started });
    }
  }
  report.ok = report.results.every(result => result.status === "passed");
  report.finishedAt = new Date().toISOString();
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runLiveMonitor();
  await writeFile("rebate-live-report.json", `${JSON.stringify(report, null, 2)}\n`);
  const rows = report.results.map(row => `| ${row.case} | ${row.status} | ${String(row.message || "").replace(/[|\r\n]/g, " ")} |`);
  await writeFile("rebate-live-report.md", `## Live Rebate Service Check\n\n${report.scope}\n\nStatus: **${report.ok ? "PASS" : "FAIL"}**\n\n| Case | Result | Details |\n| --- | --- | --- |\n${rows.join("\n")}\n`);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
