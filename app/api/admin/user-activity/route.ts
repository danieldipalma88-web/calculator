import { NextResponse } from "next/server";
import { canManageUsers } from "../../../../lib/admin";
import { getApprovedCalculatorSession } from "../../../../lib/supabase/approved-calculator-session";

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function GET() {
  const access = await getApprovedCalculatorSession();
  if (access.status !== 200) return noStoreJson({ error: access.error }, access.status);
  const { supabase, email, approvedUser } = access.session;
  if (!canManageUsers(email, approvedUser.role)) {
    return noStoreJson({ error: "Not authorized" }, 403);
  }

  const result = await supabase.rpc("admin_list_approved_user_activity");
  if (result.error) return noStoreJson({ error: "User activity is temporarily unavailable." }, 503);
  const activity = (result.data || []).map((row: { email: string; last_active_at: string | null }) => ({
    email: row.email,
    last_active_at: row.last_active_at,
  }));
  return noStoreJson({ activity, observedAt: new Date().toISOString() });
}
