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

type SupabaseServer = Awaited<ReturnType<typeof createSupabaseServerClient>>;
type DbError = { message?: string; code?: string; details?: string; hint?: string } | null | undefined;

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

function dbMessage(error: DbError) {
  return String(error?.message || "");
}

function isSchemaCacheFunctionError(error: DbError) {
  const message = dbMessage(error).toLowerCase();
  return message.includes("schema cache") && message.includes("function");
}

function schemaSetupMessage(error: DbError) {
  const message = dbMessage(error);
  return `Supabase setup needs the latest business/user SQL. Run the full supabase/schema.sql file in Supabase SQL Editor, then wait a minute or refresh the schema cache. ${message}`;
}

function isUserRole(value: unknown): value is UserRole {
  return roleOptions.some((option) => option.value === value);
}

function isCommissionType(value: unknown): value is CommissionType {
  return value === "none" || value === "standard" || value === "agency";
}

function asNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeBusiness(row: Record<string, unknown>): Business {
  return {
    id: String(row.id || ""),
    name: String(row.name || "Unnamed business"),
    commission_type: isCommissionType(row.commission_type) ? row.commission_type : "none",
    agency_commission_rate: asNumber(row.agency_commission_rate, 0),
    salesperson_commission_rate: asNumber(row.salesperson_commission_rate, 0),
    created_at: String(row.created_at || new Date().toISOString()),
  };
}

function normalizeApprovedUser(
  row: Record<string, unknown>,
  businesses: Business[],
): ApprovedUser {
  const businessId = row.business_id ? String(row.business_id) : null;
  const business = businessId ? businesses.find((item) => item.id === businessId) : null;
  const role = isUserRole(row.role) ? row.role : "user";
  const commissionOverride = isCommissionType(row.commission_type_override)
    ? row.commission_type_override
    : null;
  const agencyOverride = row.agency_commission_rate_override;
  const salespersonOverride = row.salesperson_commission_rate_override;

  return {
    email: String(row.email || ""),
    role,
    business_id: businessId,
    business_name: String(row.business_name || business?.name || ""),
    commission_type_override: commissionOverride,
    agency_commission_rate_override:
      agencyOverride === null || agencyOverride === undefined ? null : asNumber(agencyOverride, 0),
    salesperson_commission_rate_override:
      salespersonOverride === null || salespersonOverride === undefined
        ? null
        : asNumber(salespersonOverride, 0),
    effective_commission_type: isCommissionType(row.effective_commission_type)
      ? row.effective_commission_type
      : commissionOverride || business?.commission_type || "none",
    effective_agency_commission_rate:
      row.effective_agency_commission_rate !== undefined
        ? asNumber(row.effective_agency_commission_rate, 0)
        : agencyOverride === null || agencyOverride === undefined
          ? business?.agency_commission_rate || 0
          : asNumber(agencyOverride, 0),
    effective_salesperson_commission_rate:
      row.effective_salesperson_commission_rate !== undefined
        ? asNumber(row.effective_salesperson_commission_rate, 0)
        : salespersonOverride === null || salespersonOverride === undefined
          ? business?.salesperson_commission_rate || 0
          : asNumber(salespersonOverride, 0),
    created_at: String(row.created_at || new Date().toISOString()),
  };
}

async function listBusinesses(supabase: SupabaseServer) {
  const rpcResult = await supabase.rpc("admin_list_businesses");
  if (!rpcResult.error) {
    return {
      data: ((rpcResult.data || []) as Record<string, unknown>[]).map(normalizeBusiness),
      errorMessage: "",
    };
  }

  if (!isSchemaCacheFunctionError(rpcResult.error)) {
    return { data: [] as Business[], errorMessage: dbMessage(rpcResult.error) };
  }

  const directResult = await supabase
    .from("businesses")
    .select("id, name, commission_type, agency_commission_rate, salesperson_commission_rate, created_at")
    .order("name", { ascending: true });

  if (directResult.error) {
    return {
      data: [] as Business[],
      errorMessage: schemaSetupMessage(directResult.error),
    };
  }

  return {
    data: ((directResult.data || []) as Record<string, unknown>[]).map(normalizeBusiness),
    errorMessage: "",
  };
}

