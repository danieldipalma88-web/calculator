import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

function noStoreJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function POST(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    request.headers.get("origin") !== new URL(request.url).origin
    || (fetchSite !== null && fetchSite !== "same-origin")
  ) {
    return noStoreJson({ error: "Same-origin request required." }, 403);
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  const email = String(user?.email || "").trim().toLowerCase();
  if (authError || !user || !email) return noStoreJson({ error: "Not signed in" }, 401);

  const approval = await supabase
    .from("approved_users")
    .select("is_locked, last_active_at")
    .eq("email", email)
    .maybeSingle();
  if (approval.error) return noStoreJson({ error: "Activity access could not be checked." }, 503);
  if (!approval.data || approval.data.is_locked) {
    return noStoreJson({ error: "This calculator account is not available." }, 403);
  }

  // Only the stored timestamp can suppress a write; client identity/time is never read.
  const lastActiveAt = approval.data.last_active_at as string | null;
  const elapsed = Date.now() - Date.parse(lastActiveAt || "");
  if (elapsed >= 0 && elapsed < 60000) {
    return noStoreJson({ ok: true, recorded: false, last_active_at: lastActiveAt });
  }

  const result = await supabase.rpc("record_current_user_activity");
  if (result.error) return noStoreJson({ error: "Activity could not be recorded." }, 503);
  if (!result.data) return noStoreJson({ error: "This calculator account is not available." }, 403);
  return noStoreJson({ ok: true, recorded: true, last_active_at: result.data });
}
