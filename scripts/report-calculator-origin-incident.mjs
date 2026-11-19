import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { classifyOrigins } from "./monitor-calculator-origin.mjs";

const REPO = "danieldipalma88-web/calculator";
const OWNER = "danieldipalma88-web";
const MARKER = "<!-- calculator-origin-incident:v1 -->";
const TITLE = "Calculator sign-in or database needs attention";

export function incidentState(report) {
  const state = classifyOrigins(report?.rounds);
  return report?.state === state ? state : "monitor-incomplete";
}

function bodyFor(report, runUrl, state) {
  const description = state === "outage" ? "Read-only service checks failed twice. Sign-in or saved-data access may be affected."
    : state === "slow" ? "Service checks were slow or unreliable twice. Investigate before this becomes an outage."
    : "The health check did not finish correctly. Service health is unknown.";
  const results = state === "monitor-incomplete" ? [] : report.rounds.at(-1);
  return `${MARKER}\n<!-- state:${state} -->\n\n${description}\n\n`
    + results.map(r => `- ${r.service === "auth" ? "Authentication service" : "Database API"}: ${r.ok ? "reachable" : "not verified"}; ${r.ms} ms; HTTP ${r.status ?? "unavailable"}.`).join("\n")
    + `\n\n[Health-check results](${runUrl}). Warning threshold: 3 seconds, confirmed once after 5 seconds. No account, quote or price data is read or written. These checks do not send login codes or restart services.`;
}

export async function syncIncident({ report, runUrl, token, fetchImpl = fetch }) {
  if (!/^https:\/\/github\.com\/danieldipalma88-web\/calculator\/actions\/runs\/\d+$/.test(runUrl)) throw new Error("Invalid incident run URL");
  if (!token) throw new Error("GitHub incident token is missing");
  const api = async (route, method = "GET", body) => {
    const response = await fetchImpl(`https://api.github.com/repos/${REPO}${route}`, {
      method, redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok || response.redirected) throw new Error(`Incident API HTTP ${response.status}`);
    return response.json();
  };
  const incidents = [];
  for (let page = 1; ; page++) {
    if (page > 10) throw new Error("Issue inventory exceeds safe limit; no incident was changed");
    const rows = await api(`/issues?state=open&creator=github-actions%5Bbot%5D&per_page=100&page=${page}`);
    if (!Array.isArray(rows)) throw new Error("Invalid incident issue inventory");
    incidents.push(...rows.filter(row => !row.pull_request && row.user?.login === "github-actions[bot]"
      && row.title === TITLE && row.body?.startsWith(MARKER)));
    if (rows.length < 100) break;
  }
  if (incidents.length > 1) throw new Error("Multiple monitor incidents need manual review");
  const incident = incidents[0];
  const state = incidentState(report);
  async function notifyTransition(body) {
    // The previous issue body stays stable until PATCH succeeds, including after a lost reply.
    const fingerprint = createHash("sha256").update(incident.body + "\n" + state).digest("hex");
    const marker = `<!-- calculator-origin-transition:${fingerprint} -->`;
    for (let page = 1; ; page++) {
      if (page > 10) throw new Error("Comment inventory exceeds safe limit; no notification was sent");
      const comments = await api(`/issues/${incident.number}/comments?per_page=100&page=${page}`);
      if (!Array.isArray(comments)) throw new Error("Invalid incident comment inventory");
      if (comments.some(comment => comment.user?.login === "github-actions[bot]" && comment.body?.startsWith(marker))) return;
      if (comments.length < 100) break;
    }
    await api(`/issues/${incident.number}/comments`, "POST", { body: `${marker}\n${body}` });
  }
  // A recovered retry alone must not close an existing incident; wait for a clean scheduled check.
  if (state === "transient") return "transient-no-change";
  if (state === "healthy") {
    if (!incident) return "healthy-no-incident";
    await notifyTransition(`Authentication and database read-only checks are healthy again. [Recovery check](${runUrl}).`);
    await api(`/issues/${incident.number}`, "PATCH", { state: "closed", state_reason: "completed" });
    return "recovered";
  }
  const body = bodyFor(report, runUrl, state);
  if (!incident) {
    await api("/issues", "POST", { title: TITLE, body, assignees: [OWNER] });
    return "opened";
  }
  if (incident.body.includes(`<!-- state:${state} -->`)) return "unchanged";
  await notifyTransition(`@${OWNER} Calculator service health has changed.\n\n${body}`);
  await api(`/issues/${incident.number}`, "PATCH", { body });
  return "updated";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.GITHUB_REPOSITORY !== REPO || process.env.GITHUB_REF !== "refs/heads/main") throw new Error("Incident reporting is restricted to the production repository and branch");
  let report = null;
  try { report = JSON.parse(await readFile("calculator-origin-report.json", "utf8")); } catch { /* Missing output is unknown health, never recovery. */ }
  console.log(await syncIncident({ report, token: process.env.GITHUB_TOKEN,
    runUrl: `https://github.com/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}` }));
}
