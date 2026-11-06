import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = "danieldipalma88-web/calculator";
const OWNER = "danieldipalma88-web";
const MARKER = "<!-- rebate-service-incident:v1 -->";
const TITLE = "NSW rebate calculation service needs attention";

export function incidentState(report) {
  if (!report || typeof report.ok !== "boolean" || typeof report.degraded !== "boolean"
      || typeof report.primary?.verified !== "boolean" || typeof report.backup?.verified !== "boolean"
      || typeof report.registry?.verified !== "boolean"
      || typeof report.service?.available !== "boolean" || typeof report.certificate?.ok !== "boolean") return "monitor-incomplete";
  const available = (report.service.available && report.primary.verified || report.backup.verified) && report.registry.verified;
  const degraded = !report.service.available || !report.primary.verified || !report.certificate.ok || !report.backup.verified || !report.registry.verified;
  if (report.ok !== available || report.degraded !== degraded) return "monitor-incomplete";
  if (available && !degraded) return "healthy";
  return [available ? "degraded" : "outage", report.service.available, report.primary.verified,
    report.certificate.ok, report.backup.verified, report.registry.verified].join(":");
}

function bodyFor(report, runUrl, state) {
  const status = state === "monitor-incomplete" ? "The monitor did not finish; service health is unknown."
    : !report.ok ? "A required calculation or live model-search step failed verification. Investigate immediately."
    : "Calculations have a working service, but redundancy or certificate health needs attention.";
  return `${MARKER}\n<!-- state:${state} -->\n\n${status}\n\n`
    + `- Primary climate lookup: ${report?.service?.available === true ? "passed" : "not verified"}\n`
    + `- Primary certificate calculation: ${report?.primary?.verified === true ? "passed" : "not verified"}\n`
    + `- Primary TLS certificate: ${report?.certificate?.ok === true ? "healthy" : "requires attention"}\n`
    + `- Backup calculation and browser access: ${report?.backup?.verified === true ? "passed" : "not verified"}\n\n`
    + `- Live registered-model search: ${report?.registry?.verified === true ? "passed" : "not verified"}\n\n`
    + `[View the health-check results](${runUrl}). Only fixed public test inputs are used; no customer or account data is included.`;
}

export async function syncIncident({ report, runUrl, token, fetchImpl = fetch }) {
  if (!/^https:\/\/github\.com\/danieldipalma88-web\/calculator\/actions\/runs\/\d+$/.test(runUrl)) throw new Error("Invalid incident run URL");
  if (!token) throw new Error("GitHub incident token is missing");
  const api = async (route, method = "GET", body) => {
    const response = await fetchImpl(`https://api.github.com/repos/${REPO}${route}`, {
      method, redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok || response.redirected) throw new Error(`Incident API HTTP ${response.status}`);
    return response.json();
  };
  const state = incidentState(report);
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
  if (state === "healthy") {
    if (!incident) return "healthy-no-incident";
    await api(`/issues/${incident.number}/comments`, "POST", { body: `Both calculation services, certificate health and live model search now pass verification. [Recovery check](${runUrl}).` });
    await api(`/issues/${incident.number}`, "PATCH", { state: "closed", state_reason: "completed" });
    return "recovered";
  }
  const body = bodyFor(report, runUrl, state);
  if (!incident) {
    await api("/issues", "POST", { title: TITLE, body, assignees: [OWNER] });
    return "opened";
  }
  if (incident.body.includes(`<!-- state:${state} -->`)) return "unchanged";
  await api(`/issues/${incident.number}/comments`, "POST", { body: `@${OWNER} Calculation service health has changed.\n\n${body}` });
  await api(`/issues/${incident.number}`, "PATCH", { body });
  return "updated";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.GITHUB_REPOSITORY !== REPO || process.env.GITHUB_REF !== "refs/heads/main") throw new Error("Incident reporting is restricted to the production repository and branch");
  let report = null;
  try { report = JSON.parse(await readFile("rebate-health-report.json", "utf8")); } catch { /* Missing reports are monitor incidents, not healthy checks. */ }
  console.log(await syncIncident({ report, token: process.env.GITHUB_TOKEN,
    runUrl: `https://github.com/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}` }));
}
