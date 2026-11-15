import type { SupabaseClient } from "@supabase/supabase-js";
import type { WonBatchOutcome } from "./won-batches";

type LeaseAction = {
  batchId: string;
  token: string;
} & ({ action: "claim" | "record"; outcomes: WonBatchOutcome[] }
  | { action: "check" | "release"; outcomes?: never });

export async function manageWonBatchLease(supabase: SupabaseClient, change: LeaseAction): Promise<boolean> {
  if ((change.action === "claim" || change.action === "record") !== Array.isArray(change.outcomes)) return false;
  try {
    const result = await supabase.rpc("manage_won_batch_lease", {
      p_batch_id: change.batchId,
      p_token: change.token,
      p_action: change.action,
      ...(change.outcomes === undefined ? {} : { p_outcomes: change.outcomes }),
    }).abortSignal(AbortSignal.timeout(4_000));
    return !result.error && result.data === true;
  } catch {
    // An unacknowledged claim or append does not authorise further writes.
    return false;
  }
}
