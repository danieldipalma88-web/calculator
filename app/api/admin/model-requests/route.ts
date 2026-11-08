import { after, NextResponse } from "next/server";
import { canManageUsers } from "../../../../lib/admin";
import { getApprovedCalculatorSession } from "../../../../lib/supabase/approved-calculator-session";
import { processModelRequest } from "../../../../lib/model-request-worker";
import { researchAutomationEnabled, researchRpc } from "../../../../lib/model-request-research";

export const maxDuration = 300;
function json(body: unknown, status = 200) { return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } }); }
async function authorized() {
  const approval = await getApprovedCalculatorSession();
  return approval.status === 200 && canManageUsers(approval.session.email, approval.session.approvedUser.role) ? approval.session : null;
}
export async function GET(request: Request) {
  const session = await authorized();
  if (!session) return json({ error: "Not authorized" }, 403);
  const params = new URL(request.url).searchParams;
  const offset = Math.max(0, Math.min(100000, Number(params.get('offset')) || 0));
  const result = await session.supabase.rpc('admin_model_request_list', { p_filter: params.get('filter') || 'review', p_query: (params.get('q') || '').slice(0,180), p_offset: Math.floor(offset) });
  if (result.error) return json({ error: "Model requests could not be loaded. Please retry." }, 503);
  return json({ ...result.data, researchAutomation: {
    enabled: researchAutomationEnabled(),
    keyConfigured: Boolean(process.env.MODEL_RESEARCH_OPENAI_API_KEY),
  } });
}
export async function POST(request: Request) {
  const session = await authorized();
  if (!session) return json({ error: "Not authorized" }, 403);
  if (request.headers.get("origin") && request.headers.get("origin") !== new URL(request.url).origin) return json({ error: "Invalid origin" }, 403);
  const body = await request.json().catch(() => null);
  if (!body || !/^[0-9a-f-]{36}$/i.test(body.id || "") || !["retry", "decline", "disable", "restore_research"].includes(body.action)) return json({ error: "Invalid action" }, 400);
  if (body.action === "restore_research") {
    if (!researchAutomationEnabled()) return json({ error: "Research processing is not enabled." }, 409);
    if (typeof body.sourceJobId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.sourceJobId)
      || typeof body.sourceRequestText !== "string" || body.sourceRequestText.length > 8000
      || typeof body.resultText !== "string" || body.resultText.length > 64000) return json({ error: "Invalid research artifact" }, 400);
    try {
      await researchRpc("restore_prepaid", body.id, undefined, {
        source_job_id: body.sourceJobId, source_request_text: body.sourceRequestText, result_text: body.resultText,
      });
      after(async () => { await processModelRequest(body.id).catch(() => console.error("[model-research] restored verification deferred")); });
      return json({ saved: true, message: "Previously completed research restored. Current rebate verification queued." });
    } catch { return json({ error: "The artifact does not match the current request or has already been restored." }, 409); }
  }
  const result = await session.supabase.rpc("admin_model_request_action", { p_id: body.id, p_action: body.action });
  if (result.error) return json({ error: "The request changed or this action is unavailable. Refresh and try again." }, 409);
  if (body.action === "retry") after(async () => { await processModelRequest(body.id).catch(e => console.error("Model request retry failed", e.message)); });
  return json({ saved: true });
}
