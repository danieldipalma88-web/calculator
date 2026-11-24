import { canManageUsers } from "../../../lib/admin";
import { BusinessWonJobsRefreshing, businessWonJobsPayload, createBusinessWonJobsCache, isBusinessId } from "../../../lib/business-won-jobs";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 15;
const readCachedJobs = createBusinessWonJobsCache();
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const reply = (data: unknown, status = 200) => Response.json(data, { status, headers });

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const businessId = params.get("businessId") || "";
  if (!isBusinessId(businessId)) return reply({ error: "Choose a business to view its Won Jobs." }, 400);
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(4_000)]);
  try {
    const supabase = await createSupabaseServerClient((input, init) => fetch(input, { ...init,
      signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }));
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError) return reply({ error: "Sign-in could not be checked. Please try again." }, 503);
    const email = String(user?.email || "").trim().toLowerCase();
    if (!user || !email) return reply({ error: "Sign in to view Won Jobs." }, 401);
    const actor = await supabase.from("approved_users").select("email,role,business_id,is_locked").eq("email", email).maybeSingle();
    if (actor.error) throw new Error("Approval unavailable");
    if (!actor.data || actor.data.is_locked) return reply({ error: "Access is not available for this account." }, 403);
    const admin = canManageUsers(email, actor.data.role);
    const as = (params.get("as") || email).trim().toLowerCase();
    if (as !== email && !admin) return reply({ error: "Access denied." }, 403);
    const target = as === email ? actor : await supabase.from("approved_users")
      .select("email,role,business_id,is_locked").eq("email", as).maybeSingle();
    if (target.error) throw new Error("Preview approval unavailable");
    if (!target.data || target.data.is_locked || (target.data.role !== "business_owner" && !(admin && as === email))) {
      return reply({ error: "Business-owner access is required." }, 403);
    }
    if (!(admin && as === email) && target.data.business_id !== businessId) {
      const membership = await supabase.from("approved_user_businesses").select("business_id")
        .eq("email", as).eq("business_id", businessId).maybeSingle();
      if (membership.error) throw new Error("Business access unavailable");
      if (!membership.data) return reply({ error: "This business is not assigned to your account." }, 403);
    }
    // Never serve cached financial information before rechecking role and membership.
    const data = await readCachedJobs(businessId, async () => {
      // This load is shared. A closing tab must not cancel another owner's read.
      const readSignal = AbortSignal.timeout(6_000);
      const reader = await createSupabaseServerClient((input, init) => fetch(input, { ...init,
        signal: init?.signal ? AbortSignal.any([readSignal, init.signal]) : readSignal }));
      const result = await reader.rpc("read_business_won_jobs", { p_business_id: businessId }).abortSignal(readSignal);
      if (result.error) throw new Error("Business Won Jobs unavailable");
      if (result.data?.status === "refreshing") throw new BusinessWonJobsRefreshing();
      return businessWonJobsPayload(result.data, businessId);
    });
    return reply(data);
  } catch (error) {
    if (error instanceof BusinessWonJobsRefreshing) return reply({ status: "refreshing", businessId, retryAfterMs: 1000 }, 202);
    return reply({ error: "Business Won Jobs could not be loaded. Your calculator and saved quotes are unchanged. Please try again." }, 503);
  }
}
