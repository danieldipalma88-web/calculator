import { ResearchAgent } from "./model-research/agent.mjs";
import { configuration } from "./model-research/config.mjs";
import { OpenAIProvider } from "./model-research/provider.mjs";
import { Registry } from "./model-research/registry.mjs";
import { PostgresResearchStore } from "./model-research/store";
import { verifyResearchJob } from "./model-research/verification";

export function researchAutomationEnabled() {
  return process.env.MODEL_RESEARCH_ENABLED === "true";
}

export async function researchRpc(action: string, id?: string, lease?: string, data: unknown = {}) {
  return new PostgresResearchStore().rpc(action, id, lease, data);
}

async function continueResearch(jobId: string) {
  if (process.env.VERCEL_ENV !== "production" || !researchAutomationEnabled()) return;
  const secret = process.env.MODEL_REQUEST_WORKER_SECRET;
  if (!secret || secret.length < 40) throw new Error("Research continuation is not configured");
  const response = await fetch("https://calculator.rebateportal.com.au/api/internal/model-research", {
    method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(8_000),
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jobId }),
  });
  if (!response.ok) throw new Error("Research continuation was not acknowledged");
}

export async function processModelResearch({ requestId, researchJobId }: { requestId?: string; researchJobId?: string } = {}) {
  if (!researchAutomationEnabled()) return { processed: false, requestId };
  const store = new PostgresResearchStore();
  let job = researchJobId ? await store.get(researchJobId) : await store.enqueue(requestId);
  if (!job || job.applied_at || ["complete", "no_rebate", "superseded"].includes(job.state)) {
    return { processed: false, requestId: job?.external_id, state: job?.state };
  }
  const externalId = job.external_id;
  if (job.state === "queued" || job.state === "researching") {
    const checkpointRound = Number(job.checkpoint?.round || 0);
    const config = configuration({ ...process.env, OPENAI_API_KEY: process.env.MODEL_RESEARCH_OPENAI_API_KEY || "" });
    const agent = new ResearchAgent({ store, provider: new OpenAIProvider(config.apiKey), registry: new Registry(), config,
      maxDurationMs: 180_000 });
    job = await agent.run(job.id);
    if (!job) return { processed: false, requestId: externalId };
    if (["queued", "pending_verification", "waiting_for_details", "review", "budget_paused"].includes(job.state) && !job.applied_at) {
      if (job.state === "queued" && Number(job.checkpoint?.round || 0) <= checkpointRound) {
        await store.event(job.id, "continuation_deferred", "No checkpoint progress; immediate retries stopped. The scheduled recovery pass can resume this investigation.");
      } else {
        try { await continueResearch(job.id); }
        catch { await store.event(job.id, "continuation_deferred", "The durable queue will resume this investigation on the scheduled recovery pass."); }
      }
    }
    return { processed: true, requestId: externalId, state: job.state };
  }
  const outcome = await verifyResearchJob(job, id => store.current(id));
  if (outcome.kind === "superseded") return { processed: true, requestId: externalId, state: "superseded" };
  const safeOutcome = outcome.kind === "retry_verification"
    ? { kind: "review", reason: outcome.reason, evidence: { research: job.result, temporaryVerificationFailure: true } }
    : outcome;
  const applied = await store.apply(job.id, safeOutcome);
  return { processed: true, requestId: externalId, state: String(applied?.state || "review") };
}

export async function researchHealth() {
  if (!researchAutomationEnabled()) return { enabled: false };
  const budget = await new PostgresResearchStore().budget();
  return { enabled: true, keyConfigured: Boolean(process.env.MODEL_RESEARCH_OPENAI_API_KEY), budget };
}
