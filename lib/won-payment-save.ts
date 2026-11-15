import type { SupabaseClient } from "@supabase/supabase-js";

type OverlaySave = {
  ownerColumn: "user_id" | "email";
  ownerValue: string;
  storageKey: string;
  overlay: unknown;
  previousUpdatedAt: string | null;
  batchLease?: { batchId: string; token: string };
};

const OVERLAY_KEYS = new Set([
  "installerWonOptionAdminStateV1", "greenEnergyWonOptionAdminStateV1", "WonOptionAdminStateV1",
]);
const RPC = "save_won_payment_overlay";
const WRITE_MS = 6_000;
const READBACK_MS = 4_000;
const MAX_OVERLAY_BYTES = 2_097_152;
const CHANGE_CONFLICT = "This calculator changed during the update. Refresh Won Jobs and review the current status; no payment change was saved.";

type RpcResult = { data: unknown; error: { code?: string } | null };

async function callOverlay(supabase: SupabaseClient, args: Record<string, unknown>, timeoutMs: number) {
  const signal = AbortSignal.timeout(timeoutMs);
  return new Promise<RpcResult | null>((resolve) => {
    const settle = (result: RpcResult | null) => {
      signal.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = () => settle(null);
    signal.addEventListener("abort", abort, { once: true });
    try {
      Promise.resolve(supabase.rpc(RPC, args).abortSignal(signal)).then(settle, abort);
    } catch {
      abort();
    }
  });
}

function overlayStatus(result: RpcResult | null) {
  if (!result || result.error || !result.data || typeof result.data !== "object") return null;
  const data = result.data as { status?: unknown; updated_at?: unknown };
  if (data.status === "saved") return typeof data.updated_at === "string" && data.updated_at ? "saved" : null;
  return data.status === "conflict" || data.status === "lease_lost" ? data.status : null;
}

export async function saveWonPaymentOverlay(supabase: SupabaseClient, change: OverlaySave): Promise<string> {
  if (!OVERLAY_KEYS.has(change.storageKey) || !change.ownerValue.trim()
    || (change.ownerColumn !== "user_id" && change.ownerColumn !== "email")) {
    return "Could not identify the Won Jobs payment status to save.";
  }
  let overlay: string | undefined;
  try { overlay = typeof change.overlay === "string" ? change.overlay : JSON.stringify(change.overlay); }
  catch { return "The Won Jobs payment status could not be prepared."; }
  if (!overlay || Buffer.byteLength(overlay, "utf8") > MAX_OVERLAY_BYTES) {
    return "The Won Jobs payment status could not be prepared.";
  }
  const args = {
    p_owner_id: change.ownerColumn === "user_id" ? change.ownerValue.trim() : null,
    p_owner_email: change.ownerColumn === "email" ? change.ownerValue.trim().toLowerCase() : null,
    p_storage_key: change.storageKey,
    p_expected_updated_at: change.previousUpdatedAt,
    p_overlay: overlay,
    ...(change.batchLease ? { p_batch_id: change.batchLease.batchId, p_batch_token: change.batchLease.token } : {}),
  };
  let result = await callOverlay(supabase, args, WRITE_MS);
  if (result?.error?.code === "57014") {
    // A database-confirmed statement cancellation is rolled back. Retry only
    // the original bytes and CAS once; loss of the response is not cancellation.
    result = await callOverlay(supabase, args, WRITE_MS);
  }
  if (overlayStatus(result) === "saved") return "";
  if (overlayStatus(result) === "conflict") return CHANGE_CONFLICT;
  if (overlayStatus(result) === "lease_lost") return "The batch lease ended; no payment change was saved. Review the current batch before resuming.";
  switch (result?.error?.code) {
    case "57014": return "The payment status save timed out; no payment change was saved.";
    case "55P03": return "The calculator was busy; no payment change was saved. Refresh Won Jobs before trying again.";
    case "42501": return "You are not authorised to record this payment status.";
    case "22023":
    case "22008":
    case "22007":
    case "22P02": return "The payment status did not pass validation; no payment change was saved.";
    case "PGRST202":
    case "42883": return "Payment status storage is unavailable; no payment change was saved.";
  }

  const readback = await callOverlay(supabase, { ...args, p_readback: true }, READBACK_MS);
  if (overlayStatus(readback) === "saved") return "";
  throw new Error("Payment update not confirmed. Review the current Won Jobs status before retrying.");
}
