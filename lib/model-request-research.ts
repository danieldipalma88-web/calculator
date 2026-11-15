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
  if (!response.ok) throw new Error(`Research continuation HTTP ${response.status}`);
}

export async function processModelResearch({ requestId, researchJobId, verificationOnly = false }: { requestId?: string; researchJobId?: string; verificationOnly?: boolean } = {}) {
  if (!researchAutomationEnabled()) return { processed: false, requestId };
  if (verificationOnly && !researchJobId) return { processed: false, requestId };
  const store = new PostgresResearchStore();
  let job = researchJobId ? await store.get(researchJobId) : await store.enqueue(requestId);
  if (!job || job.applied_at || ["complete", "no_rebate", "superseded"].includes(job.state)) {
    return { processed: false, requestId: job?.external_id, state: job?.state };
  }
  if (job.result?.researchPaused) return { processed: false, requestId: job.external_id, state: job.state };
  if (verificationOnly) {
    if (job.state !== "pending_verification") return { processed: false, requestId: job.external_id, state: job.state };
    return applyResearchVerification(store, job, false);
  }
  const externalId = job.external_id;
  if (job.state === "queued" || job.state === "researching") {
    const checkpointRound = Number(job.checkpoint?.round || 0);
    const recoveringTools = job.checkpoint?.pendingTools === true;
    const config = configuration({ ...process.env, OPENAI_API_KEY: process.env.MODEL_RESEARCH_OPENAI_API_KEY || "" });
    const agent = new ResearchAgent({ store, provider: new OpenAIProvider(config.apiKey), registry: new Registry(), config,
      maxDurationMs: 180_000 });
    job = await agent.run(job.id);
    if (!job) return { processed: false, requestId: externalId };
    if (job.result?.researchPaused) return { processed: true, requestId: externalId, state: job.state };
    // Finish checkpointed evidence here; another recursive HTTP hop is unnecessary.
    if (["pending_verification", "waiting_for_details", "review"].includes(job.state) && !job.applied_at) {
      return applyResearchVerification(store, job);
    }
    if (["queued", "budget_paused"].includes(job.state) && !job.applied_at) {
      if (job.state === "queued" && Number(job.checkpoint?.round || 0) <= checkpointRound
        && !(recoveringTools && job.checkpoint?.pendingTools === false)) {
        await store.event(job.id, "continuation_deferred", "No checkpoint progress; immediate retries stopped. The scheduled recovery pass can resume this investigation.");
      } else {
        try { await continueResearch(job.id); }
        catch (error) {
          const status = error instanceof Error ? error.message.match(/^Research continuation HTTP \d{3}$/)?.[0] : undefined;
          await store.event(job.id, "continuation_deferred", `${status || "Research continuation could not be reached"}. Scheduled recovery will resume from the checkpoint.`);
        }
      }
    }
    return { processed: true, requestId: externalId, state: job.state };
  }
  return applyResearchVerification(store, job);
}

async function applyResearchVerification(store: PostgresResearchStore, job: NonNullable<Awaited<ReturnType<PostgresResearchStore["get"]>>>, advanceQueue = true) {
  const externalId = job.external_id;
  const outcome = await verifyResearchJob(job, id => store.current(id));
  if (outcome.kind === "superseded") return { processed: true, requestId: externalId, state: "superseded" };
  const applied = await store.apply(job.id, outcome);
  if (advanceQueue && ["added", "no_rebate", "review", "waiting"].includes(String(applied?.state))
    && job.state !== "budget_paused" && outcome.kind !== "retry_verification") {
    try {
      const next = await store.enqueue();
      if (next && next.id !== job.id && !next.applied_at) await continueResearch(next.id);
    } catch {
      await store.event(job.id, "continuation_deferred", "The next eligible request will be picked up by scheduled recovery.");
    }
  }
  return { processed: true, requestId: externalId, state: String(applied?.state || "review") };
}

export async function researchHealth() {
  if (!researchAutomationEnabled()) return { enabled: false };
  const budget = await new PostgresResearchStore().budget();
  return { enabled: true, keyConfigured: Boolean(process.env.MODEL_RESEARCH_OPENAI_API_KEY), budget };
}
