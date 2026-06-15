import { NextResponse } from "next/server";
import { canManageUsers } from "../../../lib/admin";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

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
  const query = supabase.from("user_calculator_data").select("data");
  const { data, error } =
    viewingEmail === currentEmail
      ? await query.eq("user_id", user.id).maybeSingle()
      : await query.eq("email", viewingEmail).maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ data: data?.data || {} });
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
  const calculatorData = body && typeof body.data === "object" ? body.data : {};
  const incomingHasData = calculatorDataHasData(calculatorData);
  const currentEmail = String(user.email || "").toLowerCase();
  const approvedUser = await currentApprovedUser(supabase, currentEmail);
  const viewingEmail = targetEmailFromRequest(
    request,
    currentEmail,
    canManageUsers(currentEmail, approvedUser?.role),
  );

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

  const { data: existingData } = await supabase
    .from("user_calculator_data")
    .select("data")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!incomingHasData && calculatorDataHasData(existingData?.data)) {
    return NextResponse.json({ ok: true, skipped: "empty_snapshot_ignored" });
  }

  const mergedData = mergeCalculatorData(existingData?.data, calculatorData);

  const { error } = await supabase.from("user_calculator_data").upsert({
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
