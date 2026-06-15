import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { canManageUsers } from "../../../lib/admin";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

type UserRole = "admin" | "business_owner" | "agency" | "salesperson" | "user";
type CommissionType = "none" | "standard" | "agency";
type CommissionOverride = CommissionType | "business_default";

type Business = {
  id: string;
  name: string;
  commission_type: CommissionType;
  agency_commission_rate: number;
  salesperson_commission_rate: number;
  created_at: string;
};

type ApprovedUser = {
  email: string;
  role: UserRole;
  business_id: string | null;
  business_name: string | null;
  commission_type_override: CommissionType | null;
  agency_commission_rate_override: number | null;
  salesperson_commission_rate_override: number | null;
  effective_commission_type: CommissionType;
  effective_agency_commission_rate: number;
  effective_salesperson_commission_rate: number;
  created_at: string;
};

const roleOptions: { value: UserRole; label: string }[] = [
  { value: "user", label: "Standard user" },
  { value: "salesperson", label: "Salesperson" },
  { value: "agency", label: "Agency" },
  { value: "business_owner", label: "Business owner" },
  { value: "admin", label: "Platform admin" },
];

const commissionOptions: { value: CommissionOverride; label: string }[] = [
  { value: "business_default", label: "Use business default" },
  { value: "none", label: "No commission" },
  { value: "standard", label: "Standard commission" },
  { value: "agency", label: "Agency commission" },
];

export const dynamic = "force-dynamic";
export const revalidate = 0;

function normalizeEmail(value: FormDataEntryValue | null) {
  return String(value || "").trim().toLowerCase();
}

function normalizeText(value: FormDataEntryValue | null) {
  return String(value || "").trim();
}

function normalizeRole(value: FormDataEntryValue | null): UserRole {
  const role = String(value || "");
  return roleOptions.some((option) => option.value === role) ? (role as UserRole) : "user";
}

function normalizeCommissionOverride(value: FormDataEntryValue | null): CommissionOverride {
  const commissionType = String(value || "business_default");
  return commissionOptions.some((option) => option.value === commissionType)
    ? (commissionType as CommissionOverride)
    : "business_default";
}

function nullableUuid(value: FormDataEntryValue | null) {
  const normalized = normalizeText(value);
  return normalized ? normalized : null;
}

function nullableRate(value: FormDataEntryValue | null) {
  const raw = normalizeText(value);
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(parsed, 0), 100);
}

function rateValue(value: FormDataEntryValue | null, fallback: number) {
  return nullableRate(value) ?? fallback;
}

function formatRate(value: number | null | undefined) {
  const safe = Number(value ?? 0);
  return safe.toLocaleString("en-AU", {
    minimumFractionDigits: safe % 1 ? 1 : 0,
    maximumFractionDigits: 2,
  });
}

function commissionLabel(type: string | null | undefined) {
  if (type === "agency") return "Agency";
  if (type === "standard") return "Standard";
  return "None";
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

  if (!canManageUsers(email, String(approvedUser?.role || ""))) {
    redirect("/calculator");
  }

  return { supabase, email };
}

