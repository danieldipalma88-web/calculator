import { redirect } from "next/navigation";
import { hasSupabaseConfig } from "../lib/supabase/config";
import { createSupabaseServerClient } from "../lib/supabase/server";
import LoginButton from "./signin-button";

export default async function Home({
  searchParams,
}: {
  searchParams?: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;

  if (hasSupabaseConfig()) {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user) {
      redirect(params?.next || "/calculator");
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel">
        <p className="kicker">Approved access only</p>
        <h1>Quote Calculator</h1>
        <p>
          Sign in with your approved Google account to open your calculator and saved
          quote data.
        </p>
        {params?.error ? <div className="notice">{params.error}</div> : null}
        {!hasSupabaseConfig() ? (
          <div className="notice">
            Supabase environment variables still need to be added in Vercel.
          </div>
        ) : (
          <LoginButton />
        )}
      </section>
    </main>
  );
}
