import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { canManageUsers } from "../../lib/admin";
import { createSupabaseServerClient } from "../../lib/supabase/server";
import PageLoadingOverlay, { CalculatorFrame } from "../page-loading-overlay";
import AutoSubmitSelect from "./auto-submit-select";

type ApprovedUser = {
  email: string;
  display_name?: string | null;
  role: string;
  business_id?: string | null;
  is_locked?: boolean;
};

type Business = {
  id: string;
  name: string;
  operating_state?: string | null;
};

function businessOptionLabel(business: Business) {
  const operatingState = String(business.operating_state || "").trim().toUpperCase();
  return operatingState ? `${business.name} (${operatingState})` : business.name;
}

async function getApprovedUser(supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>, email: string) {
  const upgraded = await supabase
    .from("approved_users")
    .select("email, display_name, role, business_id, is_locked")
    .eq("email", email)
    .maybeSingle();

  if (!upgraded.error) return upgraded;

  return supabase.from("approved_users").select("email, role").eq("email", email).maybeSingle();
}

async function listApprovedUsers(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
) {
  const upgraded = await supabase
    .from("approved_users")
    .select("email, display_name, role, business_id, is_locked")
    .order("display_name", { ascending: true });

  if (!upgraded.error) return (upgraded.data || []) as ApprovedUser[];

  const legacy = await supabase
    .from("approved_users")
    .select("email, role")
    .order("email", { ascending: true });

  return ((legacy.data || []) as ApprovedUser[]).map((item) => ({
    ...item,
    display_name: "",
  }));
}

async function listBusinessesForEmail(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  email: string,
  fallbackBusinessId?: string | null,
) {
  const ids = new Set<string>();
  if (fallbackBusinessId) ids.add(fallbackBusinessId);

  const memberships = await supabase
    .from("approved_user_businesses")
    .select("business_id")
    .eq("email", email.toLowerCase());

  if (!memberships.error) {
    (memberships.data || []).forEach((row: { business_id?: string | null }) => {
      if (row.business_id) ids.add(row.business_id);
    });
  }

  if (!ids.size) return [] as Business[];

  const businesses = await supabase
    .from("businesses")
    .select("id, name, operating_state")
    .in("id", [...ids])
    .order("name", { ascending: true });

  if (businesses.error) {
    const legacyBusinesses = await supabase
      .from("businesses")
      .select("id, name")
      .in("id", [...ids])
      .order("name", { ascending: true });
    return ((legacyBusinesses.data || []) as Business[]);
  }
  return (businesses.data || []) as Business[];
}

async function listAllBusinesses(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
) {
  const businesses = await supabase
    .from("businesses")
    .select("id, name, operating_state")
    .order("name", { ascending: true });

  if (businesses.error) {
    const legacyBusinesses = await supabase
      .from("businesses")
      .select("id, name")
      .order("name", { ascending: true });
    return ((legacyBusinesses.data || []) as Business[]);
  }
  return (businesses.data || []) as Business[];
}

function displayName(user: Pick<ApprovedUser, "email" | "display_name">) {
  return String(user.display_name || user.email);
}

function lastBusinessCookieName(email: string) {
  const slug = String(email || "account")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .slice(0, 90);
  return `calculatorLastBusinessV1_${slug || "account"}`;
}

