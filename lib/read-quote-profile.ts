import type { createSupabaseServerClient } from "./supabase/server";

export async function readQuoteProfile(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  userId: string,
  currentEmail: string,
  viewingEmail: string,
) {
  const primary = await supabase.from("user_calculator_data").select("data").eq("email", viewingEmail).maybeSingle();
  // Only a successful, missing self-profile permits the legacy user-ID lookup.
  if (primary.error || primary.data?.data || currentEmail !== viewingEmail) return primary;
  return supabase.from("user_calculator_data").select("data").eq("user_id", userId).maybeSingle();
}
