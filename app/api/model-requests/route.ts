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
  if (automationQueued) after(async () => {
    try { await processModelRequest(requestId); }
    catch { console.error("[model-request] processing deferred", { requestId }); }
  });
  return json({ saved: true, requestId, automationQueued }, 201);
}
