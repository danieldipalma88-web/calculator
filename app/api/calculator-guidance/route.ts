import { NextResponse } from "next/server";
import { getApprovedCalculatorSession } from "../../../lib/supabase/approved-calculator-session";

const CALCULATOR_GUIDANCE_KEY = "quote_calculator_estimates_notice";
const CALCULATOR_GUIDANCE_VERSION = 1;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function GET() {
  const approval = await getApprovedCalculatorSession();
  if (approval.status !== 200) return json({ error: approval.error }, approval.status);
  const { supabase, user } = approval.session;

  const result = await supabase
    .from("calculator_user_acknowledgements")
    .select("acknowledged_at")
    .eq("user_id", user.id)
    .eq("acknowledgement_key", CALCULATOR_GUIDANCE_KEY)
    .eq("acknowledgement_version", CALCULATOR_GUIDANCE_VERSION)
    .maybeSingle();

  if (result.error) return json({ error: "The calculator notice could not be checked." }, 503);
  return json({
    acknowledgementKey: CALCULATOR_GUIDANCE_KEY,
    acknowledgementVersion: CALCULATOR_GUIDANCE_VERSION,
    acknowledged: Boolean(result.data),
    acknowledgedAt: result.data?.acknowledged_at || null,
  });
}

export async function POST(request: Request) {
  const approval = await getApprovedCalculatorSession();
  if (approval.status !== 200) return json({ error: approval.error }, approval.status);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (body?.accepted !== true || Number(body?.acknowledgementVersion) !== CALCULATOR_GUIDANCE_VERSION) {
    return json({ error: "Confirm that you understand the calculator notice." }, 400);
  }

  const { supabase, user, email } = approval.session;
  const result = await supabase.from("calculator_user_acknowledgements").insert({
    user_id: user.id,
    user_email: email,
    acknowledgement_key: CALCULATOR_GUIDANCE_KEY,
    acknowledgement_version: CALCULATOR_GUIDANCE_VERSION,
  });

  if (result.error && result.error.code !== "23505") {
    return json({ error: "Your acknowledgement could not be saved. Please try again." }, 503);
  }
  return json({ acknowledged: true, acknowledgementVersion: CALCULATOR_GUIDANCE_VERSION });
}