export default async function CalculatorPage({
  searchParams,
}: {
  searchParams?: Promise<{ as?: string; preview?: string; admin?: string; businessId?: string }>;
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
        <PageLoadingOverlay />
        <section className="auth-panel">
          <p className="kicker">Access pending</p>
          <h1>Your account is not approved yet</h1>
          <p>
            You are signed in as {user.email}, but this email is not on the approved
            calculator user list.
          </p>
          <form action="/auth/signout" method="post" className="button-row" data-loading-label="Signing out...">
            <button className="secondary" type="submit">
              Sign out
            </button>
          </form>
        </section>
      </main>
    );
  }

  const approved = approvedUser as ApprovedUser;
  if (approved.is_locked) {
    return (
      <main className="auth-shell">
        <PageLoadingOverlay />
        <section className="auth-panel">
          <p className="kicker">Access locked</p>
          <h1>This calculator account is locked</h1>
          <p>Contact your platform administrator to restore access.</p>
          <form action="/auth/signout" method="post" className="button-row" data-loading-label="Signing out...">
            <button className="secondary" type="submit">
              Sign out
            </button>
          </form>
        </section>
      </main>
    );
  }
  await supabase.rpc("record_current_user_activity");
  const canManage = canManageUsers(user.email, approved.role);
  const requestedEmail = String(params?.as || "").trim().toLowerCase();
  const requestedBusinessId = String(params?.businessId || "").trim();
  const viewingEmail = canManage && requestedEmail ? requestedEmail : user.email.toLowerCase();
  const isViewingAnotherUser = viewingEmail !== user.email.toLowerCase();
  const isPreviewingAsAdmin = isViewingAnotherUser && params?.admin === "1";
  const isPreviewingAsUser = isViewingAnotherUser && !isPreviewingAsAdmin;
  const approvedUsers = canManage ? await listApprovedUsers(supabase) : [];
  const viewedApprovedUser =
    approvedUsers.find((item) => item.email.toLowerCase() === viewingEmail) || {
      email: viewingEmail,
      display_name: "",
      role: "user",
      business_id: null,
    };
  const businessOptions =
    canManage && !isViewingAnotherUser
      ? await listAllBusinesses(supabase)
      : await listBusinessesForEmail(
          supabase,
          viewingEmail,
          (viewedApprovedUser as ApprovedUser).business_id,
        );
  const cookieStore = await cookies();
  const rememberedBusinessId = String(cookieStore.get(lastBusinessCookieName(viewingEmail))?.value || "").trim();
  const requestedBusiness = businessOptions.find((business) => business.id === requestedBusinessId) || null;
  const rememberedBusiness = businessOptions.find((business) => business.id === rememberedBusinessId) || null;
  const selectedBusiness =
    requestedBusiness || rememberedBusiness || businessOptions[0] || null;
  const businessQuery = selectedBusiness ? `businessId=${encodeURIComponent(selectedBusiness.id)}` : "";
  const rawSrc = isViewingAnotherUser
    ? `/calculator/raw?as=${encodeURIComponent(viewingEmail)}${isPreviewingAsUser ? "&preview=1" : ""}${businessQuery ? `&${businessQuery}` : ""}`
    : `/calculator/raw${businessQuery ? `?${businessQuery}` : ""}`;
  const viewingName = displayName(viewedApprovedUser);
  const selectedBusinessParam = selectedBusiness ? `&businessId=${encodeURIComponent(selectedBusiness.id)}` : "";
  const signedInName = displayName(approved);
  const accountInitial = signedInName.trim().charAt(0).toUpperCase() || "A";
  const rememberBusinessScript = selectedBusiness
    ? `
(function(){
  try {
    var name = ${JSON.stringify(lastBusinessCookieName(viewingEmail))};
    var value = ${JSON.stringify(selectedBusiness.id)};
    document.cookie = name + '=' + encodeURIComponent(value) + '; Max-Age=31536000; Path=/; SameSite=Lax';
  } catch (e) {}
})();
`
    : "";

  return (
    <div className="calculator-shell">
      <header className="topbar">
        <div className="topbar-title">
          <strong>Quote Calculator</strong>
          <span>
            {isViewingAnotherUser
              ? isPreviewingAsAdmin
                ? `Previewing ${viewingName} with admin details`
                : `Viewing as ${viewingName}`
              : displayName(approved)}
          </span>
        </div>
        <div className="topbar-workspace">
          {businessOptions.length > 1 ? (
            <AutoSubmitSelect
              ariaLabel="Business workspace"
              className="workspace-business-switcher"
              hiddenFields={[
                ...(isViewingAnotherUser ? [{ name: "as", value: viewingEmail }] : []),
                ...(isPreviewingAsAdmin ? [{ name: "admin", value: "1" }] : []),
              ]}
              label="Business"
              loadingLabel="Switching business..."
              name="businessId"
              options={businessOptions.map((business) => ({
                label: businessOptionLabel(business),
                value: business.id,
              }))}
              value={selectedBusiness?.id || ""}
            />
          ) : (
            <div className="workspace-business-static">
              <span>Business</span>
              <strong>{selectedBusiness ? businessOptionLabel(selectedBusiness) : "No business assigned"}</strong>
            </div>
          )}
          {isViewingAnotherUser ? (
            <nav className={`view-mode-control ${isPreviewingAsAdmin ? "admin-active" : ""}`} aria-label="Calculator viewing mode">
              {isPreviewingAsUser ? (
                <span className="active" aria-current="page">User view</span>
              ) : (
                <a href={`/calculator?as=${encodeURIComponent(viewingEmail)}${selectedBusinessParam}`} data-loading-label={`Returning to ${viewingName}'s view...`}>User view</a>
              )}
              {isPreviewingAsAdmin ? (
                <span className="active" aria-current="page">Admin preview</span>
              ) : (
                <a href={`/calculator?as=${encodeURIComponent(viewingEmail)}&admin=1${selectedBusinessParam}`} data-loading-label="Opening admin preview...">Admin preview</a>
              )}
            </nav>
          ) : null}
        </div>
        <details className="account-menu">
          <summary aria-label="Account menu">
            <span className="account-avatar" aria-hidden="true">{accountInitial}</span>
            <span className="account-summary-name">{signedInName}</span>
            <span className="account-menu-chevron" aria-hidden="true" />
          </summary>
          <div className="account-menu-panel">
            <div className="account-menu-identity">
              <strong>{signedInName}</strong>
              <span>{user.email}</span>
            </div>
            {canManage ? (
              <AutoSubmitSelect
                ariaLabel="View another calculator"
                className="account-menu-switcher"
                label="View calculator"
                loadingLabel="Opening user calculator..."
                name="as"
                options={approvedUsers.map((approvedUser) => ({
                  label: displayName(approvedUser),
                  value: approvedUser.email,
                }))}
                value={viewingEmail}
              />
            ) : null}
            <div className="account-menu-links">
              <a href="/calculator" data-loading-label="Returning to your account...">My calculator</a>
              {canManage ? <a href="/admin/users" data-loading-label="Loading Platform Admin...">Platform Admin</a> : null}
              <form action="/auth/signout" method="post" data-loading-label="Signing out...">
                <button type="submit">Sign out</button>
              </form>
            </div>
          </div>
        </details>
      </header>
      {rememberBusinessScript ? <script dangerouslySetInnerHTML={{ __html: rememberBusinessScript }} /> : null}
      <CalculatorFrame src={rawSrc} />
    </div>
  );
}
