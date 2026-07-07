import { NextResponse } from "next/server";
import { canManageUsers, isOwnerEmail } from "../../../lib/admin";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

const MANAGED_PRICE_STORAGE_KEYS = [
  "installerManagedPricesV1",
  "ManagedPricesV1",
];

const CERTIFICATE_VALUE_STORAGE_KEYS = [
  "installerCertificateValuesV1",
  "greenEnergyCertificateValuesV1",
  "CertificateValuesV1",
];

const BUSINESS_SHARED_STORAGE_KEYS = new Set([
  "installerManagedPricesV1",
  "greenEnergyManagedPricesV1",
  "ManagedPricesV1",
  "installerDefaultCostRulesV1",
  "greenEnergyDefaultCostRulesV1",
  "DefaultCostRulesV1",
]);

async function currentApprovedUser(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  email: string,
) {
  const { data } = await supabase
    .from("approved_users")
    .select("role, business_id")
    .eq("email", email)
    .maybeSingle();
  return data as { role?: string; business_id?: string | null } | null;
}

function targetEmailFromRequest(request: Request, currentEmail: string, canManage: boolean) {
  const { searchParams } = new URL(request.url);
  const targetEmail = String(searchParams.get("as") || "").trim().toLowerCase();
  return canManage && targetEmail ? targetEmail : currentEmail;
}

function storedValueHasData(value: unknown) {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.length > 0;
    if (parsed && typeof parsed === "object") return Object.keys(parsed).length > 0;
    return parsed !== null && parsed !== "";
  } catch {
    return true;
  }
}

function calculatorDataHasData(data: unknown) {
  if (!data || typeof data !== "object") return false;
  return Object.entries(data as Record<string, unknown>).some(([key, value]) => {
    return key && !key.startsWith("sb-") && key !== "__calculatorProfileEmail" && storedValueHasData(value);
  });
}

function mergeCalculatorData(existing: unknown, incoming: unknown) {
  const merged: Record<string, unknown> =
    existing && typeof existing === "object" ? { ...(existing as Record<string, unknown>) } : {};
  if (!incoming || typeof incoming !== "object") return merged;

  for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
    const existingHasData = storedValueHasData(merged[key]);
    const incomingHasData = storedValueHasData(value);
    if (!incomingHasData && existingHasData) continue;
    merged[key] = value;
  }

  return merged;
}

function splitCalculatorDataByScope(data: Record<string, unknown>) {
  const userData: Record<string, unknown> = {};
  const businessData: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (BUSINESS_SHARED_STORAGE_KEYS.has(key)) businessData[key] = value;
    else userData[key] = value;
  }

  return { userData, businessData };
}

function stripCertificateValueKeys(data: Record<string, unknown>) {
  const output = { ...data };
  CERTIFICATE_VALUE_STORAGE_KEYS.forEach((key) => {
    delete output[key];
  });
  return output;
}

async function businessIdsForEmail(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  email: string,
  fallbackBusinessId?: string | null,
) {
  const ids = new Set<string>();
  if (fallbackBusinessId) ids.add(fallbackBusinessId);

  const memberships = await supabase
    .from("approved_user_businesses")
    .select("business_id")
    .eq("email", email);

  if (!memberships.error) {
    (memberships.data || []).forEach((row: { business_id?: string | null }) => {
      if (row.business_id) ids.add(row.business_id);
    });
  }

  return [...ids];
}

async function resolveBusinessId(
  request: Request,
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  viewingEmail: string,
  canManage: boolean,
) {
  const { searchParams } = new URL(request.url);
  const requestedBusinessId = String(searchParams.get("businessId") || "").trim();
  if (!requestedBusinessId) return null;
  if (canManage) return requestedBusinessId;

  const approvedUser = await currentApprovedUser(supabase, viewingEmail);
  const businessIds = await businessIdsForEmail(supabase, viewingEmail, approvedUser?.business_id);
  return businessIds.includes(requestedBusinessId) ? requestedBusinessId : null;
}

function sanitizeIncomingCalculatorData(
  incoming: unknown,
  canEditManagedRebates: boolean,
) {
  const sanitized: Record<string, unknown> =
    incoming && typeof incoming === "object" ? { ...(incoming as Record<string, unknown>) } : {};

  if (canEditManagedRebates) return sanitized;

  for (const key of MANAGED_PRICE_STORAGE_KEYS) {
    if (key in sanitized) {
      sanitized[key] = stripManagedRebateOverrides(sanitized[key]);
    }
  }

  return sanitized;
}

function stripManagedRebateOverrides(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return value;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return value;
    for (const entry of Object.values(parsed as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      delete (entry as Record<string, unknown>).rebate;
      delete (entry as Record<string, unknown>).rebateManual;
    }
    return JSON.stringify(parsed);
  } catch {
    return value;
  }
}

