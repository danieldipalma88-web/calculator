import type { SupabaseClient } from "@supabase/supabase-js";

export async function sendApprovedUserInvitation(
  supabase: SupabaseClient,
  email: string,
) {
  try {
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
      },
    });

    return error?.message || "";
  } catch (error) {
    return error instanceof Error ? error.message : "The invitation email could not be sent.";
  }
}
