"use client";

import { type FormEvent, useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "../lib/supabase/client";
import { publicSiteUrl } from "../lib/supabase/config";
import { AuthenticationLoadingOverlay } from "./page-loading-overlay";

function callbackUrl(next?: string) {
  const baseUrl = typeof window !== "undefined" ? window.location.origin : publicSiteUrl;
  const url = new URL("/auth/callback", baseUrl);
  if (next) url.searchParams.set("next", next);
  return url.toString();
}

export default function LoginButton({ next }: { next?: string }) {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isGoogleSigningIn, setIsGoogleSigningIn] = useState(false);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState(0);

  useEffect(() => {
    if (retryAfterSeconds <= 0) return;
    const timer = window.setTimeout(() => {
      setRetryAfterSeconds((current) => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [retryAfterSeconds]);

  function isRateLimitError(signInError: { message?: string; status?: number; code?: string }) {
    const message = String(signInError.message || "").toLowerCase();
    return signInError.status === 429 || signInError.code === "over_email_send_rate_limit" || message.includes("rate limit");
  }

  async function sendMagicLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (retryAfterSeconds > 0) {
      setError(`Please wait ${retryAfterSeconds} seconds before requesting another login link.`);
      setMessage("");
      return;
    }
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
      if (isRateLimitError(signInError)) {
        setRetryAfterSeconds(60);
        setError(
          "Email login links are temporarily rate limited. Wait 60 seconds and try once. If this keeps happening, the Supabase hourly email/OTP limit has been reached.",
        );
        return;
      }
      setError(signInError.message);
      return;
    }

    setRetryAfterSeconds(60);
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
            onChange={(event) => {
              setEmail(event.target.value);
              setError("");
            }}
            placeholder="installer@example.com"
            autoComplete="email"
            required
          />
          <button className="orange" type="submit" disabled={isSending || retryAfterSeconds > 0}>
            {isSending ? "Sending..." : retryAfterSeconds > 0 ? `Wait ${retryAfterSeconds}s` : "Email login link"}
          </button>
        </div>
      </form>
      <div className="auth-divider"><span>or</span></div>
      <form
        className="button-row"
        action="/auth/google"
        method="post"
        onSubmit={() => setIsGoogleSigningIn(true)}
      >
        <input type="hidden" name="next" value={next || "/calculator"} />
        <button className="secondary" type="submit" disabled={isGoogleSigningIn}>
          {isGoogleSigningIn ? "Opening Google..." : "Continue with Google"}
        </button>
      </form>
      <AuthenticationLoadingOverlay visible={isGoogleSigningIn} />
      {message ? <div className="notice success">{message}</div> : null}
      {error ? <div className="notice">{error}</div> : null}
    </>
  );
}
