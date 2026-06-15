import { redirect } from "next/navigation";
import { canManageUsers } from "../../lib/admin";
import { createSupabaseServerClient } from "../../lib/supabase/server";

type ApprovedUser = {
  email: string;
  role: string;
  business_id?: string | null;
};

async function getApprovedUser(supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>, email: string) {
  const upgraded = await supabase
    .from("approved_users")
    .select("email, role, business_id")
    .eq("email", email)
    .maybeSingle();

  if (!upgraded.error) return upgraded;

  return supabase.from("approved_users").select("email, role").eq("email", email).maybeSingle();
}

export default async function CalculatorPage({
  searchParams,
}: {
  searchParams?: Promise<{ as?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    redirect("/");
  }

  const { data: approvedUser, error } = await getApprovedUser(supabase, user.email.toLowerCase());

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

  const approved = approvedUser as ApprovedUser;
  const canManage = canManageUsers(user.email, approved.role);
  const requestedEmail = String(params?.as || "").trim().toLowerCase();
  const viewingEmail = canManage && requestedEmail ? requestedEmail : user.email.toLowerCase();
  const isViewingAnotherUser = viewingEmail !== user.email.toLowerCase();
  const rawSrc = isViewingAnotherUser
    ? `/calculator/raw?as=${encodeURIComponent(viewingEmail)}`
    : "/calculator/raw";

  return (
    <>
      <header className="topbar">
        <div className="topbar-title">
          <strong>Quote Calculator</strong>
          <span>
            {isViewingAnotherUser ? `Viewing ${viewingEmail} as ${user.email}` : user.email}
          </span>
        </div>
        <div className="topbar-actions">
          {canManage ? (
            <a className="button secondary" href="/admin/users">
              Users
            </a>
          ) : null}
          <form action="/auth/signout" method="post">
            <button className="secondary" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <iframe className="calculator-frame" src={rawSrc} title="Quote calculator" />
    </>
  );
}
