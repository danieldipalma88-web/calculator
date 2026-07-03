import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import Script from "next/script";
import { canManageUsers } from "../../../lib/admin";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

type UserRole = "admin" | "business_owner" | "agency" | "salesperson" | "user";
type CommissionType = "none" | "standard" | "agency";
type CommissionOverride = CommissionType | "business_default";
type OperatingState = "NSW" | "VIC" | "QLD" | "SA" | "WA" | "TAS" | "ACT" | "NT";
type WonPaymentStatus = "not_paid_in" | "paid_in" | "paid_out";
type WonOptionUpdateMode = "unlock" | "delete" | "paid_in" | "paid_out" | "reset_payment";

type Business = {
  id: string;
  name: string;
  operating_state: OperatingState;
  commission_type: CommissionType;
  agency_commission_rate: number;
  salesperson_commission_rate: number;
  created_at: string;
};

type ApprovedUser = {
  email: string;
  display_name: string;
  role: UserRole;
  business_id: string | null;
  business_name: string | null;
  business_ids: string[];
  business_names: string[];
  commission_type_override: CommissionType | null;
  agency_commission_rate_override: number | null;
  salesperson_commission_rate_override: number | null;
  effective_commission_type: CommissionType;
  effective_agency_commission_rate: number;
  effective_salesperson_commission_rate: number;
  created_at: string;
};

type CalculatorDataRow = {
  email: string | null;
  data: Record<string, unknown> | null;
  updated_at?: string | null;
};

type WonOption = {
  userEmail: string;
  userName: string;
  businessName: string;
  sourceId: string;
  optionId: string;
  optionName: string;
  wonAt: string;
  paidInAt: string;
  paidOutAt: string;
  paymentStatus: WonPaymentStatus;
  paymentStatusLabel: string;
  systemCount: number;
  customerTotal: number;
  rebateTotal: number;
  agencyCommissionTotal: number;
  salespersonCommissionTotal: number;
  installerProfitTotal: number;
  rows: {
    label: string;
    install: string;
    finalInc: number;
    rebate: number;
    agencyCommissionInc: number;
    salespersonCommissionInc: number;
    netProfit: number;
  }[];
};

