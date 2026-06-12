"use client";

import { createSupabaseBrowserClient } from "../lib/supabase/client";
import { publicSiteUrl } from "../lib/supabase/config";

export default function LoginButton() {
  async function signIn() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${publicSiteUrl}/auth/callback`,
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
