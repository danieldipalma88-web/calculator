import { after, NextResponse } from "next/server";
import { modelAutomationEnabled, processModelRequest } from "../../../lib/model-request-worker";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canManageUsers, isOwnerEmail } from "../../../lib/admin";
import {
  getApprovedCalculatorSession,
  type ApprovedCalculatorUser,
} from "../../../lib/supabase/approved-calculator-session";

const REQUEST_LIMIT = 5;
const REQUEST_WINDOW_MINUTES = 15;
const REQUEST_RECIPIENT = "danieldipalma88@gmail.com";
export const maxDuration = 300;

type ModelRequestBody = {
  clientRequestId?: unknown;
  businessId?: unknown;
  systemType?: unknown;
  brand?: unknown;
  model?: unknown;
  capacity?: unknown;
  phase?: unknown;
  notes?: unknown;
  postcode?: unknown;
  installType?: unknown;
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function text(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function validUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function resolveBusiness(
  supabase: SupabaseClient,
  email: string,
  approvedUser: ApprovedCalculatorUser,
  requestedBusinessId: string,
) {
  const businessId = requestedBusinessId || String(approvedUser.business_id || "");
  if (!businessId) return { id: null, name: "" };

  const canUseAnyBusiness = isOwnerEmail(email) || canManageUsers(email, approvedUser.role);
  if (!canUseAnyBusiness) {
    const membership = await supabase
      .from("approved_user_businesses")
      .select("business_id")
      .eq("email", email)
      .eq("business_id", businessId)
      .maybeSingle();
    const isPrimaryBusiness = approvedUser.business_id === businessId;
    if (membership.error || (!membership.data && !isPrimaryBusiness)) return null;
  }

  const business = await supabase.from("businesses").select("id, name").eq("id", businessId).maybeSingle();
  if (business.error || !business.data) return null;
  return { id: String(business.data.id), name: String(business.data.name || "") };
}

function modelRequestEmailHtml(details: Record<string, string>) {
  const rows = [
    ["System type", details.systemType],
    ["Brand", details.brand],
    ["Model", details.model],
    ["Capacity", details.capacity || "Not supplied"],
    ["Phase", details.phase || "Not applicable"],
    ["Notes", details.notes || "None"],
    ["Requested by", details.requesterName || details.requesterEmail],
    ["Email", details.requesterEmail],
    ["Business", details.businessName || "No active business"],
    ["Submitted", details.submittedAt],
  ];
  return `<!doctype html><html><body style="margin:0;background:#f3f6f8;font-family:Arial,sans-serif;color:#0f172a"><div style="max-width:620px;margin:0 auto;padding:32px 18px"><div style="background:#fff;border:1px solid #dbe4ec;border-radius:10px;overflow:hidden"><div style="padding:24px 26px;background:#0f766e;color:#fff"><div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">Rebate Portal</div><h1 style="margin:7px 0 0;font-size:24px">Missing model request</h1></div><div style="padding:24px 26px"><p style="margin:0 0 18px;color:#475569;line-height:1.5">A calculator user has requested a model for review.</p><table style="width:100%;border-collapse:collapse">${rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:10px 12px;border-top:1px solid #e5edf3;color:#64748b;font-size:12px;font-weight:700;vertical-align:top;width:34%">${escapeHtml(label)}</td><td style="padding:10px 12px;border-top:1px solid #e5edf3;font-size:14px;line-height:1.45">${escapeHtml(value)}</td></tr>`,
    )
    .join("")}</table></div></div></div></body></html>`;
}

async function sendModelRequestEmail(details: Record<string, string>) {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured");
  const from = String(process.env.MODEL_REQUEST_FROM_EMAIL || "").trim();
  if (!['notifications@mail.rebateportal.com.au','Rebate Portal <notifications@mail.rebateportal.com.au>'].includes(from)) throw new Error("Branded model-request sender is not configured");
  const to = String(process.env.MODEL_REQUEST_TO_EMAIL || REQUEST_RECIPIENT).trim();
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `model-request-review/${details.requestId}`,
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `Missing calculator model: ${details.brand} ${details.model}`,
      html: modelRequestEmailHtml(details),
      reply_to: details.requesterEmail,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const result = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!response.ok) throw new Error(result.message || `Resend returned ${response.status}`);
  return String(result.id || "");
}

export async function POST(request: Request) {
  const approval = await getApprovedCalculatorSession();
  if (approval.status !== 200) return json({ error: approval.error }, approval.status);
  const body = (await request.json().catch(() => null)) as ModelRequestBody | null;
  if (!body) return json({ error: "Enter the missing model details." }, 400);

  const clientRequestId = text(body.clientRequestId, 40);
  const requestedBusinessId = text(body.businessId, 40);
  const systemType = text(body.systemType, 24).toLowerCase();
  const brand = text(body.brand, 100);
  const model = text(body.model, 180);
  const capacity = text(body.capacity, 40);
  const phase = text(body.phase, 20).toLowerCase();
  const notes = text(body.notes, 600);
  const postcode = text(body.postcode, 4);
  const installType = text(body.installType, 20);
  if (postcode && !/^\d{4}$/.test(postcode)) return json({ error: "Enter a four-digit postcode." }, 400);
  if (installType && !["new", "replacement"].includes(installType)) return json({ error: "Choose new or replacement." }, 400);
  if (!validUuid(clientRequestId)) return json({ error: "Please reopen the request form and try again." }, 400);
  if (!(["split", "ducted", "multi-head"] as string[]).includes(systemType)) {
    return json({ error: "Choose a valid system type." }, 400);
  }
  if (!brand || !model) return json({ error: "Brand and model are required." }, 400);
  if (!(["", "single", "three", "unknown"] as string[]).includes(phase)) {
    return json({ error: "Choose a valid phase." }, 400);
  }

  const { supabase, user, email, approvedUser } = approval.session;
  const existing = await supabase
    .from("calculator_model_requests")
    .select("id, notification_status")
    .eq("user_id", user.id)
    .eq("client_request_id", clientRequestId)
    .maybeSingle();
  if (existing.data?.id) {
    return json({ saved: true, requestId: existing.data.id, notificationStatus: existing.data.notification_status, automationQueued: modelAutomationEnabled() });
  }

  const since = new Date(Date.now() - REQUEST_WINDOW_MINUTES * 60_000).toISOString();
  const recent = await supabase
    .from("calculator_model_requests")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .gte("created_at", since);
  if (!recent.error && Number(recent.count || 0) >= REQUEST_LIMIT) {
    return json({ error: "You have sent several requests recently. Please wait a few minutes." }, 429);
  }

  const business = await resolveBusiness(supabase, email, approvedUser, requestedBusinessId);
  if (business === null) return json({ error: "The selected business could not be verified." }, 403);
  const requesterName = String(approvedUser.display_name || email).trim();
  const inserted = await supabase
    .from("calculator_model_requests")
    .insert({
      user_id: user.id,
      client_request_id: clientRequestId,
      requester_email: email,
      requester_name: requesterName,
      business_id: business.id,
      business_name: business.name,
      system_type: systemType,
      brand,
      model,
      capacity,
      phase: systemType === "ducted" ? phase || "unknown" : "",
      notes,
      postcode,
      install_type: installType,
    })
    .select("id")
    .single();

  if (inserted.error || !inserted.data?.id) {
    if (inserted.error?.code === "23505") {
      const duplicate = await supabase
        .from("calculator_model_requests")
        .select("id, notification_status")
        .eq("user_id", user.id)
        .eq("client_request_id", clientRequestId)
        .maybeSingle();
      if (duplicate.data?.id) {
        return json({ saved: true, requestId: duplicate.data.id, notificationStatus: duplicate.data.notification_status });
      }
    }
    return json({ error: "Your request could not be saved. Please try again." }, 503);
  }

  const requestId = String(inserted.data.id);
  const automationQueued = modelAutomationEnabled();
  after(async () => {
  if (automationQueued) {
    try {
      const outcome = await processModelRequest(requestId);
      if (outcome.state === "added" || outcome.state === "email_pending") return;
    } catch (error) { console.error("[model-request] verification queued for retry", { requestId, error: error instanceof Error ? error.message : "Worker unavailable" }); }
  }
  let notificationStatus = "sent";
  let notificationError = "";
  try {
    await sendModelRequestEmail({
      requestId,
      systemType,
      brand,
      model,
      capacity,
      phase: systemType === "ducted" ? phase || "unknown" : "",
      notes,
      requesterName,
      requesterEmail: email,
      businessName: business.name,
      submittedAt: new Intl.DateTimeFormat("en-AU", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Australia/Sydney",
      }).format(new Date()),
    });
  } catch (error) {
    notificationStatus = "failed";
    notificationError = error instanceof Error ? error.message.slice(0, 400) : "Email notification failed";
    console.error("[model-request] notification failed", { requestId, notificationError });
  }

  const now = new Date().toISOString();
  await supabase
    .from("calculator_model_requests")
    .update({
      notification_status: notificationStatus,
      notification_attempted_at: now,
      notification_sent_at: notificationStatus === "sent" ? now : null,
      notification_error: notificationError,
      updated_at: now,
    })
    .eq("id", requestId)
    .eq("user_id", user.id);
  });
  return json({ saved: true, requestId, automationQueued }, 201);
}
