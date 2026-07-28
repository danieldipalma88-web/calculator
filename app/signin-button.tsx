"use client";

import { type FormEvent, useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "../lib/supabase/client";
import { AuthenticationLoadingOverlay } from "./page-loading-overlay";

const EMAIL_OTP_LENGTH = 8;

function safeNextPath(value?: string) {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/calculator";
}

export default function LoginButton({ next }: { next?: string }) {
  const [email, setEmail] = useState("");
  const [submittedEmail, setSubmittedEmail] = useState("");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isCompletingLogin, setIsCompletingLogin] = useState(false);
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

  async function requestLoginCode(trimmedEmail: string) {
    if (retryAfterSeconds > 0) {
      setError(`Please wait ${retryAfterSeconds} seconds before requesting another login code.`);
      setMessage("");
      return;
    }
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
    });

    setIsSending(false);
    if (signInError) {
      if (isRateLimitError(signInError)) {
        setRetryAfterSeconds(60);
        setError(
          "Email login codes are temporarily rate limited. Wait 60 seconds and try once. If this keeps happening, the Supabase hourly email limit has been reached.",
        );
        return;
      }
      setError(signInError.message);
      return;
    }

    setSubmittedEmail(trimmedEmail);
    setCode("");
    setRetryAfterSeconds(60);
    setMessage(`We sent a login code to ${trimmedEmail}.`);
  }

  async function sendLoginCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await requestLoginCode(email.trim().toLowerCase());
  }

  async function resendLoginCode() {
    await requestLoginCode(submittedEmail);
  }

  async function verifyLoginCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = code.replace(/\D/g, "");
    if (token.length !== EMAIL_OTP_LENGTH) {
      setError(`Enter the ${EMAIL_OTP_LENGTH}-digit code from your email.`);
      setMessage("");
      return;
    }

    setIsVerifying(true);
    setError("");
    setMessage("");

    const supabase = createSupabaseBrowserClient();
    const { data, error: verifyError } = await supabase.auth.verifyOtp({
      email: submittedEmail,
      token,
      type: "email",
    });

    setIsVerifying(false);
    if (verifyError || !data.session) {
      setError(
        verifyError?.message ||
          "That login code could not be verified. Request a new code and try again.",
      );
      return;
    }

    setIsCompletingLogin(true);
    window.location.assign(safeNextPath(next));
  }

  function changeEmail() {
    setSubmittedEmail("");
    setCode("");
    setMessage("");
    setError("");
  }

  return (
    <>
      {!submittedEmail ? (
        <form className="email-login-form" onSubmit={sendLoginCode}>
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
              {isSending ? "Sending..." : retryAfterSeconds > 0 ? `Wait ${retryAfterSeconds}s` : "Send login code"}
            </button>
          </div>
        </form>
      ) : (
        <form className="email-login-form email-code-form" onSubmit={verifyLoginCode}>
          <div className="email-code-heading">
            <div>
              <label htmlFor="login-code">Login code</label>
              <p>{submittedEmail}</p>
            </div>
            <button className="text-button" type="button" onClick={changeEmail}>
              Change email
            </button>
          </div>
          <input
            id="login-code"
            className="email-code-input"
            type="text"
            value={code}
            onChange={(event) => {
              setCode(event.target.value.replace(/\D/g, "").slice(0, EMAIL_OTP_LENGTH));
              setError("");
            }}
            placeholder="00000000"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={EMAIL_OTP_LENGTH}
            pattern="[0-9]{8}"
            autoFocus
            required
          />
          <button className="orange" type="submit" disabled={isVerifying || isCompletingLogin}>
            {isVerifying || isCompletingLogin ? "Verifying..." : "Verify and sign in"}
          </button>
          <button
            className="secondary email-code-resend"
            type="button"
            onClick={resendLoginCode}
            disabled={isSending || retryAfterSeconds > 0}
          >
            {isSending ? "Sending..." : retryAfterSeconds > 0 ? `Resend in ${retryAfterSeconds}s` : "Resend code"}
          </button>
        </form>
      )}
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
      <AuthenticationLoadingOverlay visible={isGoogleSigningIn || isCompletingLogin} />
      {message ? <div className="notice success">{message}</div> : null}
      {error ? <div className="notice">{error}</div> : null}
    </>
  );
}
