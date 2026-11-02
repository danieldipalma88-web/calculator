import { redirect } from "next/navigation";
import { canManageUsers } from "../../../lib/admin";
import { getApprovedCalculatorSession } from "../../../lib/supabase/approved-calculator-session";
import RequestList from "./request-list";

export const dynamic = "force-dynamic";

export default async function ModelRequestsPage() {
  const access = await getApprovedCalculatorSession();
  if (access.status !== 200 || !canManageUsers(access.session.email, access.session.approvedUser.role)) {
    redirect("/calculator");
  }

  return (
    <main className="admin-shell">
      <section className="admin-card">
        <header className="admin-head">
          <div>
            <p className="kicker">Quote Calculator</p>
            <h1>Model requests</h1>
            <p>Review automated model checks and manage catalogue additions.</p>
          </div>
          <a className="button secondary" href="/admin/users">Platform Admin</a>
        </header>
        <RequestList />
      </section>
    </main>
  );
}