async function upsertBusiness(formData: FormData) {
  "use server";

  const { supabase } = await requireAdmin();
  const businessId = nullableUuid(formData.get("businessId"));
  const name = normalizeText(formData.get("businessName"));
  const commissionType = normalizeCommissionOverride(formData.get("commissionType"));
  const agencyRate = rateValue(formData.get("agencyCommissionRate"), 25);
  const salespersonRate = rateValue(formData.get("salespersonCommissionRate"), 50);

  if (!name) {
    redirect("/admin/users?error=Enter a business name.");
  }

  const { error } = await supabase.rpc("admin_upsert_business", {
    target_business_id: businessId,
    target_name: name,
    target_commission_type: commissionType === "business_default" ? "none" : commissionType,
    target_agency_commission_rate: agencyRate,
    target_salesperson_commission_rate: salespersonRate,
  });

  if (error) {
    redirect(`/admin/users?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/admin/users");
  redirect(`/admin/users?message=${encodeURIComponent(`${name} was saved.`)}`);
}

async function addApprovedUser(formData: FormData) {
  "use server";

  const { supabase } = await requireAdmin();
  const email = normalizeEmail(formData.get("email"));
  const role = normalizeRole(formData.get("role"));
  const businessId = nullableUuid(formData.get("businessId"));
  const commissionType = normalizeCommissionOverride(formData.get("commissionType"));
  const agencyRate = nullableRate(formData.get("agencyCommissionRate"));
  const salespersonRate = nullableRate(formData.get("salespersonCommissionRate"));

  if (!email) {
    redirect("/admin/users?error=Enter an email address.");
  }

  const { error } = await supabase.rpc("admin_upsert_approved_user", {
    target_email: email,
    target_role: role,
    target_business_id: businessId,
    target_commission_type_override: commissionType === "business_default" ? null : commissionType,
    target_agency_commission_rate_override: agencyRate,
    target_salesperson_commission_rate_override: salespersonRate,
  });

  if (error) {
    redirect(`/admin/users?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/admin/users");
  redirect(`/admin/users?message=${encodeURIComponent(`${email} is approved.`)}`);
}

async function updateApprovedUser(formData: FormData) {
  "use server";

  const { supabase, email: currentEmail } = await requireAdmin();
  const email = normalizeEmail(formData.get("email"));
  const role = normalizeRole(formData.get("role"));
  const businessId = nullableUuid(formData.get("businessId"));
  const commissionType = normalizeCommissionOverride(formData.get("commissionType"));
  const agencyRate = nullableRate(formData.get("agencyCommissionRate"));
  const salespersonRate = nullableRate(formData.get("salespersonCommissionRate"));

  if (email === currentEmail && role !== "admin") {
    redirect("/admin/users?error=You cannot demote your own admin account.");
  }

  const { error } = await supabase.rpc("admin_upsert_approved_user", {
    target_email: email,
    target_role: role,
    target_business_id: businessId,
    target_commission_type_override: commissionType === "business_default" ? null : commissionType,
    target_agency_commission_rate_override: agencyRate,
    target_salesperson_commission_rate_override: salespersonRate,
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
  const [businessResult, usersResult] = await Promise.all([
    supabase.rpc("admin_list_businesses"),
    supabase.rpc("admin_list_approved_users"),
  ]);

  const businesses = (businessResult.data || []) as Business[];
  const users = (usersResult.data || []) as ApprovedUser[];
  const firstBusinessId = businesses[0]?.id || "";

  return (
    <main className="admin-shell">
      <section className="admin-card">
        <div className="admin-head">
          <div>
            <p className="kicker">Platform admin</p>
            <h1>Businesses and users</h1>
            <p>
              Add businesses, assign approved Google accounts, and control which commission
              structure each user receives.
            </p>
          </div>
          <a className="button secondary" href="/calculator">
            Calculator
          </a>
        </div>

        {params?.message ? <div className="notice success">{params.message}</div> : null}
        {params?.error ? <div className="notice">{params.error}</div> : null}
        {businessResult.error ? (
          <div className="notice">Supabase business error: {businessResult.error.message}</div>
        ) : null}
        {usersResult.error ? (
          <div className="notice">Supabase user error: {usersResult.error.message}</div>
        ) : null}

        <section className="admin-section">
          <div className="section-heading">
            <div>
              <h2>Businesses</h2>
              <p>Business defaults are used unless a user has their own commission override.</p>
            </div>
          </div>

          <form action={upsertBusiness} className="admin-form business-form">
            <div>
              <label htmlFor="businessName">Business name</label>
              <input
                id="businessName"
                name="businessName"
                placeholder="Green Energy Climate Control"
                required
              />
            </div>
            <div>
              <label htmlFor="businessCommissionType">Default commission</label>
              <select id="businessCommissionType" name="commissionType" defaultValue="agency">
                <option value="none">No commission</option>
                <option value="standard">Standard</option>
                <option value="agency">Agency</option>
              </select>
            </div>
            <div>
              <label htmlFor="businessAgencyRate">Agency / standard %</label>
              <input id="businessAgencyRate" name="agencyCommissionRate" type="number" min="0" max="100" step="0.1" defaultValue="25" />
            </div>
            <div>
              <label htmlFor="businessSalespersonRate">Salesperson %</label>
              <input id="businessSalespersonRate" name="salespersonCommissionRate" type="number" min="0" max="100" step="0.1" defaultValue="50" />
            </div>
            <button className="orange" type="submit">
              Add business
            </button>
          </form>

          <div className="business-grid">
            {businesses.map((business) => (
              <form action={upsertBusiness} className="business-card" key={business.id}>
                <input type="hidden" name="businessId" value={business.id} />
                <div>
                  <label>Business</label>
                  <input name="businessName" defaultValue={business.name} />
                </div>
                <div>
                  <label>Commission</label>
                  <select name="commissionType" defaultValue={business.commission_type}>
                    <option value="none">No commission</option>
                    <option value="standard">Standard</option>
                    <option value="agency">Agency</option>
                  </select>
                </div>
                <div>
                  <label>Agency / standard %</label>
                  <input name="agencyCommissionRate" type="number" min="0" max="100" step="0.1" defaultValue={formatRate(business.agency_commission_rate)} />
                </div>
                <div>
                  <label>Salesperson %</label>
                  <input name="salespersonCommissionRate" type="number" min="0" max="100" step="0.1" defaultValue={formatRate(business.salesperson_commission_rate)} />
                </div>
                <button className="secondary" type="submit">
                  Save business
                </button>
              </form>
            ))}
            {!businesses.length ? <div className="empty-card">No businesses yet.</div> : null}
          </div>
        </section>

        <section className="admin-section">
          <div className="section-heading">
            <div>
              <h2>Approved users</h2>
              <p>Salespeople can use the calculator without seeing hidden commission percentages.</p>
            </div>
          </div>

          <form action={addApprovedUser} className="admin-form user-form">
            <div>
              <label htmlFor="email">Email</label>
              <input id="email" name="email" type="email" placeholder="installer@example.com" required />
            </div>
            <div>
              <label htmlFor="role">Role</label>
              <select id="role" name="role" defaultValue="salesperson">
                {roleOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="businessId">Business</label>
              <select id="businessId" name="businessId" defaultValue={firstBusinessId}>
                {businesses.map((business) => (
                  <option key={business.id} value={business.id}>
                    {business.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="commissionType">Commission override</label>
              <select id="commissionType" name="commissionType" defaultValue="business_default">
                {commissionOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="agencyCommissionRate">Agency / standard %</label>
              <input id="agencyCommissionRate" name="agencyCommissionRate" type="number" min="0" max="100" step="0.1" placeholder="Default" />
            </div>
            <div>
              <label htmlFor="salespersonCommissionRate">Salesperson %</label>
              <input id="salespersonCommissionRate" name="salespersonCommissionRate" type="number" min="0" max="100" step="0.1" placeholder="Default" />
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
                  <th>Business</th>
                  <th>Commission</th>
                  <th>Rates</th>
                  <th>Added</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((approvedUser) => {
                  const isSelf = approvedUser.email.toLowerCase() === currentEmail;
                  const commissionOverride = approvedUser.commission_type_override || "business_default";
                  return (
                    <tr key={approvedUser.email}>
                      <td>
                        <strong>{approvedUser.email}</strong>
                        {isSelf ? <span className="self-pill">You</span> : null}
                        <span className="muted-line">
                          {approvedUser.business_name || "No business"} ·{" "}
                          {commissionLabel(approvedUser.effective_commission_type)} ·{" "}
                          {formatRate(approvedUser.effective_agency_commission_rate)}% primary /{" "}
                          {formatRate(approvedUser.effective_salesperson_commission_rate)}% salesperson
                        </span>
                      </td>
                      <td colSpan={4}>
                        <form action={updateApprovedUser} className="inline-form wide-inline-form">
                          <input type="hidden" name="email" value={approvedUser.email} />
                          {isSelf ? <input type="hidden" name="role" value={approvedUser.role} /> : null}
                          <select name="role" defaultValue={approvedUser.role} disabled={isSelf}>
                            {roleOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                          <select name="businessId" defaultValue={approvedUser.business_id || ""}>
                            <option value="">No business</option>
                            {businesses.map((business) => (
                              <option key={business.id} value={business.id}>
                                {business.name}
                              </option>
                            ))}
                          </select>
                          <select name="commissionType" defaultValue={commissionOverride}>
                            {commissionOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                          <input
                            aria-label="Agency or standard commission percentage"
                            name="agencyCommissionRate"
                            type="number"
                            min="0"
                            max="100"
                            step="0.1"
                            placeholder="Default"
                            defaultValue={
                              approvedUser.agency_commission_rate_override === null
                                ? ""
                                : formatRate(approvedUser.agency_commission_rate_override)
                            }
                          />
                          <input
                            aria-label="Salesperson commission percentage"
                            name="salespersonCommissionRate"
                            type="number"
                            min="0"
                            max="100"
                            step="0.1"
                            placeholder="Default"
                            defaultValue={
                              approvedUser.salesperson_commission_rate_override === null
                                ? ""
                                : formatRate(approvedUser.salesperson_commission_rate_override)
                            }
                          />
                          <button className="secondary" type="submit" disabled={isSelf}>
                            Save
                          </button>
                        </form>
                      </td>
                      <td>{new Date(approvedUser.created_at).toLocaleDateString("en-AU")}</td>
                      <td>
                        <div className="action-stack">
                          <a className="button secondary" href={`/calculator?as=${encodeURIComponent(approvedUser.email)}`}>
                            Open
                          </a>
                          <form action={removeApprovedUser}>
                            <input type="hidden" name="email" value={approvedUser.email} />
                            <button className="danger" type="submit" disabled={isSelf}>
                              Remove
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!users.length ? (
                  <tr>
                    <td colSpan={7}>No approved users found.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="admin-help">
            <strong>Commission shown in table:</strong> a user with “Use business default” inherits
            the selected business setup. Standard commission uses the agency / standard percentage.
            Agency commission uses both percentages.
          </div>
        </section>
      </section>
    </main>
  );
}