type SalespersonSalesSummary = {
  userEmail: string;
  userName: string;
  businessNames: string;
  saleCount: number;
  customerTotal: number;
  agencyCommissionTotal: number;
  salespersonCommissionTotal: number;
  notPaidInCount: number;
  paidInCount: number;
  paidOutCount: number;
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

const operatingStateOptions: { value: OperatingState; label: string; rebateLabel: string }[] = [
  { value: "NSW", label: "New South Wales", rebateLabel: "NSW ESS/PDRS" },
  { value: "VIC", label: "Victoria", rebateLabel: "VEU not configured" },
  { value: "QLD", label: "Queensland", rebateLabel: "No rebates" },
  { value: "SA", label: "South Australia", rebateLabel: "No rebates" },
  { value: "WA", label: "Western Australia", rebateLabel: "No rebates" },
  { value: "TAS", label: "Tasmania", rebateLabel: "No rebates" },
  { value: "ACT", label: "ACT", rebateLabel: "No rebates" },
  { value: "NT", label: "Northern Territory", rebateLabel: "No rebates" },
];

const OPTION_DEF_STORAGE_KEYS = [
  "installerQuoteOptionDefsV1",
  "greenEnergyQuoteOptionDefsV1",
  "QuoteOptionDefsV1",
];

const QUOTE_STORAGE_KEYS = [
  "installerMasterQuoteLogV1",
  "greenEnergyMasterQuoteLogV1",
  "MasterQuoteLogV1",
];

const SAVED_QUOTE_SET_STORAGE_KEYS = [
  "installerSavedQuoteSetsV1",
  "greenEnergySavedQuoteSetsV1",
  "SavedQuoteSetsV1",
];

const WON_PAYMENT_KEYS = [
  "agencyPaidInAt",
  "agencyPaidInByEmail",
  "paidInAt",
  "paidInByEmail",
  "salespersonPaidOutAt",
  "salespersonPaidOutByEmail",
  "paidOutAt",
  "paidOutByEmail",
];

export const dynamic = "force-dynamic";
export const revalidate = 0;

function normalizeEmail(value: FormDataEntryValue | null) {
  return String(value || "").trim().toLowerCase();
}

function normalizeText(value: FormDataEntryValue | null) {
  return String(value || "").trim();
}

function displayNameFor(user: Pick<ApprovedUser, "display_name" | "email">) {
  return user.display_name || user.email;
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

function normalizeOperatingState(value: FormDataEntryValue | unknown): OperatingState {
  const operatingState = String(value || "NSW").trim().toUpperCase();
  return operatingStateOptions.some((option) => option.value === operatingState)
    ? (operatingState as OperatingState)
    : "NSW";
}

function nullableUuid(value: FormDataEntryValue | null) {
  const normalized = normalizeText(value);
  return normalized ? normalized : null;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function businessIdsFromForm(formData: FormData) {
  return uniqueStrings(formData.getAll("businessIds").map((value) => String(value || "")));
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

function operatingStateLabel(value: OperatingState) {
  return operatingStateOptions.find((option) => option.value === value)?.label || value;
}

function rebateSchemeLabel(value: OperatingState) {
  return operatingStateOptions.find((option) => option.value === value)?.rebateLabel || "No rebates";
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
    operating_state: normalizeOperatingState(row.operating_state),
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
    display_name: String(row.display_name || ""),
    role,
    business_id: businessId,
    business_name: String(row.business_name || business?.name || ""),
    business_ids: businessId ? [businessId] : [],
    business_names: business?.name ? [business.name] : [],
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
    .select("id, name, operating_state, commission_type, agency_commission_rate, salesperson_commission_rate, created_at")
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
      "email, display_name, role, business_id, commission_type_override, agency_commission_rate_override, salesperson_commission_rate_override, created_at",
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

  const preNameResult = await supabase
    .from("approved_users")
    .select(
      "email, role, business_id, commission_type_override, agency_commission_rate_override, salesperson_commission_rate_override, created_at",
    )
    .order("created_at", { ascending: false });

  if (!preNameResult.error) {
    return {
      data: ((preNameResult.data || []) as Record<string, unknown>[]).map((row) =>
        normalizeApprovedUser(row, businesses),
      ),
      errorMessage: schemaSetupMessage(directResult.error),
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

async function listUserBusinessMemberships(supabase: SupabaseServer, businesses: Business[]) {
  const result = await supabase
    .from("approved_user_businesses")
    .select("email, business_id");

  if (result.error) {
    return {
      data: new Map<string, { ids: string[]; names: string[] }>(),
      errorMessage: schemaSetupMessage(result.error),
    };
  }

  const businessById = new Map(businesses.map((business) => [business.id, business]));
  const memberships = new Map<string, { ids: string[]; names: string[] }>();

  ((result.data || []) as { email?: string | null; business_id?: string | null }[]).forEach((row) => {
    const email = String(row.email || "").toLowerCase();
    const businessId = String(row.business_id || "");
    if (!email || !businessId) return;
    const entry = memberships.get(email) || { ids: [], names: [] };
    if (!entry.ids.includes(businessId)) entry.ids.push(businessId);
    const businessName = businessById.get(businessId)?.name;
    if (businessName && !entry.names.includes(businessName)) entry.names.push(businessName);
    memberships.set(email, entry);
  });

  return { data: memberships, errorMessage: "" };
}

function applyMembershipsToUsers(
  users: ApprovedUser[],
  memberships: Map<string, { ids: string[]; names: string[] }>,
) {
  return users.map((user) => {
    const membership = memberships.get(user.email.toLowerCase());
    if (!membership || !membership.ids.length) return user;
    return {
      ...user,
      business_ids: membership.ids,
      business_names: membership.names,
    };
  });
}

async function saveBusiness(
  supabase: SupabaseServer,
  businessId: string | null,
  name: string,
  operatingState: OperatingState,
  commissionType: CommissionType,
  agencyRate: number,
  salespersonRate: number,
) {
  const rpcResult = await supabase.rpc("admin_upsert_business", {
    target_business_id: businessId,
    target_name: name,
    target_operating_state: operatingState,
    target_commission_type: commissionType,
    target_agency_commission_rate: agencyRate,
    target_salesperson_commission_rate: salespersonRate,
  });

  if (!rpcResult.error) return "";
  if (!isSchemaCacheFunctionError(rpcResult.error)) return dbMessage(rpcResult.error);

  const payload = {
    name,
    operating_state: operatingState,
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
  displayName: string,
  role: UserRole,
  businessIds: string[],
  commissionType: CommissionOverride,
  agencyRate: number | null,
  salespersonRate: number | null,
) {
  const commissionOverride = commissionType === "business_default" ? null : commissionType;
  const primaryBusinessId = businessIds[0] || null;
  const rpcResult = await supabase.rpc("admin_upsert_approved_user", {
    target_email: email,
    target_role: role,
    target_display_name: displayName,
    target_business_id: primaryBusinessId,
    target_commission_type_override: commissionOverride,
    target_agency_commission_rate_override: agencyRate,
    target_salesperson_commission_rate_override: salespersonRate,
  });

  if (!rpcResult.error) return saveUserBusinessMemberships(supabase, email, businessIds);
  if (!isSchemaCacheFunctionError(rpcResult.error)) return dbMessage(rpcResult.error);

  const directResult = await supabase.from("approved_users").upsert(
    {
      email,
      display_name: displayName || null,
      role,
      business_id: primaryBusinessId,
      commission_type_override: commissionOverride,
      agency_commission_rate_override: agencyRate,
      salesperson_commission_rate_override: salespersonRate,
    },
    { onConflict: "email" },
  );

  if (!directResult.error) return saveUserBusinessMemberships(supabase, email, businessIds);

  const preNameResult = await supabase.from("approved_users").upsert(
    {
      email,
      role,
      business_id: primaryBusinessId,
      commission_type_override: commissionOverride,
      agency_commission_rate_override: agencyRate,
      salesperson_commission_rate_override: salespersonRate,
    },
    { onConflict: "email" },
  );

  if (preNameResult.error) return schemaSetupMessage(directResult.error);
  return saveUserBusinessMemberships(supabase, email, businessIds);
}

async function saveUserBusinessMemberships(
  supabase: SupabaseServer,
  email: string,
  businessIds: string[],
) {
  const normalizedEmail = email.toLowerCase();
  const deleteResult = await supabase
    .from("approved_user_businesses")
    .delete()
    .eq("email", normalizedEmail);

  if (deleteResult.error) return schemaSetupMessage(deleteResult.error);
  if (!businessIds.length) return "";

  const insertResult = await supabase.from("approved_user_businesses").insert(
    businessIds.map((businessId) => ({
      email: normalizedEmail,
      business_id: businessId,
    })),
  );

  return insertResult.error ? schemaSetupMessage(insertResult.error) : "";
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

function parseStoredJson<T>(value: unknown, fallback: T): T {
  if (Array.isArray(value) || (value && typeof value === "object")) return value as T;
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function storedJsonKey(data: Record<string, unknown>, keys: string[]) {
  return keys.find((key) => key in data) || keys[0];
}

function serializeLikeStoredValue(original: unknown, value: unknown) {
  return typeof original === "string" || original === undefined ? JSON.stringify(value) : value;
}

function moneyValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function quoteStateDisablesRebates(row: Record<string, unknown>) {
  const state = row.state && typeof row.state === "object" ? row.state as Record<string, unknown> : {};
  if (state.rebatesEnabled === false) return true;
  const scheme = String(state.rebateScheme || "").toLowerCase();
  if (scheme === "none" || scheme === "veu") return true;
  const operatingState = String(state.businessOperatingState || "").toUpperCase();
  return Boolean(operatingState && operatingState !== "NSW");
}

function quoteRebateValue(row: Record<string, unknown>) {
  if (quoteStateDisablesRebates(row)) return 0;
  const state = row.state && typeof row.state === "object" ? row.state as Record<string, unknown> : {};
  const values = [
    row.rebate,
    row.rebateAmount,
    row.rebateInc,
    state.rebate,
    state.rebateAmount,
    state.rebateInc,
    state.savedRebate,
  ].map(moneyValue);
  return values.find((value) => Math.abs(value) > 0.0001) || 0;
}

function quoteMaterialsInc(row: Record<string, unknown>) {
  if (row.materialsInc !== undefined) return moneyValue(row.materialsInc);
  return moneyValue(row.matsEx) * 1.1;
}

function optionRowLabel(row: Record<string, unknown>) {
  return [row.size, row.brand, row.series, row.type].filter(Boolean).join(" ");
}

function formatMoney(value: number) {
  return value.toLocaleString("en-AU", { style: "currency", currency: "AUD" });
}

function businessSelectionLabel(businesses: Business[], selectedIds: string[]) {
  if (!businesses.length) return "No businesses available";
  const selected = businesses.filter((business) => selectedIds.includes(business.id));
  if (!selected.length) return "No business selected";
  if (selected.length === 1) return selected[0].name;
  return `${selected.length} businesses selected`;
}

function BusinessMultiSelect({
  businesses,
  selectedIds,
}: {
  businesses: Business[];
  selectedIds: string[];
}) {
  const selectedSet = new Set(selectedIds);

  return (
    <details className="business-multiselect">
      <summary className="business-multiselect-summary">
        <span className="business-multiselect-label">
          {businessSelectionLabel(businesses, selectedIds)}
        </span>
        <span aria-hidden="true">v</span>
      </summary>
      <div className="business-multiselect-menu">
        {businesses.map((business) => (
          <label className="checkbox-pill" key={business.id}>
            <input
              type="checkbox"
              name="businessIds"
              value={business.id}
              defaultChecked={selectedSet.has(business.id)}
            />
            <span>{business.name}</span>
          </label>
        ))}
        {!businesses.length ? <span className="empty-select-note">Add a business first.</span> : null}
      </div>
    </details>
  );
}

function formatShortDate(value: string) {
  return value ? new Date(value).toLocaleDateString("en-AU") : "";
}

function wonPaymentStatus(paidInAt: string, paidOutAt: string): WonPaymentStatus {
  if (paidOutAt) return "paid_out";
  if (paidInAt) return "paid_in";
  return "not_paid_in";
}

function wonPaymentStatusLabel(status: WonPaymentStatus) {
  if (status === "paid_out") return "Paid out";
  if (status === "paid_in") return "Paid in, not paid out";
  return "Not paid in";
}

function wonOptionDomKey(option: Pick<WonOption, "userEmail" | "sourceId" | "optionId" | "wonAt">) {
  return `${option.userEmail}-${option.sourceId}-${option.optionId}-${option.wonAt}`;
}

function clearWonPaymentFields(record: Record<string, unknown>) {
  const next = { ...record };
  WON_PAYMENT_KEYS.forEach((key) => {
    delete next[key];
  });
  return next;
}

function applyWonPaymentFields(
  record: Record<string, unknown>,
  mode: Exclude<WonOptionUpdateMode, "unlock" | "delete">,
  adminEmail: string,
) {
  const next = { ...record };
  const now = new Date().toISOString();

  if (mode === "reset_payment") return clearWonPaymentFields(next);

  if (mode === "paid_in") {
    delete next.salespersonPaidOutAt;
    delete next.salespersonPaidOutByEmail;
    delete next.paidOutAt;
    delete next.paidOutByEmail;
  }

  next.agencyPaidInAt = String(next.agencyPaidInAt || next.paidInAt || now);
  next.agencyPaidInByEmail = String(next.agencyPaidInByEmail || next.paidInByEmail || adminEmail);
  next.paidInAt = String(next.paidInAt || next.agencyPaidInAt || now);
  next.paidInByEmail = String(next.paidInByEmail || next.agencyPaidInByEmail || adminEmail);

  if (mode === "paid_out") {
    next.salespersonPaidOutAt = now;
    next.salespersonPaidOutByEmail = adminEmail;
    next.paidOutAt = now;
    next.paidOutByEmail = adminEmail;
  }

  return next;
}

function wonExportRow(option: WonOption) {
  return {
    Salesperson: option.userName,
    Email: option.userEmail,
    Business: option.businessName,
    Option: option.optionName,
    "Won date": formatShortDate(option.wonAt),
    Status: option.paymentStatusLabel,
    "Paid in date": formatShortDate(option.paidInAt),
    "Paid out date": formatShortDate(option.paidOutAt),
    Systems: String(option.systemCount),
    "Customer total inc GST": option.customerTotal.toFixed(2),
    Rebate: option.rebateTotal.toFixed(2),
    "Agency commission inc GST": option.agencyCommissionTotal.toFixed(2),
    "Salesperson commission inc GST": option.salespersonCommissionTotal.toFixed(2),
    "Installer profit ex GST": option.installerProfitTotal.toFixed(2),
    "System details": option.rows
      .map((row) => `${row.label} | ${row.install} | ${formatMoney(row.finalInc)} customer`)
      .join(" ; "),
  };
}

function summarizeSalesBySalesperson(wonOptions: WonOption[]) {
  const summaries = new Map<string, SalespersonSalesSummary>();

  wonOptions.forEach((option) => {
    const existing =
      summaries.get(option.userEmail) ||
      ({
        userEmail: option.userEmail,
        userName: option.userName,
        businessNames: option.businessName,
        saleCount: 0,
        customerTotal: 0,
        agencyCommissionTotal: 0,
        salespersonCommissionTotal: 0,
        notPaidInCount: 0,
        paidInCount: 0,
        paidOutCount: 0,
      } satisfies SalespersonSalesSummary);

    existing.saleCount += 1;
    existing.customerTotal += option.customerTotal;
    existing.agencyCommissionTotal += option.agencyCommissionTotal;
    existing.salespersonCommissionTotal += option.salespersonCommissionTotal;
    if (option.paymentStatus === "paid_out") existing.paidOutCount += 1;
    else if (option.paymentStatus === "paid_in") existing.paidInCount += 1;
    else existing.notPaidInCount += 1;

    const businessNames = new Set(
      `${existing.businessNames},${option.businessName}`
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    );
    existing.businessNames = [...businessNames].join(", ");
    summaries.set(option.userEmail, existing);
  });

  return [...summaries.values()].sort((a, b) => b.customerTotal - a.customerTotal);
}

function wonExportScript() {
  return `
(function(){
  function csvEscape(value) {
    var text = String(value == null ? "" : value);
    return /[",\\r\\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }
  function parseCard(card) {
    if (!card) return null;
    try { return JSON.parse(card.getAttribute("data-export-row") || "{}"); }
    catch (error) { return null; }
  }
  function salespersonCardForEmail(email) {
    return Array.prototype.slice.call(document.querySelectorAll("[data-salesperson-filter]")).find(function(card){
      return String(card.getAttribute("data-salesperson-filter") || "").toLowerCase() === email;
    });
  }
  var selectAll = document.querySelector("[data-select-all-won]");
  function visibleWonCards() {
    return Array.prototype.slice.call(document.querySelectorAll(".won-card")).filter(function(card){
      return !card.hidden;
    });
  }
  function updateSelectAllLabel() {
    if (!selectAll) return;
    var visibleBoxes = visibleWonCards()
      .map(function(card){ return card.querySelector(".won-sale-select"); })
      .filter(Boolean);
    var hasVisibleUnchecked = visibleBoxes.some(function(box){ return !box.checked; });
    selectAll.textContent = visibleBoxes.length && !hasVisibleUnchecked ? "Clear visible" : "Select visible";
  }
  function updateWonFilterStatus(activeEmails) {
    var status = document.querySelector("[data-won-filter-status]");
    if (!status) return;
    var visibleCount = visibleWonCards().length;
    if (!activeEmails.length) {
      status.textContent = "Showing all " + visibleCount + " won options.";
      return;
    }
    var names = activeEmails.map(function(email){
      var card = salespersonCardForEmail(email);
      return card ? String(card.getAttribute("data-salesperson-name") || email) : email;
    });
    status.textContent = "Showing " + visibleCount + " won options for " + names.join(", ") + ".";
  }
  function activeSalespersonEmails() {
    return Array.prototype.slice.call(document.querySelectorAll(".sales-summary-card.is-active"))
      .map(function(card){ return String(card.getAttribute("data-salesperson-filter") || "").toLowerCase(); })
      .filter(Boolean);
  }
  function applyWonSalespersonFilter() {
    var activeEmails = activeSalespersonEmails();
    var hasFilter = activeEmails.length > 0;
    Array.prototype.slice.call(document.querySelectorAll(".won-card")).forEach(function(card){
      var email = String(card.getAttribute("data-won-user-email") || "").toLowerCase();
      var show = !hasFilter || activeEmails.indexOf(email) >= 0;
      card.hidden = !show;
      if (!show) {
        var box = card.querySelector(".won-sale-select");
        if (box) box.checked = false;
      }
    });
    updateSelectAllLabel();
    updateWonFilterStatus(activeEmails);
  }
  Array.prototype.slice.call(document.querySelectorAll("[data-salesperson-filter]")).forEach(function(card){
    if (card.getAttribute("data-won-filter-ready") === "true") return;
    card.setAttribute("data-won-filter-ready", "true");
    function toggleCard() {
      card.classList.toggle("is-active");
      card.setAttribute("aria-pressed", card.classList.contains("is-active") ? "true" : "false");
      applyWonSalespersonFilter();
    }
    card.addEventListener("click", toggleCard);
    card.addEventListener("keydown", function(event){
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleCard();
    });
  });
  if (selectAll) {
    selectAll.addEventListener("click", function(){
      var boxes = visibleWonCards()
        .map(function(card){ return card.querySelector(".won-sale-select"); })
        .filter(Boolean);
      var shouldCheck = boxes.some(function(box){ return !box.checked; });
      boxes.forEach(function(box){ box.checked = shouldCheck; });
      updateSelectAllLabel();
    });
  }
  var exportButton = document.querySelector("[data-export-won-selected]");
  if (exportButton) {
    exportButton.addEventListener("click", function(){
      var visibleCards = visibleWonCards();
      var checked = visibleCards
        .map(function(card){ return card.querySelector(".won-sale-select:checked"); })
        .filter(Boolean);
      var cards = checked.length
        ? checked.map(function(box){ return box.closest(".won-card"); })
        : visibleCards;
      var rows = cards.map(parseCard).filter(Boolean);
      if (!rows.length) return;
      var headers = Object.keys(rows[0]);
      var csv = [headers.map(csvEscape).join(",")].concat(rows.map(function(row){
        return headers.map(function(header){ return csvEscape(row[header]); }).join(",");
      })).join("\\r\\n");
      var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = "won-sales-export.csv";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    });
  }
  applyWonSalespersonFilter();
})();
`;
}

function businessMultiSelectScript() {
  return `
(function(){
  function updateLabel(details) {
    var label = details.querySelector(".business-multiselect-label");
    var checked = Array.prototype.slice.call(details.querySelectorAll("input[type='checkbox']:checked"));
    if (!label) return;
    if (!checked.length) {
      label.textContent = "No business selected";
      return;
    }
    if (checked.length === 1) {
      var text = checked[0].closest("label");
      label.textContent = text ? text.innerText.trim() : "1 business selected";
      return;
    }
    label.textContent = checked.length + " businesses selected";
  }
  Array.prototype.slice.call(document.querySelectorAll(".business-multiselect")).forEach(function(details){
    updateLabel(details);
    details.addEventListener("toggle", function(){
      if (!details.open) return;
      Array.prototype.slice.call(document.querySelectorAll(".business-multiselect[open]")).forEach(function(other){
        if (other !== details) other.open = false;
      });
    });
    Array.prototype.slice.call(details.querySelectorAll("input[type='checkbox']")).forEach(function(input){
      input.addEventListener("change", function(){ updateLabel(details); });
    });
  });
})();
`;
}

const CURRENT_WON_SOURCE_ID = "current";

function savedQuoteSetSourceId(set: Record<string, unknown>, index: number) {
  const id = String(set.id || "").trim();
  return id ? `saved:${id}` : `saved-index:${index}`;
}

function wonOptionKey(email: string, optionId: string, wonAt: string) {
  return `${email}|${optionId}|${wonAt}`;
}

function addWonOptionsFromSnapshot({
  wonOptions,
  usersByEmail,
  email,
  user,
  optionDefs,
  quotes,
  sourceId,
  updatedAt,
}: {
  wonOptions: Map<string, WonOption>;
  usersByEmail: Map<string, ApprovedUser>;
  email: string;
  user: ApprovedUser | undefined;
  optionDefs: Record<string, unknown>[];
  quotes: Record<string, unknown>[];
  sourceId: string;
  updatedAt: string;
}) {
  optionDefs
    .filter((option) => option && option.wonAt)
    .forEach((option) => {
      const optionId = String(option.id || "");
      const wonAt = String(option.wonAt || updatedAt || "");
      const key = wonOptionKey(email, optionId, wonAt);
      const rows = quotes.filter((quote) => String(quote.optionId || "option_1") === optionId);
      const paidInAt = String(option.agencyPaidInAt || option.paidInAt || "");
      const paidOutAt = String(option.salespersonPaidOutAt || option.paidOutAt || "");
      const paymentStatus = wonPaymentStatus(paidInAt, paidOutAt);
      const firstBusinessName = rows
        .map((quote) => String(quote.businessName || ""))
        .find(Boolean);
      const wonRows = rows.map((quote) => ({
        label: optionRowLabel(quote) || String(quote.model || "System"),
        install: String(quote.install || ""),
        finalInc: moneyValue(quote.finalInc),
        rebate: quoteRebateValue(quote),
        agencyCommissionInc: moneyValue(quote.agencyCommissionInc ?? quote.commissionInc),
        salespersonCommissionInc: moneyValue(quote.salespersonCommissionInc),
        netProfit: moneyValue(quote.netProfit),
      }));
      const existing = wonOptions.get(key);
      if (existing && (existing.rows.length || !wonRows.length)) return;

      wonOptions.set(key, {
        userEmail: email,
        userName: user ? displayNameFor(user) : usersByEmail.get(email)?.email || email,
        businessName:
          String(option.businessName || firstBusinessName || "") ||
          user?.business_names.join(", ") ||
          user?.business_name ||
          "No business",
        sourceId,
        optionId,
        optionName: String(option.name || "Option"),
        wonAt,
        paidInAt,
        paidOutAt,
        paymentStatus,
        paymentStatusLabel: wonPaymentStatusLabel(paymentStatus),
        systemCount: rows.length,
        customerTotal: rows.reduce((sum, quote) => sum + moneyValue(quote.finalInc), 0),
        rebateTotal: rows.reduce((sum, quote) => sum + quoteRebateValue(quote), 0),
        agencyCommissionTotal: rows.reduce(
          (sum, quote) => sum + moneyValue(quote.agencyCommissionInc ?? quote.commissionInc),
          0,
        ),
        salespersonCommissionTotal: rows.reduce(
          (sum, quote) => sum + moneyValue(quote.salespersonCommissionInc),
          0,
        ),
        installerProfitTotal: rows.reduce((sum, quote) => sum + moneyValue(quote.netProfit), 0),
        rows: wonRows,
      });
    });
}

async function listWonOptions(supabase: SupabaseServer, users: ApprovedUser[]) {
  const dataResult = await supabase
    .from("user_calculator_data")
    .select("email, data, updated_at")
    .not("email", "is", null);

  if (dataResult.error) {
    return { data: [] as WonOption[], errorMessage: dbMessage(dataResult.error) };
  }

  const usersByEmail = new Map(users.map((user) => [user.email.toLowerCase(), user]));
  const wonOptions = new Map<string, WonOption>();

  ((dataResult.data || []) as CalculatorDataRow[]).forEach((row) => {
    const email = String(row.email || "").toLowerCase();
    if (!email) return;

    const data = row.data || {};
    const optionDefs = parseStoredJson<Record<string, unknown>[]>(
      data.installerQuoteOptionDefsV1 || data.greenEnergyQuoteOptionDefsV1 || data.QuoteOptionDefsV1,
      [],
    );
    const quotes = parseStoredJson<Record<string, unknown>[]>(
      data.installerMasterQuoteLogV1 || data.greenEnergyMasterQuoteLogV1 || data.MasterQuoteLogV1,
      [],
    );
    const user = usersByEmail.get(email);
    addWonOptionsFromSnapshot({
      wonOptions,
      usersByEmail,
      email,
      user,
      optionDefs,
      quotes,
      sourceId: CURRENT_WON_SOURCE_ID,
      updatedAt: String(row.updated_at || ""),
    });

    const savedQuoteSets = parseStoredJson<Record<string, unknown>[]>(
      data.installerSavedQuoteSetsV1 || data.greenEnergySavedQuoteSetsV1 || data.SavedQuoteSetsV1,
      [],
    );
    savedQuoteSets.forEach((savedQuoteSet, index) => {
      addWonOptionsFromSnapshot({
        wonOptions,
        usersByEmail,
        email,
        user,
        optionDefs: Array.isArray(savedQuoteSet.optionDefs) ? savedQuoteSet.optionDefs as Record<string, unknown>[] : [],
        quotes: Array.isArray(savedQuoteSet.quotes) ? savedQuoteSet.quotes as Record<string, unknown>[] : [],
        sourceId: savedQuoteSetSourceId(savedQuoteSet, index),
        updatedAt: String(savedQuoteSet.savedAt || row.updated_at || ""),
      });
    });
  });

  return {
    data: [...wonOptions.values()].sort((a, b) => Number(new Date(b.wonAt)) - Number(new Date(a.wonAt))),
    errorMessage: "",
  };
}

async function updateWonOptionState(
  supabase: SupabaseServer,
  userEmail: string,
  optionId: string,
  mode: WonOptionUpdateMode,
  adminEmail = "",
  sourceId = CURRENT_WON_SOURCE_ID,
) {
  const email = userEmail.toLowerCase();
  const dataResult = await supabase
    .from("user_calculator_data")
    .select("data")
    .eq("email", email)
    .maybeSingle();

  if (dataResult.error) return dbMessage(dataResult.error);
  if (!dataResult.data?.data) return "Could not find saved calculator data for this user.";

  const data = { ...(dataResult.data.data as Record<string, unknown>) };
  let updated = false;

  function updateOptionCollections(
    optionDefs: Record<string, unknown>[],
    quotes: Record<string, unknown>[],
  ) {
    if (!optionDefs.some((option) => String(option.id || "") === optionId)) return null;

    let nextOptionDefs: Record<string, unknown>[];
    let nextQuotes: Record<string, unknown>[];

    if (mode === "delete") {
      nextOptionDefs = optionDefs.filter((option) => String(option.id || "") !== optionId);
      nextQuotes = quotes.filter((quote) => String(quote.optionId || "option_1") !== optionId);
      if (!nextOptionDefs.length) nextOptionDefs = [{ id: "option_1", name: "Option 1" }];
    } else if (mode === "unlock") {
      nextOptionDefs = optionDefs.map((option) => {
        if (String(option.id || "") !== optionId) return option;
        const next = clearWonPaymentFields(option);
        delete next.wonAt;
        delete next.wonByEmail;
        delete next.wonByName;
        return next;
      });
      nextQuotes = quotes.map((quote) => {
        if (String(quote.optionId || "option_1") !== optionId) return quote;
        const next = clearWonPaymentFields(quote);
        delete next.wonAt;
        delete next.wonByEmail;
        delete next.wonByName;
        return next;
      });
    } else {
      nextOptionDefs = optionDefs.map((option) =>
        String(option.id || "") === optionId ? applyWonPaymentFields(option, mode, adminEmail) : option,
      );
      nextQuotes = quotes.map((quote) =>
        String(quote.optionId || "option_1") === optionId
          ? applyWonPaymentFields(quote, mode, adminEmail)
          : quote,
      );
    }

    return { optionDefs: nextOptionDefs, quotes: nextQuotes };
  }

  if (sourceId === CURRENT_WON_SOURCE_ID) {
    const optionDefsKey = storedJsonKey(data, OPTION_DEF_STORAGE_KEYS);
    const quotesKey = storedJsonKey(data, QUOTE_STORAGE_KEYS);
    const optionDefs = parseStoredJson<Record<string, unknown>[]>(data[optionDefsKey], []);
    const quotes = parseStoredJson<Record<string, unknown>[]>(data[quotesKey], []);
    const next = updateOptionCollections(optionDefs, quotes);
    if (next) {
      data[optionDefsKey] = serializeLikeStoredValue(data[optionDefsKey], next.optionDefs);
      data[quotesKey] = serializeLikeStoredValue(data[quotesKey], next.quotes);
      updated = true;
    }
  } else {
    const savedSetsKey = storedJsonKey(data, SAVED_QUOTE_SET_STORAGE_KEYS);
    const savedQuoteSets = parseStoredJson<Record<string, unknown>[]>(data[savedSetsKey], []);
    const nextSavedQuoteSets = savedQuoteSets.map((savedQuoteSet, index) => {
      if (savedQuoteSetSourceId(savedQuoteSet, index) !== sourceId) return savedQuoteSet;
      const optionDefs = Array.isArray(savedQuoteSet.optionDefs)
        ? savedQuoteSet.optionDefs as Record<string, unknown>[]
        : [];
      const quotes = Array.isArray(savedQuoteSet.quotes)
        ? savedQuoteSet.quotes as Record<string, unknown>[]
        : [];
      const next = updateOptionCollections(optionDefs, quotes);
      if (!next) return savedQuoteSet;
      updated = true;
      return { ...savedQuoteSet, optionDefs: next.optionDefs, quotes: next.quotes };
    });
    if (updated) data[savedSetsKey] = serializeLikeStoredValue(data[savedSetsKey], nextSavedQuoteSets);
  }

  if (!updated) return "Could not find that won option in the saved calculator data.";

  const updateResult = await supabase
    .from("user_calculator_data")
    .update({ data, updated_at: new Date().toISOString() })
    .eq("email", email);

  return updateResult.error ? dbMessage(updateResult.error) : "";
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
  const operatingState = normalizeOperatingState(formData.get("operatingState"));
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
    operatingState,
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
  const displayName = normalizeText(formData.get("displayName"));
  const role = normalizeRole(formData.get("role"));
  const businessIds = businessIdsFromForm(formData);
  const commissionType = normalizeCommissionOverride(formData.get("commissionType"));
  const agencyRate = nullableRate(formData.get("agencyCommissionRate"));
  const salespersonRate = nullableRate(formData.get("salespersonCommissionRate"));

  if (!email) {
    redirect("/admin/users?error=Enter an email address.");
  }

  const errorMessage = await saveApprovedUser(
    supabase,
    email,
    displayName,
    role,
    businessIds,
    commissionType,
    agencyRate,
    salespersonRate,
  );

  if (errorMessage) {
    redirect(`/admin/users?error=${encodeURIComponent(errorMessage)}`);
  }

  revalidatePath("/admin/users");
  redirect(`/admin/users?message=${encodeURIComponent(`${displayName || email} is approved.`)}`);
}

async function updateApprovedUser(formData: FormData) {
  "use server";

  const { supabase, email: currentEmail } = await requireAdmin();
  const email = normalizeEmail(formData.get("email"));
  const displayName = normalizeText(formData.get("displayName"));
  const role = normalizeRole(formData.get("role"));
  const businessIds = businessIdsFromForm(formData);
  const commissionType = normalizeCommissionOverride(formData.get("commissionType"));
  const agencyRate = nullableRate(formData.get("agencyCommissionRate"));
  const salespersonRate = nullableRate(formData.get("salespersonCommissionRate"));

  if (email === currentEmail && role !== "admin") {
    redirect("/admin/users?error=You cannot demote your own admin account.");
  }

  const errorMessage = await saveApprovedUser(
    supabase,
    email,
    displayName,
    role,
    businessIds,
    commissionType,
    agencyRate,
    salespersonRate,
  );

  if (errorMessage) {
    redirect(`/admin/users?error=${encodeURIComponent(errorMessage)}`);
  }

  revalidatePath("/admin/users");
  redirect(`/admin/users?message=${encodeURIComponent(`${displayName || email} was updated.`)}`);
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

async function unlockWonOption(formData: FormData) {
  "use server";

  const { supabase } = await requireAdmin();
  const userEmail = normalizeEmail(formData.get("userEmail"));
  const optionId = normalizeText(formData.get("optionId"));
  const sourceId = normalizeText(formData.get("sourceId")) || CURRENT_WON_SOURCE_ID;

  if (!userEmail || !optionId) {
    redirect("/admin/users?error=Could not identify the won option to unlock.");
  }

  const errorMessage = await updateWonOptionState(supabase, userEmail, optionId, "unlock", "", sourceId);

  if (errorMessage) {
    redirect(`/admin/users?error=${encodeURIComponent(errorMessage)}`);
  }

  revalidatePath("/admin/users");
  redirect("/admin/users?message=Won option was unlocked.");
}

async function deleteWonOption(formData: FormData) {
  "use server";

  const { supabase } = await requireAdmin();
  const userEmail = normalizeEmail(formData.get("userEmail"));
  const optionId = normalizeText(formData.get("optionId"));
  const sourceId = normalizeText(formData.get("sourceId")) || CURRENT_WON_SOURCE_ID;

  if (!userEmail || !optionId) {
    redirect("/admin/users?error=Could not identify the won option to delete.");
  }

  const errorMessage = await updateWonOptionState(supabase, userEmail, optionId, "delete", "", sourceId);

  if (errorMessage) {
    redirect(`/admin/users?error=${encodeURIComponent(errorMessage)}`);
  }

  revalidatePath("/admin/users");
  redirect("/admin/users?message=Won option was deleted.");
}

async function updateWonPaymentStatus(formData: FormData) {
  "use server";

  const { supabase, email: adminEmail } = await requireAdmin();
  const userEmail = normalizeEmail(formData.get("userEmail"));
  const optionId = normalizeText(formData.get("optionId"));
  const sourceId = normalizeText(formData.get("sourceId")) || CURRENT_WON_SOURCE_ID;
  const mode = String(formData.get("paymentMode") || "");

  if (!userEmail || !optionId) {
    redirect("/admin/users?error=Could not identify the won option to update.");
  }

  if (mode !== "paid_in" && mode !== "paid_out" && mode !== "reset_payment") {
    redirect("/admin/users?error=Choose a valid payment status.");
  }

  const errorMessage = await updateWonOptionState(
    supabase,
    userEmail,
    optionId,
    mode,
    adminEmail,
    sourceId,
  );

  if (errorMessage) {
    redirect(`/admin/users?error=${encodeURIComponent(errorMessage)}`);
  }

  const message =
    mode === "paid_out"
      ? "Sale was marked as paid out."
      : mode === "paid_in"
        ? "Sale was marked as paid in."
        : "Sale payment status was reset.";

  revalidatePath("/admin/users");
  redirect(`/admin/users?message=${encodeURIComponent(message)}`);
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
  const membershipsResult = await listUserBusinessMemberships(supabase, businessResult.data);

  const businesses = businessResult.data;
  const users = applyMembershipsToUsers(usersResult.data, membershipsResult.data);
  const wonResult = await listWonOptions(supabase, users);
  const wonOptions = wonResult.data;
  const salespersonSales = summarizeSalesBySalesperson(wonOptions);
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
        {membershipsResult.errorMessage ? (
          <div className="notice">Supabase membership setup: {membershipsResult.errorMessage}</div>
        ) : null}
        {wonResult.errorMessage ? (
          <div className="notice">Won options setup: {wonResult.errorMessage}</div>
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
              <label htmlFor="businessOperatingState">Operating state</label>
              <select id="businessOperatingState" name="operatingState" defaultValue="NSW">
                {operatingStateOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
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
              <details className="business-card business-edit-card locked-card" key={business.id}>
                <summary className="business-summary">
                  <div>
                    <label>Business</label>
                    <strong>{business.name}</strong>
                  </div>
                  <div>
                    <label>State / rebate</label>
                    <strong>{business.operating_state}</strong>
                    <span>{rebateSchemeLabel(business.operating_state)}</span>
                  </div>
                  <div>
                    <label>Commission</label>
                    <strong>{commissionLabel(business.commission_type)}</strong>
                  </div>
                  <div>
                    <label>Agency / standard %</label>
                    <strong>{formatRate(business.agency_commission_rate)}%</strong>
                  </div>
                  <div>
                    <label>Salesperson %</label>
                    <strong>{formatRate(business.salesperson_commission_rate)}%</strong>
                  </div>
                  <span className="locked-pill locked-state">Locked</span>
                  <span className="locked-pill unlocked-state">Unlocked</span>
                </summary>
                <form action={upsertBusiness} className="business-edit-form">
                  <input type="hidden" name="businessId" value={business.id} />
                  <div>
                    <label>Business name</label>
                    <input name="businessName" defaultValue={business.name} required />
                  </div>
                  <div>
                    <label>Operating state</label>
                    <select name="operatingState" defaultValue={business.operating_state}>
                      {operatingStateOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {operatingStateLabel(option.value)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label>Default commission</label>
                    <select name="commissionType" defaultValue={business.commission_type}>
                      <option value="none">No commission</option>
                      <option value="standard">Standard</option>
                      <option value="agency">Agency</option>
                    </select>
                  </div>
                  <div>
                    <label>Agency / standard %</label>
                    <input
                      name="agencyCommissionRate"
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      defaultValue={formatRate(business.agency_commission_rate)}
                    />
                  </div>
                  <div>
                    <label>Salesperson %</label>
                    <input
                      name="salespersonCommissionRate"
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      defaultValue={formatRate(business.salesperson_commission_rate)}
                    />
                  </div>
                  <button className="orange" type="submit">
                    Save business
                  </button>
                </form>
              </details>
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
              <label htmlFor="displayName">Name</label>
              <input id="displayName" name="displayName" placeholder="Alex Quinn" />
            </div>
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
              <label>Businesses</label>
              <BusinessMultiSelect businesses={businesses} selectedIds={firstBusinessId ? [firstBusinessId] : []} />
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

          <div className="user-card-grid">
            {users.map((approvedUser) => {
              const isSelf = approvedUser.email.toLowerCase() === currentEmail;
              const commissionOverride = approvedUser.commission_type_override || "business_default";
              return (
                <article className="user-card" key={approvedUser.email}>
                  <div className="user-card-head">
                    <div>
                      <strong>{displayNameFor(approvedUser)}</strong>
                      {isSelf ? <span className="self-pill">You</span> : null}
                      <span className="muted-line">{approvedUser.email}</span>
                    </div>
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
                  </div>

                  <div className="user-facts">
                    <div><span>Businesses</span><strong>{approvedUser.business_names.join(", ") || approvedUser.business_name || "No business"}</strong></div>
                    <div><span>Role</span><strong>{roleOptions.find((option) => option.value === approvedUser.role)?.label || approvedUser.role}</strong></div>
                    <div><span>Commission</span><strong>{commissionLabel(approvedUser.effective_commission_type)}</strong></div>
                    <div><span>Rates</span><strong>{formatRate(approvedUser.effective_agency_commission_rate)}% / {formatRate(approvedUser.effective_salesperson_commission_rate)}%</strong></div>
                  </div>

                  <form action={updateApprovedUser} className="user-edit-grid">
                    <input type="hidden" name="email" value={approvedUser.email} />
                    {isSelf ? <input type="hidden" name="role" value={approvedUser.role} /> : null}
                    <div>
                      <label>Name</label>
                      <input name="displayName" defaultValue={approvedUser.display_name} placeholder="Name" />
                    </div>
                    <div>
                      <label>Role</label>
                      <select name="role" defaultValue={approvedUser.role} disabled={isSelf}>
                        {roleOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label>Businesses</label>
                      <BusinessMultiSelect businesses={businesses} selectedIds={approvedUser.business_ids} />
                    </div>
                    <div>
                      <label>Override</label>
                      <select name="commissionType" defaultValue={commissionOverride}>
                        {commissionOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label>Primary %</label>
                      <input
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
                    </div>
                    <div>
                      <label>Salesperson %</label>
                      <input
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
                    </div>
                    <button className="secondary" type="submit" disabled={isSelf}>
                      Save user
                    </button>
                  </form>
                </article>
              );
            })}
            {!users.length ? <div className="empty-card">No approved users found.</div> : null}
          </div>

          <div className="table-wrap legacy-users-table">
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
            <strong>Commission shown above:</strong> a user with Use business default inherits the
            selected business setup. Standard commission uses the primary percentage. Agency
            commission uses both percentages.
          </div>
        </section>

        <section className="admin-section">
          <div className="section-heading">
            <div>
              <h2>Won options</h2>
              <p>Options marked as won in each calculator, including Daniel's full commission view.</p>
            </div>
            <div className="won-toolbar">
              <button className="secondary" type="button" data-select-all-won>
                Select visible
              </button>
              <button className="orange" type="button" data-export-won-selected>
                Export selected CSV
              </button>
            </div>
          </div>

          {salespersonSales.length ? (
            <div className="sales-summary-grid">
              {salespersonSales.map((summary) => (
                <article
                  aria-pressed="false"
                  className="sales-summary-card"
                  data-salesperson-filter={summary.userEmail.toLowerCase()}
                  data-salesperson-name={summary.userName}
                  key={summary.userEmail}
                  role="button"
                  tabIndex={0}
                >
                  <div>
                    <strong>{summary.userName}</strong>
                    <span>{summary.businessNames || summary.userEmail}</span>
                  </div>
                  <div className="sales-summary-metrics">
                    <div><span>Sales</span><strong>{summary.saleCount}</strong></div>
                    <div><span>Customer total</span><strong>{formatMoney(summary.customerTotal)}</strong></div>
                    <div><span>Agency comm</span><strong>{formatMoney(summary.agencyCommissionTotal)}</strong></div>
                    <div><span>Salesperson comm</span><strong>{formatMoney(summary.salespersonCommissionTotal)}</strong></div>
                  </div>
                  <div className="sales-status-strip">
                    <span className="status-dot red">{summary.notPaidInCount} unpaid</span>
                    <span className="status-dot orange">{summary.paidInCount} paid in</span>
                    <span className="status-dot green">{summary.paidOutCount} paid out</span>
                  </div>
                </article>
              ))}
            </div>
          ) : null}

          <div className="won-filter-status" data-won-filter-status>
            Showing all {wonOptions.length} won options.
          </div>

          <div className="won-grid">
            {wonOptions.map((option) => (
              <article
                className={`won-card won-card-${option.paymentStatus}`}
                data-export-row={JSON.stringify(wonExportRow(option))}
                data-won-user-email={option.userEmail.toLowerCase()}
                key={wonOptionDomKey(option)}
              >
                <div className="won-card-head">
                  <label className="won-select">
                    <input className="won-sale-select" type="checkbox" value={wonOptionDomKey(option)} />
                    <span>Select</span>
                  </label>
                  <div className="won-title">
                    <strong>{option.optionName}</strong>
                    <span className="muted-line">
                      {option.userName} - {option.businessName} - {option.userEmail}
                    </span>
                  </div>
                  <div className="won-actions">
                    <span className={`payment-pill payment-pill-${option.paymentStatus}`}>
                      {option.paymentStatusLabel}
                    </span>
                    <span className="locked-pill">
                      {option.wonAt ? formatShortDate(option.wonAt) : "Won"}
                    </span>
                    {option.paymentStatus === "not_paid_in" ? (
                      <form action={updateWonPaymentStatus}>
                        <input type="hidden" name="userEmail" value={option.userEmail} />
                        <input type="hidden" name="sourceId" value={option.sourceId} />
                        <input type="hidden" name="optionId" value={option.optionId} />
                        <input type="hidden" name="paymentMode" value="paid_in" />
                        <button className="secondary" type="submit">
                          Mark paid in
                        </button>
                      </form>
                    ) : null}
                    {option.paymentStatus !== "paid_out" ? (
                      <form action={updateWonPaymentStatus}>
                        <input type="hidden" name="userEmail" value={option.userEmail} />
                        <input type="hidden" name="sourceId" value={option.sourceId} />
                        <input type="hidden" name="optionId" value={option.optionId} />
                        <input type="hidden" name="paymentMode" value="paid_out" />
                        <button className="secondary" type="submit">
                          Mark paid out
                        </button>
                      </form>
                    ) : null}
                    {option.paymentStatus !== "not_paid_in" ? (
                      <form action={updateWonPaymentStatus}>
                        <input type="hidden" name="userEmail" value={option.userEmail} />
                        <input type="hidden" name="sourceId" value={option.sourceId} />
                        <input type="hidden" name="optionId" value={option.optionId} />
                        <input type="hidden" name="paymentMode" value="reset_payment" />
                        <button className="secondary" type="submit">
                          Reset payment
                        </button>
                      </form>
                    ) : null}
                    <form action={unlockWonOption}>
                      <input type="hidden" name="userEmail" value={option.userEmail} />
                      <input type="hidden" name="sourceId" value={option.sourceId} />
                      <input type="hidden" name="optionId" value={option.optionId} />
                      <button className="secondary" type="submit">
                        Unlock
                      </button>
                    </form>
                    <details className="delete-confirm">
                      <summary>Delete</summary>
                      <form action={deleteWonOption}>
                        <input type="hidden" name="userEmail" value={option.userEmail} />
                        <input type="hidden" name="sourceId" value={option.sourceId} />
                        <input type="hidden" name="optionId" value={option.optionId} />
                        <button className="danger" type="submit">
                          Confirm delete
                        </button>
                      </form>
                    </details>
                  </div>
                </div>
                <div className="won-metrics">
                  <div><span>Systems</span><strong>{option.systemCount}</strong></div>
                  <div><span>Customer total</span><strong>{formatMoney(option.customerTotal)}</strong></div>
                  <div><span>Rebate</span><strong>{formatMoney(option.rebateTotal)}</strong></div>
                  <div><span>Agency comm inc</span><strong>{formatMoney(option.agencyCommissionTotal)}</strong></div>
                  <div><span>Salesperson comm inc</span><strong>{formatMoney(option.salespersonCommissionTotal)}</strong></div>
                  <div><span>Installer profit ex</span><strong>{formatMoney(option.installerProfitTotal)}</strong></div>
                  <div><span>Paid in</span><strong>{option.paidInAt ? formatShortDate(option.paidInAt) : "Not yet"}</strong></div>
                  <div><span>Paid out</span><strong>{option.paidOutAt ? formatShortDate(option.paidOutAt) : "Not yet"}</strong></div>
                </div>
                <div className="won-lines">
                  {option.rows.map((row, index) => (
                    <div className="won-line" key={`${row.label}-${index}`}>
                      <strong>{row.label}</strong>
                      <span>
                        {row.install} - {formatMoney(row.finalInc)} customer - {formatMoney(row.netProfit)} installer profit
                      </span>
                    </div>
                  ))}
                </div>
              </article>
            ))}
            {!wonOptions.length ? <div className="empty-card">No won options yet.</div> : null}
          </div>
        </section>
      </section>
      <Script id="admin-users-page-actions" strategy="afterInteractive">
        {`${businessMultiSelectScript()}\n${wonExportScript()}`}
      </Script>
    </main>
  );
}