export async function GET(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const currentEmail = String(user.email || "").toLowerCase();
  const approvedUser = await currentApprovedUser(supabase, currentEmail);
  const canManage = canManageUsers(currentEmail, approvedUser?.role);
  const viewingEmail = targetEmailFromRequest(
    request,
    currentEmail,
    canManage,
  );
  const businessId = await resolveBusinessId(request, supabase, viewingEmail, canManage);
  const byEmail = await supabase
    .from("user_calculator_data")
    .select("data")
    .eq("email", viewingEmail)
    .maybeSingle();

  if (byEmail.error) {
    return NextResponse.json({ error: byEmail.error.message }, { status: 500 });
  }

  let userData: Record<string, unknown> = (byEmail.data?.data || {}) as Record<string, unknown>;

  if (viewingEmail === currentEmail) {
    const { data, error } = await supabase
      .from("user_calculator_data")
      .select("data")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!byEmail.data?.data) userData = (data?.data || {}) as Record<string, unknown>;
  }

  let businessData: Record<string, unknown> = {};
  if (businessId) {
    const businessResult = await supabase
      .from("business_calculator_data")
      .select("data")
      .eq("business_id", businessId)
      .maybeSingle();

    if (!businessResult.error) {
      businessData = (businessResult.data?.data || {}) as Record<string, unknown>;
    }
  }

  return NextResponse.json({ data: { ...stripCertificateValueKeys(userData), ...businessData } });
}

async function saveCalculatorData(request: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const rawCalculatorData = body && typeof body.data === "object" ? body.data : {};
  const currentEmail = String(user.email || "").toLowerCase();
  const approvedUser = await currentApprovedUser(supabase, currentEmail);
  const canManage = canManageUsers(currentEmail, approvedUser?.role);
  const viewingEmail = targetEmailFromRequest(
    request,
    currentEmail,
    canManage,
  );
  const businessId = await resolveBusinessId(request, supabase, viewingEmail, canManage);
  const canEditManagedRebates = isOwnerEmail(viewingEmail);
  const calculatorData = sanitizeIncomingCalculatorData(
    rawCalculatorData,
    canEditManagedRebates,
  );
  const { userData, businessData } = splitCalculatorDataByScope(stripCertificateValueKeys(calculatorData));
  const incomingHasData = calculatorDataHasData(userData);
  const incomingBusinessHasData = calculatorDataHasData(businessData);

  if (businessId && incomingBusinessHasData) {
    const existingBusiness = await supabase
      .from("business_calculator_data")
      .select("data")
      .eq("business_id", businessId)
      .maybeSingle();

    const mergedBusinessData = mergeCalculatorData(existingBusiness.data?.data, businessData);
    const businessSave = await supabase.from("business_calculator_data").upsert({
      business_id: businessId,
      data: mergedBusinessData,
      updated_at: new Date().toISOString(),
    });

    if (businessSave.error) {
      return NextResponse.json({ error: businessSave.error.message }, { status: 500 });
    }
  }

  if (viewingEmail !== currentEmail) {
    const { data: existingData } = await supabase
      .from("user_calculator_data")
      .select("user_id, data")
      .eq("email", viewingEmail)
      .maybeSingle();

    if (!existingData?.user_id) {
      return NextResponse.json(
        { error: "That user has not opened the calculator yet, so there is no saved calculator profile to update." },
        { status: 404 },
      );
    }

    if (!incomingHasData && calculatorDataHasData(existingData.data)) {
      return NextResponse.json({ ok: true, skipped: "empty_snapshot_ignored" });
    }

    const mergedData = mergeCalculatorData(existingData.data, userData);

    const { error } = await supabase
      .from("user_calculator_data")
      .update({
        data: mergedData,
        updated_at: new Date().toISOString(),
      })
      .eq("email", viewingEmail);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  }

  let { data: existingData } = await supabase
    .from("user_calculator_data")
    .select("user_id, data")
    .eq("email", currentEmail)
    .maybeSingle();

  if (!existingData) {
    const fallback = await supabase
      .from("user_calculator_data")
      .select("user_id, data")
      .eq("user_id", user.id)
      .maybeSingle();
    existingData = fallback.data;
  }

  if (!incomingHasData && calculatorDataHasData(existingData?.data)) {
    return NextResponse.json({ ok: true, skipped: "empty_snapshot_ignored" });
  }

  const mergedData = mergeCalculatorData(existingData?.data, userData);

  const { error } = existingData?.user_id
    ? await supabase
        .from("user_calculator_data")
        .update({
          email: currentEmail,
          data: mergedData,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", existingData.user_id)
    : await supabase.from("user_calculator_data").upsert({
        user_id: user.id,
        email: currentEmail,
        data: mergedData,
        updated_at: new Date().toISOString(),
      });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export async function PUT(request: Request) {
  return saveCalculatorData(request);
}

export async function POST(request: Request) {
  return saveCalculatorData(request);
}
