import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export const WON_BATCH_MAX_JOBS = 50;
export const WON_BATCH_PAGE_SIZE = 15;
export const WON_BATCH_LABELS = {
  manual: "Manual group",
  payment_requested: "Payment request",
  paid_in: "Payment received",
  paid_out: "Commission paid",
} as const;
export type WonBatchKind = keyof typeof WON_BATCH_LABELS;
export type WonBatchItem = { id: string; quote: string; salesperson: string; recovered: boolean };
export type WonBatchOutcome = { id: string; status: "confirmed" | "already_recorded" | "failed"; detail?: string };
export type WonBatch = {
  id: string;
  actor_email: string;
  created_at: string;
  kind: WonBatchKind;
  label: string;
  items: WonBatchItem[];
  outcomes: WonBatchOutcome[];
};

const JOB_ID = /^[0-9a-f]{64}$/;
const BATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BATCH_SELECT = "id, actor_email, created_at, kind, label, items, outcomes";

export function isWonBatchId(value: unknown): value is string {
  return typeof value === "string" && BATCH_ID.test(value);
}

export function isWonBatchKind(mode: string): mode is WonBatchKind {
  return Object.hasOwn(WON_BATCH_LABELS, mode);
}

export function wonBatchJobId(job: { userEmail: string; dataUserId: string; dataOwnerEmail: string; optionId: string; wonAt: string }) {
  // Deliberately independent of the snapshot location, like the existing won
  // payment and tombstone identity. Re-winning a quote is a different job.
  return createHash("sha256").update(JSON.stringify([
    job.dataUserId || job.dataOwnerEmail.toLowerCase() || job.userEmail.toLowerCase(),
    job.userEmail.toLowerCase(), job.optionId, job.wonAt,
  ])).digest("hex");
}

export function wonPaymentReviewFingerprint(
  job: {
    userEmail: string; userName: string; dataUserId: string; dataOwnerEmail: string; sourceId: string;
    optionId: string; wonAt: string; recoveredFromBackup: boolean; paymentFields: object;
  },
  amounts: object,
  sourceOption: Record<string, unknown>,
  sourceRows: Record<string, unknown>[],
) {
  const payload = [job.dataUserId, job.dataOwnerEmail, job.userEmail, job.userName, job.sourceId,
    job.optionId, job.wonAt, job.recoveredFromBackup, job.paymentFields, amounts, sourceOption, sourceRows];
  return createHash("sha256").update(JSON.stringify(payload, (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : value)).digest("hex");
}

export function parseWonBatchIds(value: unknown): string[] | null {
  if (typeof value !== "string" || value.length > WON_BATCH_MAX_JOBS * 68 + 2) return null;
  try {
    const ids: unknown = JSON.parse(value);
    if (!Array.isArray(ids) || !ids.length || ids.length > WON_BATCH_MAX_JOBS
      || ids.some((id) => typeof id !== "string" || !JOB_ID.test(id)) || new Set(ids).size !== ids.length) return null;
    return ids;
  } catch {
    return null;
  }
}

export function resolveWonBatchJobs<T extends Parameters<typeof wonBatchJobId>[0]>(ids: string[], jobs: T[]) {
  const byId = new Map(jobs.map((job) => [wonBatchJobId(job), job]));
  const selected = ids.map((id) => byId.get(id));
  return selected.every((job) => job !== undefined) ? selected : null;
}

type BatchIntent = Pick<WonBatch, "id" | "kind" | "label" | "items">;

export function sameWonBatchSelection(saved: WonBatch, kind: WonBatchKind, label: string, ids: string[], actorEmail: string) {
  const selected = new Set(ids);
  return saved.actor_email === actorEmail && saved.kind === kind && saved.label === label
    && saved.items.length === selected.size && saved.items.every(({ id }) => selected.has(id));
}

export async function runWonBatch(
  intent: BatchIntent,
  operations: {
    start: (intent: BatchIntent) => Promise<"created" | "replayed" | "conflict" | "unavailable">;
    apply: (item: WonBatchItem, index: number) => Promise<Omit<WonBatchOutcome, "id">>;
    record: (outcomes: WonBatchOutcome[]) => Promise<boolean>;
  },
) {
  const outcomes: WonBatchOutcome[] = [];
  let started: Awaited<ReturnType<typeof operations.start>>;
  try { started = await operations.start(intent); }
  catch { started = "unavailable"; }
  if (started !== "created") return { status: started, outcomes };
  if (intent.kind === "manual") return { status: "saved", outcomes } as const;

  for (const [index, item] of intent.items.entries()) {
    try {
      const outcome = { ...await operations.apply(item, index), id: item.id };
      if (!await operations.record([...outcomes, outcome])) return { status: "interrupted", outcomes } as const;
      outcomes.push(outcome);
    } catch {
      // The update could have reached the database even if its reply was lost.
      return { status: "interrupted", outcomes } as const;
    }
  }
  return { status: "saved", outcomes } as const;
}

export async function getWonBatch(supabase: SupabaseClient, id: string) {
  const result = await supabase.from("won_job_batches").select(BATCH_SELECT).eq("id", id).maybeSingle();
  return { batch: result.data as WonBatch | null, error: result.error };
}

export async function listWonBatches(supabase: SupabaseClient, page: number) {
  const offset = (page - 1) * WON_BATCH_PAGE_SIZE;
  const result = await supabase.from("won_job_batches").select(BATCH_SELECT)
    .order("created_at", { ascending: false }).order("id", { ascending: false })
    .range(offset, offset + WON_BATCH_PAGE_SIZE);
  const batches = (result.data || []) as WonBatch[];
  return {
    batches: batches.slice(0, WON_BATCH_PAGE_SIZE),
    hasMore: batches.length > WON_BATCH_PAGE_SIZE,
    unavailable: Boolean(result.error),
  };
}

export async function startWonBatch(supabase: SupabaseClient, intent: BatchIntent, actorEmail: string) {
  const result = await supabase.from("won_job_batches").insert(intent);
  if (!result.error) return "created";
  if (result.error.code !== "23505") return "unavailable";
  const { batch, error } = await getWonBatch(supabase, intent.id);
  if (error) return "unavailable";
  return batch && sameWonBatchSelection(batch, intent.kind, intent.label, intent.items.map(({ id }) => id), actorEmail)
    ? "replayed" : "conflict";
}

export async function recordWonBatchOutcomes(supabase: SupabaseClient, id: string, outcomes: WonBatchOutcome[]) {
  const result = await supabase.from("won_job_batches").update({ outcomes })
    .eq("id", id).eq("outcome_count", outcomes.length - 1).select("id").maybeSingle();
  return !result.error && result.data?.id === id;
}
