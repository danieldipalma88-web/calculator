import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";

const example = parseEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"));
const origin = "https://oslczpfasvsjthdbqeob.supabase.co";
const key = example.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (example.NEXT_PUBLIC_SUPABASE_URL !== origin || !key?.startsWith("sb_publishable_")) {
  throw new Error("Verify the public project configuration before running the origin check.");
}

export const SLOW_MS = 3000;
export const DEADLINE_MS = 12000;

export async function checkOrigins(fetcher = fetch, now = () => performance.now()) {
  async function check(service, method, path, validate) {
    const start = now();
    let status = null;
    try {
      const response = await fetcher(origin + path, {
        method, redirect: "error", cache: "no-store", credentials: "omit",
        headers: { apikey: key, Accept: "application/json" }, signal: AbortSignal.timeout(DEADLINE_MS),
      });
      status = response.status;
      const ok = response.ok && !response.redirected && await validate(response);
      return { service, ok, status, ms: Math.round(now() - start) };
    } catch {
      return { service, ok: false, status, ms: Math.round(now() - start) };
    }
  }
  return Promise.all([
    check("auth", "GET", "/auth/v1/health", async r => {
      const result = await r.json();
      return result?.name === "GoTrue" && typeof result.version === "string";
    }),
    check("database", "HEAD", "/rest/v1/calculator_catalogue_additions?select=id&limit=0",
      r => r.headers.has("content-range")),
  ]);
}

export function classifyOrigins(rounds) {
  if (!Array.isArray(rounds) || ![1, 2].includes(rounds.length)) return "monitor-incomplete";
  for (const round of rounds) {
    if (!Array.isArray(round) || round.length !== 2 || !round.every((r, i) =>
      r?.service === ["auth", "database"][i] && typeof r.ok === "boolean"
      && Number.isFinite(r.ms) && r.ms >= 0
      && (r.status === null || Number.isInteger(r.status) && r.status >= 100 && r.status <= 599)
      && (!r.ok || r.status >= 200 && r.status < 300))) return "monitor-incomplete";
  }
  const unhealthy = round => round.some(r => !r.ok || r.ms >= SLOW_MS);
  if (!unhealthy(rounds[0])) return rounds.length === 1 ? "healthy" : "monitor-incomplete";
  if (rounds.length !== 2) return "monitor-incomplete";
  if (!unhealthy(rounds[1])) return "transient";
  return rounds.every(round => round.some(r => !r.ok)) ? "outage" : "slow";
}

export async function monitorOrigins({ check = checkOrigins, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const rounds = [await check()];
  if (rounds[0].some(r => !r.ok || r.ms >= SLOW_MS)) {
    // Confirm degradation once, without a retry loop that adds load to a struggling database.
    await sleep(5000);
    rounds.push(await check());
  }
  return { checkedAt: new Date().toISOString(), state: classifyOrigins(rounds), rounds };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await monitorOrigins();
  console.log(JSON.stringify(report));
  const output = process.argv.find(arg => arg.startsWith("--output="))?.slice(9);
  if (output) writeFileSync(output, JSON.stringify(report) + "\n");
  if (["outage", "monitor-incomplete", "slow"].includes(report.state)) process.exitCode = 1;
}
