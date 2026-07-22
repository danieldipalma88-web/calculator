import { NextResponse } from "next/server";
import { canManageUsers, isOwnerEmail } from "../../../lib/admin";
import { mergeCalculatorData } from "../../../lib/quote-sync";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

const MANAGED_PRICE_STORAGE_KEYS = [
  "installerManagedPricesV1",
  "greenEnergyManagedPricesV1",
  "ManagedPricesV1",
];

const CERTIFICATE_VALUE_STORAGE_KEYS = [
  "installerCertificateValuesV1",
  "greenEnergyCertificateValuesV1",
  "CertificateValuesV1",
];

const WON_OPTION_ADMIN_STATE_STORAGE_KEYS = [
  "installerWonOptionAdminStateV1",
  "greenEnergyWonOptionAdminStateV1",
  "WonOptionAdminStateV1",
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
  const upgraded = await supabase
    .from("approved_users")
    .select("role, business_id, is_locked")
    .eq("email", email)
    .maybeSingle();
  if (!upgraded.error) {
    return upgraded.data as { role?: string; business_id?: string | null; is_locked?: boolean } | null;
  }
  const { data } = await supabase
    .from("approved_users")
    .select("role, business_id")
    .eq("email", email)
    .maybeSingle();
  return data as { role?: string; business_id?: string | null; is_locked?: boolean } | null;
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
  [...CERTIFICATE_VALUE_STORAGE_KEYS, ...WON_OPTION_ADMIN_STATE_STORAGE_KEYS].forEach((key) => {
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

function parseManagedPriceMap(value: unknown) {
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function serializeManagedPriceMap(original: unknown, value: Record<string, unknown>) {
  return typeof original === "string" || original === undefined ? JSON.stringify(value) : value;
}

function normalizeManagedLookup(value: unknown) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function managedEntryHasTrustedRebate(entry: unknown) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const rebateManual = (entry as Record<string, unknown>).rebateManual === true;
  const rebate = Number((entry as Record<string, unknown>).rebate);
  return rebateManual || (Number.isFinite(rebate) && Math.abs(rebate) > 0.0001);
}

function managedEntryModelKey(entry: unknown) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "";
  return normalizeManagedLookup((entry as Record<string, unknown>).model);
}

function managedRebateSource(
  entryKey: string,
  entry: unknown,
  existingMaps: Record<string, unknown>[],
) {
  for (const map of existingMaps) {
    const source = map[entryKey];
    if (managedEntryHasTrustedRebate(source)) return source as Record<string, unknown>;
  }

  const modelKey = managedEntryModelKey(entry);
  if (!modelKey) return null;

  for (const map of existingMaps) {
    for (const source of Object.values(map)) {
      if (managedEntryModelKey(source) === modelKey && managedEntryHasTrustedRebate(source)) {
        return source as Record<string, unknown>;
      }
    }
  }

  return null;
}

function preserveManagedRebateFields(
  existingValue: unknown,
  incomingValue: unknown,
  fallbackExistingValues: unknown[] = [],
) {
  const existingMaps = [
    parseManagedPriceMap(existingValue),
    ...fallbackExistingValues.map(parseManagedPriceMap),
  ];
  const incoming = parseManagedPriceMap(incomingValue);

  for (const [key, entry] of Object.entries(incoming)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const outputEntry = entry as Record<string, unknown>;
    const sourceEntry = managedRebateSource(key, outputEntry, existingMaps);
    if (!sourceEntry) continue;
    if (!("rebate" in outputEntry) && "rebate" in sourceEntry) outputEntry.rebate = sourceEntry.rebate;
    if (!("rebateManual" in outputEntry) && "rebateManual" in sourceEntry) outputEntry.rebateManual = sourceEntry.rebateManual;
  }

  return serializeManagedPriceMap(incomingValue, incoming);
}

function preserveBusinessManagedRebates(
  existing: unknown,
  incoming: Record<string, unknown>,
) {
  const existingData =
    existing && typeof existing === "object" ? (existing as Record<string, unknown>) : {};
  const output = { ...incoming };

  for (const key of MANAGED_PRICE_STORAGE_KEYS) {
    if (key in output) {
      const fallbackExistingValues = MANAGED_PRICE_STORAGE_KEYS
        .filter((candidate) => candidate !== key)
        .map((candidate) => existingData[candidate]);
      output[key] = preserveManagedRebateFields(existingData[key], output[key], fallbackExistingValues);
    }
  }

  return output;
}

type ExistingCalculatorData = {
  user_id: string;
  data: unknown;
  updated_at: string | null;
};

async function saveMergedUserData(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  targetEmail: string,
  authenticatedUserId: string,
  incomingData: Record<string, unknown>,
  requireExistingProfile: boolean,
) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const byEmail = await supabase
      .from("user_calculator_data")
      .select("user_id, data, updated_at")
      .eq("email", targetEmail)
      .maybeSingle();

    if (byEmail.error) return { error: byEmail.error.message, status: 500 };

    let existing = byEmail.data as ExistingCalculatorData | null;
    if (!existing && !requireExistingProfile) {
      const byUserId = await supabase
        .from("user_calculator_data")
        .select("user_id, data, updated_at")
        .eq("user_id", authenticatedUserId)
        .maybeSingle();
      if (byUserId.error) return { error: byUserId.error.message, status: 500 };
      existing = byUserId.data as ExistingCalculatorData | null;
    }

    if (!existing) {
      if (requireExistingProfile) {
        return {
          error: "That user has not opened the calculator yet, so there is no saved calculator profile to update.",
          status: 404,
        };
      }

      const inserted = await supabase.from("user_calculator_data").upsert({
        user_id: authenticatedUserId,
        email: targetEmail,
        data: incomingData,
        updated_at: new Date().toISOString(),
      });
      if (!inserted.error) return { ok: true };
      continue;
    }

    if (!calculatorDataHasData(incomingData) && calculatorDataHasData(existing.data)) {
      return { ok: true, skipped: "empty_snapshot_ignored" };
    }

    const nextUpdatedAt = new Date().toISOString();
    let update = supabase
      .from("user_calculator_data")
      .update({
        email: targetEmail,
        data: mergeCalculatorData(existing.data, incomingData),
        updated_at: nextUpdatedAt,
      })
      .eq("user_id", existing.user_id);
    update = existing.updated_at
      ? update.eq("updated_at", existing.updated_at)
      : update.is("updated_at", null);
    const saved = await update.select("user_id");

    if (saved.error) return { error: saved.error.message, status: 500 };
    if (saved.data?.length) return { ok: true };
  }

  return {
    error: "Calculator data changed during save. Please retry.",
    status: 409,
  };
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
  if (approvedUser?.is_locked) {
    return NextResponse.json({ error: "Account locked" }, { status: 403 });
  }
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
  if (approvedUser?.is_locked) {
    return NextResponse.json({ error: "Account locked" }, { status: 403 });
  }
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
  const incomingBusinessHasData = calculatorDataHasData(businessData);

  if (businessId && incomingBusinessHasData) {
    const existingBusiness = await supabase
      .from("business_calculator_data")
      .select("data")
      .eq("business_id", businessId)
      .maybeSingle();

    const safeBusinessData = canEditManagedRebates
      ? businessData
      : preserveBusinessManagedRebates(existingBusiness.data?.data, businessData);
    const mergedBusinessData = mergeCalculatorData(existingBusiness.data?.data, safeBusinessData);
    const businessSave = await supabase.from("business_calculator_data").upsert({
      business_id: businessId,
      data: mergedBusinessData,
      updated_at: new Date().toISOString(),
    });

    if (businessSave.error) {
      return NextResponse.json({ error: businessSave.error.message }, { status: 500 });
    }
  }

  const userSave = await saveMergedUserData(
    supabase,
    viewingEmail,
    user.id,
    userData,
    viewingEmail !== currentEmail,
  );
  if ("error" in userSave) {
    return NextResponse.json({ error: userSave.error }, { status: userSave.status });
  }
  return NextResponse.json(userSave);
}

export async function PUT(request: Request) {
  return saveCalculatorData(request);
}

export async function POST(request: Request) {
  return saveCalculatorData(request);
}
