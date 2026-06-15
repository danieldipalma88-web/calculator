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
      .select("user_id")
      .eq("email", viewingEmail)
      .maybeSingle();

    if (!existingData?.user_id) {
      return NextResponse.json(
        { error: "That user has not opened the calculator yet, so there is no saved calculator profile to update." },
        { status: 404 },
      );
    }

    const { error } = await supabase
      .from("user_calculator_data")
      .update({
        data: calculatorData,
        updated_at: new Date().toISOString(),
      })
      .eq("email", viewingEmail);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  }

  const { error } = await supabase.from("user_calculator_data").upsert({
    user_id: user.id,
    email: currentEmail,
    data: calculatorData,
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
