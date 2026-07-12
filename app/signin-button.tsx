"use client";

import { type FormEvent, useState } from "react";
import { createSupabaseBrowserClient } from "../lib/supabase/client";
import { publicSiteUrl } from "../lib/supabase/config";

function callbackUrl(next?: string) {
  const url = new URL("/auth/callback", publicSiteUrl);
  if (next) url.searchParams.set("next", next);
  return url.toString();
}

export default function LoginButton({ next }: { next?: string }) {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isSending, setIsSending] = useState(false);

  async function signInWithGoogle() {
    const supabase = createSupabaseBrowserClient();
    const { error: signInError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: callbackUrl(next),
      },
    });
    if (signInError) setError(signInError.message);
  }

  async function sendMagicLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail) {
      setError("Enter your approved email address.");
      setMessage("");
      return;
    }

    setIsSending(true);
    setError("");
    setMessage("");

    const supabase = createSupabaseBrowserClient();
    const { error: signInError } = await supabase.auth.signInWithOtp({
      email: trimmedEmail,
      options: {
        emailRedirectTo: callbackUrl(next),
      },
    });

    setIsSending(false);
    if (signInError) {
      setError(signInError.message);
      return;
    }

    setMessage(`Check ${trimmedEmail} for your login link.`);
  }

  return (
    <>
      <form className="email-login-form" onSubmit={sendMagicLink}>
        <label htmlFor="login-email">Email address</label>
        <div className="email-login-row">
          <input
            id="login-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="installer@example.com"
            autoComplete="email"
            required
          />
          <button className="orange" type="submit" disabled={isSending}>
            {isSending ? "Sending..." : "Email login link"}
          </button>
        </div>
      </form>
      <div className="auth-divider"><span>or</span></div>
      <div className="button-row">
        <button className="secondary" type="button" onClick={signInWithGoogle}>
          Continue with Google
        </button>
      </div>
      {message ? <div className="notice success">{message}</div> : null}
      {error ? <div className="notice">{error}</div> : null}
    </>
  );
}
