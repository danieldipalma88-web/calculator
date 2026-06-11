import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "../../lib/supabase/server";

export default async function CalculatorPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    redirect("/");
  }

  const { data: approvedUser, error } = await supabase
    .from("approved_users")
    .select("email, role")
    .eq("email", user.email.toLowerCase())
    .maybeSingle();

  if (error || !approvedUser) {
    return (
      <main className="auth-shell">
        <section className="auth-panel">
          <p className="kicker">Access pending</p>
          <h1>Your account is not approved yet</h1>
          <p>
            You are signed in as {user.email}, but this email is not on the approved
            calculator user list.
          </p>
          <form action="/auth/signout" method="post" className="button-row">
            <button className="secondary" type="submit">
              Sign out
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar-title">
          <strong>Quote Calculator</strong>
          <span>{user.email}</span>
        </div>
        <form action="/auth/signout" method="post">
          <button className="secondary" type="submit">
            Sign out
          </button>
        </form>
      </header>
      <iframe className="calculator-frame" src="/calculator/raw" title="Quote calculator" />
    </>
  );
}
