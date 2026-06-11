"use client";

import { createSupabaseBrowserClient } from "../lib/supabase/client";

export default function LoginButton() {
  async function signIn() {
    const supabase = createSupabaseBrowserClient();
    const origin = window.location.origin;
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${origin}/auth/callback`,
      },
    });
  }

  return (
    <div className="button-row">
      <button className="orange" type="button" onClick={signIn}>
        Continue with Google
      </button>
    </div>
  );
}
