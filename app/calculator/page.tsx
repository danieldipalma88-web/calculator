import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { canManageUsers } from "../../lib/admin";
import { createSupabaseServerClient } from "../../lib/supabase/server";

type ApprovedUser = {
  email: string;
  display_name?: string | null;
  role: string;
  business_id?: string | null;
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
    .select("email, display_name, role, business_id")
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
    .select("email, display_name, role, business_id")
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
  searchParams?: Promise<{ as?: string; preview?: string; businessId?: string }>;
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
  const requestedBusinessId = String(params?.businessId || "").trim();
  const viewingEmail = canManage && requestedEmail ? requestedEmail : user.email.toLowerCase();
  const isViewingAnotherUser = viewingEmail !== user.email.toLowerCase();
  const isPreviewingAsUser = isViewingAnotherUser && params?.preview === "1";
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
  const selectedBusinessName = selectedBusiness ? businessOptionLabel(selectedBusiness) : "";
  const selectedBusinessParam = selectedBusiness ? `&businessId=${encodeURIComponent(selectedBusiness.id)}` : "";
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
              ? `${isPreviewingAsUser ? "Previewing" : "Viewing"} ${viewingName} as ${user.email}`
              : displayName(approved)}
          </span>
        </div>
        <div className="topbar-actions">
          {canManage ? (
            <>
              <a className="button secondary" href="/admin/users">
                Users
              </a>
              <form action="/calculator" method="get" className="account-switcher">
                <select name="as" defaultValue={viewingEmail} aria-label="Open user account">
                  {approvedUsers.map((approvedUser) => (
                    <option key={approvedUser.email} value={approvedUser.email}>
                      {displayName(approvedUser)}
                    </option>
                  ))}
                </select>
                <button className="secondary" type="submit">
                  Open
                </button>
              </form>
              {isViewingAnotherUser ? (
                <>
                  {isPreviewingAsUser ? (
                    <a className="button secondary" href={`/calculator?as=${encodeURIComponent(viewingEmail)}${selectedBusinessParam}`}>
                      Show Admin Details
                    </a>
                  ) : (
                    <a className="button secondary" href={`/calculator?as=${encodeURIComponent(viewingEmail)}&preview=1${selectedBusinessParam}`}>
                      Preview as {viewingName}
                    </a>
                  )}
                  <a className="button orange" href="/calculator">
                    Return to My Account
                  </a>
                </>
              ) : null}
            </>
          ) : null}
          {businessOptions.length > 1 ? (
            <form action="/calculator" method="get" className="business-switcher">
              {isViewingAnotherUser ? <input type="hidden" name="as" value={viewingEmail} /> : null}
              {isPreviewingAsUser ? <input type="hidden" name="preview" value="1" /> : null}
              <select name="businessId" defaultValue={selectedBusiness?.id || ""} aria-label="Business workspace">
                  {businessOptions.map((business) => (
                  <option key={business.id} value={business.id}>
                    {businessOptionLabel(business)}
                  </option>
                ))}
              </select>
              <button className="secondary" type="submit">
                Switch
              </button>
            </form>
          ) : null}
          <form action="/auth/signout" method="post">
            <button className="secondary" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </header>
      {isViewingAnotherUser ? (
        <div className={`view-mode-banner ${isPreviewingAsUser ? "preview" : "admin"}`}>
          <strong>{isPreviewingAsUser ? `Previewing what ${viewingName} sees` : "Admin details visible"}</strong>
          <span>
            {isPreviewingAsUser
              ? "Agency/admin-only figures are hidden in this preview."
              : `You are viewing ${viewingName}'s saved calculator with Daniel/admin visibility.`}
            {selectedBusinessName ? ` Active business: ${selectedBusinessName}.` : ""}
          </span>
        </div>
      ) : null}
      {rememberBusinessScript ? <script dangerouslySetInnerHTML={{ __html: rememberBusinessScript }} /> : null}
      <iframe className="calculator-frame" src={rawSrc} title="Quote calculator" />
    </div>
  );
}
