import { NextResponse } from "next/server";
import { canManageUsers, isOwnerEmail } from "../../../lib/admin";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

const CERTIFICATE_VALUE_STORAGE_KEYS = [
  "installerCertificateValuesV1",
  "CertificateValuesV1",
];

const ESS_SETTINGS_STORAGE_KEYS = [
  "installerEssSettingsV1",
  "EssSettingsV1",
];

const MANAGED_PRICE_STORAGE_KEYS = [
  "installerManagedPricesV1",
  "ManagedPricesV1",
];

async function currentApprovedUser(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  email: string,
) {
  const { data } = await supabase
    .from("approved_users")
    .select("role")
    .eq("email", email)
    .maybeSingle();
  return data as { role?: string } | null;
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

function stripCertificateRatesFromEssSettings(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return value;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return value;
    delete parsed.escRate;
    delete parsed.prcRate;
    return JSON.stringify(parsed);
  } catch {
    return value;
  }
}

function sanitizeIncomingCalculatorData(
  incoming: unknown,
  canEditCertificateValues: boolean,
) {
  const sanitized: Record<string, unknown> =
    incoming && typeof incoming === "object" ? { ...(incoming as Record<string, unknown>) } : {};

  if (canEditCertificateValues) return sanitized;

  for (const key of CERTIFICATE_VALUE_STORAGE_KEYS) {
    delete sanitized[key];
  }

  for (const key of ESS_SETTINGS_STORAGE_KEYS) {
    if (key in sanitized) {
      sanitized[key] = stripCertificateRatesFromEssSettings(sanitized[key]);
    }
  }

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
  const viewingEmail = targetEmailFromRequest(
    request,
    currentEmail,
    canManageUsers(currentEmail, approvedUser?.role),
  );
  const byEmail = await supabase
    .from("user_calculator_data")
    .select("data")
    .eq("email", viewingEmail)
    .maybeSingle();

  if (byEmail.error) {
    return NextResponse.json({ error: byEmail.error.message }, { status: 500 });
  }

  if (byEmail.data?.data) {
    return NextResponse.json({ data: byEmail.data.data || {} });
  }

  if (viewingEmail === currentEmail) {
    const { data, error } = await supabase
      .from("user_calculator_data")
      .select("data")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data: data?.data || {} });
  }

  return NextResponse.json({ data: {} });
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
  const viewingEmail = targetEmailFromRequest(
    request,
    currentEmail,
    canManageUsers(currentEmail, approvedUser?.role),
  );
  const canEditCertificateValues = isOwnerEmail(currentEmail) && isOwnerEmail(viewingEmail);
  const calculatorData = sanitizeIncomingCalculatorData(
    rawCalculatorData,
    canEditCertificateValues,
  );
  const incomingHasData = calculatorDataHasData(calculatorData);

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

    const mergedData = mergeCalculatorData(existingData.data, calculatorData);

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

  const mergedData = mergeCalculatorData(existingData?.data, calculatorData);

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
