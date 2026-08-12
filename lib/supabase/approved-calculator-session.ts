import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "./server";

export type ApprovedCalculatorUser = {
  email: string;
  display_name?: string | null;
  role: string;
  business_id?: string | null;
  is_locked?: boolean;
};

type ApprovedCalculatorSession = {
  supabase: SupabaseClient;
  user: User;
  email: string;
  approvedUser: ApprovedCalculatorUser;
};

export async function getApprovedCalculatorSession(): Promise<
  | { status: 200; session: ApprovedCalculatorSession }
  | { status: 401 | 403 | 503; error: string }
> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const email = String(user?.email || "").trim().toLowerCase();
  if (!user || !email) return { status: 401, error: "Sign in to continue." };

  const approval = await supabase
    .from("approved_users")
    .select("email, display_name, role, business_id, is_locked")
    .eq("email", email)
    .maybeSingle();

  if (approval.error) {
    return { status: 503, error: "Calculator access could not be checked." };
  }
  if (!approval.data || Boolean(approval.data.is_locked)) {
    return { status: 403, error: "This calculator account is not available." };
  }

  return {
    status: 200,
    session: {
      supabase,
      user,
      email,
      approvedUser: approval.data as ApprovedCalculatorUser,
    },
  };
}