async function listApprovedUsers(supabase: SupabaseServer, businesses: Business[]) {
  const rpcResult = await supabase.rpc("admin_list_approved_users");
  if (!rpcResult.error) {
    return {
      data: ((rpcResult.data || []) as Record<string, unknown>[]).map((row) =>
        normalizeApprovedUser(row, businesses),
      ),
      errorMessage: "",
    };
  }

  if (!isSchemaCacheFunctionError(rpcResult.error)) {
    return { data: [] as ApprovedUser[], errorMessage: dbMessage(rpcResult.error) };
  }

  const directResult = await supabase
    .from("approved_users")
    .select(
      "email, role, business_id, commission_type_override, agency_commission_rate_override, salesperson_commission_rate_override, created_at",
    )
    .order("created_at", { ascending: false });

  if (!directResult.error) {
    return {
      data: ((directResult.data || []) as Record<string, unknown>[]).map((row) =>
        normalizeApprovedUser(row, businesses),
      ),
      errorMessage: "",
    };
  }

  const legacyResult = await supabase
    .from("approved_users")
    .select("email, role, created_at")
    .order("created_at", { ascending: false });

  if (legacyResult.error) {
    return {
      data: [] as ApprovedUser[],
      errorMessage: schemaSetupMessage(directResult.error),
    };
  }

  return {
    data: ((legacyResult.data || []) as Record<string, unknown>[]).map((row) =>
      normalizeApprovedUser(row, businesses),
    ),
    errorMessage: schemaSetupMessage(directResult.error),
  };
}

async function saveBusiness(
  supabase: SupabaseServer,
  businessId: string | null,
  name: string,
  commissionType: CommissionType,
  agencyRate: number,
  salespersonRate: number,
) {
  const rpcResult = await supabase.rpc("admin_upsert_business", {
    target_business_id: businessId,
    target_name: name,
    target_commission_type: commissionType,
    target_agency_commission_rate: agencyRate,
    target_salesperson_commission_rate: salespersonRate,
  });

  if (!rpcResult.error) return "";
  if (!isSchemaCacheFunctionError(rpcResult.error)) return dbMessage(rpcResult.error);

  const payload = {
    name,
    commission_type: commissionType,
    agency_commission_rate: agencyRate,
    salesperson_commission_rate: salespersonRate,
    updated_at: new Date().toISOString(),
  };

  const directResult = businessId
    ? await supabase.from("businesses").update(payload).eq("id", businessId)
    : await supabase.from("businesses").insert(payload);

  return directResult.error ? schemaSetupMessage(directResult.error) : "";
}

async function saveApprovedUser(
  supabase: SupabaseServer,
  email: string,
  role: UserRole,
  businessId: string | null,
  commissionType: CommissionOverride,
  agencyRate: number | null,
  salespersonRate: number | null,
) {
  const commissionOverride = commissionType === "business_default" ? null : commissionType;
  const rpcResult = await supabase.rpc("admin_upsert_approved_user", {
    target_email: email,
    target_role: role,
    target_business_id: businessId,
    target_commission_type_override: commissionOverride,
    target_agency_commission_rate_override: agencyRate,
    target_salesperson_commission_rate_override: salespersonRate,
  });

  if (!rpcResult.error) return "";
  if (!isSchemaCacheFunctionError(rpcResult.error)) return dbMessage(rpcResult.error);

  const directResult = await supabase.from("approved_users").upsert(
    {
      email,
      role,
      business_id: businessId,
      commission_type_override: commissionOverride,
      agency_commission_rate_override: agencyRate,
      salesperson_commission_rate_override: salespersonRate,
    },
    { onConflict: "email" },
  );

  return directResult.error ? schemaSetupMessage(directResult.error) : "";
}

async function deleteApprovedUser(supabase: SupabaseServer, email: string) {
  const rpcResult = await supabase.rpc("admin_delete_approved_user", {
    target_email: email,
  });

  if (!rpcResult.error) return "";
  if (!isSchemaCacheFunctionError(rpcResult.error)) return dbMessage(rpcResult.error);

  const directResult = await supabase.from("approved_users").delete().eq("email", email);
  return directResult.error ? schemaSetupMessage(directResult.error) : "";
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

  const errorMessage = await saveBusiness(
    supabase,
    businessId,
    name,
    commissionType === "business_default" ? "none" : commissionType,
    agencyRate,
    salespersonRate,
  );

  if (errorMessage) {
    redirect(`/admin/users?error=${encodeURIComponent(errorMessage)}`);
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

  const errorMessage = await saveApprovedUser(
    supabase,
    email,
    role,
    businessId,
    commissionType,
    agencyRate,
    salespersonRate,
  );

  if (errorMessage) {
    redirect(`/admin/users?error=${encodeURIComponent(errorMessage)}`);
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

  const errorMessage = await saveApprovedUser(
    supabase,
    email,
    role,
    businessId,
    commissionType,
    agencyRate,
    salespersonRate,
  );

  if (errorMessage) {
    redirect(`/admin/users?error=${encodeURIComponent(errorMessage)}`);
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

  const errorMessage = await deleteApprovedUser(supabase, email);

  if (errorMessage) {
    redirect(`/admin/users?error=${encodeURIComponent(errorMessage)}`);
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
  const businessResult = await listBusinesses(supabase);
  const usersResult = await listApprovedUsers(supabase, businessResult.data);

  const businesses = businessResult.data;
  const users = usersResult.data;
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
        {businessResult.errorMessage ? (
          <div className="notice">Supabase business setup: {businessResult.errorMessage}</div>
        ) : null}
        {usersResult.errorMessage ? (
          <div className="notice">Supabase user setup: {usersResult.errorMessage}</div>
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
