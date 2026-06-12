import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { canManageUsers } from "../../../lib/admin";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

type ApprovedUser = {
  email: string;
  role: "admin" | "user";
  created_at: string;
};

export const dynamic = "force-dynamic";
export const revalidate = 0;

function normalizeEmail(value: FormDataEntryValue | null) {
  return String(value || "").trim().toLowerCase();
}

function normalizeRole(value: FormDataEntryValue | null): "admin" | "user" {
  return value === "admin" ? "admin" : "user";
}

async function requireAdmin() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) {
    redirect("/");
  }

  const email = user.email.toLowerCase();
  const { data: approvedUser } = await supabase
    .from("approved_users")
    .select("role")
    .eq("email", email)
    .maybeSingle();

  if (!canManageUsers(email, approvedUser?.role)) {
    redirect("/calculator");
  }

  return { supabase, email };
}

async function addApprovedUser(formData: FormData) {
  "use server";

  const { supabase } = await requireAdmin();
  const email = normalizeEmail(formData.get("email"));
  const role = normalizeRole(formData.get("role"));

  if (!email) {
    redirect("/admin/users?error=Enter an email address.");
  }

  const { error } = await supabase.rpc("admin_upsert_approved_user", {
    target_email: email,
    target_role: role,
  });

  if (error) {
    redirect(`/admin/users?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/admin/users");
  redirect(`/admin/users?message=${encodeURIComponent(`${email} is approved.`)}`);
}

async function updateApprovedUserRole(formData: FormData) {
  "use server";

  const { supabase, email: currentEmail } = await requireAdmin();
  const email = normalizeEmail(formData.get("email"));
  const role = normalizeRole(formData.get("role"));

  if (email === currentEmail && role !== "admin") {
    redirect("/admin/users?error=You cannot demote your own admin account.");
  }

  const { error } = await supabase.rpc("admin_upsert_approved_user", {
    target_email: email,
    target_role: role,
  });

  if (error) {
    redirect(`/admin/users?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/admin/users");
  redirect(`/admin/users?message=${encodeURIComponent(`${email} was updated.`)}`);
}

async function removeApprovedUser(formData: FormData) {
  "use server";

  const { supabase, email: currentEmail } = await requireAdmin();
  const email = normalizeEmail(formData.get("email"));

  if (email === currentEmail) {
    redirect("/admin/users?error=You cannot remove your own admin account.");
  }

  const { error } = await supabase.rpc("admin_delete_approved_user", {
    target_email: email,
  });

  if (error) {
    redirect(`/admin/users?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/admin/users");
  redirect(`/admin/users?message=${encodeURIComponent(`${email} was removed.`)}`);
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; message?: string }>;
}) {
  const params = await searchParams;
  const { supabase, email: currentEmail } = await requireAdmin();
  const { data, error } = await supabase.rpc("admin_list_approved_users");

  const users = (data || []) as ApprovedUser[];

  return (
    <main className="admin-shell">
      <section className="admin-card">
        <div className="admin-head">
          <div>
            <p className="kicker">Admin only</p>
            <h1>Approved users</h1>
            <p>Add or remove the Google accounts allowed to use the calculator.</p>
          </div>
          <a className="button secondary" href="/calculator">
            Calculator
          </a>
        </div>

        {params?.message ? <div className="notice success">{params.message}</div> : null}
        {params?.error ? <div className="notice">{params.error}</div> : null}
        {error ? <div className="notice">Supabase error: {error.message}</div> : null}

        <form action={addApprovedUser} className="admin-form">
          <div>
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" placeholder="installer@example.com" required />
          </div>
          <div>
            <label htmlFor="role">Role</label>
            <select id="role" name="role" defaultValue="user">
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <button className="orange" type="submit">
            Add user
          </button>
        </form>

        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Added</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((approvedUser) => {
                const isSelf = approvedUser.email.toLowerCase() === currentEmail;
                return (
                  <tr key={approvedUser.email}>
                    <td>
                      <strong>{approvedUser.email}</strong>
                      {isSelf ? <span className="self-pill">You</span> : null}
                    </td>
                    <td>
                      <form action={updateApprovedUserRole} className="inline-form">
                        <input type="hidden" name="email" value={approvedUser.email} />
                        <select name="role" defaultValue={approvedUser.role} disabled={isSelf}>
                          <option value="user">User</option>
                          <option value="admin">Admin</option>
                        </select>
                        <button className="secondary" type="submit" disabled={isSelf}>
                          Save
                        </button>
                      </form>
                    </td>
                    <td>{new Date(approvedUser.created_at).toLocaleDateString("en-AU")}</td>
                    <td>
                      <form action={removeApprovedUser}>
                        <input type="hidden" name="email" value={approvedUser.email} />
                        <button className="danger" type="submit" disabled={isSelf}>
                          Remove
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
              {!users.length ? (
                <tr>
                  <td colSpan={4}>No approved users found.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
