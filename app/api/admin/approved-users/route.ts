import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { canManageUsers, isOwnerEmail } from "../../../../lib/admin";
import { getApprovedCalculatorSession } from "../../../../lib/supabase/approved-calculator-session";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

async function handleRequest(request: Request, remove: boolean) {
  if (remove && (request.headers.get("origin") !== new URL(request.url).origin
    || ![null, "same-origin"].includes(request.headers.get("sec-fetch-site")))) {
    return json({ error: "Same-origin request required." }, 403);
  }
  const access = await getApprovedCalculatorSession();
  if (access.status !== 200) return json({ error: access.error }, access.status);
  const { supabase, email: currentEmail, approvedUser } = access.session;
  if (!canManageUsers(currentEmail, approvedUser.role)) return json({ error: "Not authorized." }, 403);

  const body = remove ? await request.json().catch(() => null) : null;
  const email = String(remove ? body?.email || "" : new URL(request.url).searchParams.get("email") || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return json({ error: "A valid user email is required." }, 400);
  }
  if (remove && (email === currentEmail || isOwnerEmail(email))) {
    return json({ error: "You cannot remove this admin account." }, 403);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  const emailFilter = (value: string) => `email.ilike.${JSON.stringify(value.replace(/[\\%_]/g, "\\$&"))}`;
  async function currentTargets() {
    // Read actor and target in one snapshot: RLS-hidden rows are not proof of removal.
    // PostgREST '*' may broaden this read; exact identities and row count are checked below.
    const result = await supabase.from("approved_users").select("email, role, is_locked", { count: "exact" })
      .or([emailFilter(currentEmail), emailFilter(email)].join(",")).limit(1000).abortSignal(controller.signal);
    if (result.error || !Array.isArray(result.data) || result.count !== result.data.length
      || result.data.some((row) => typeof row.email !== "string" || typeof row.role !== "string" || typeof row.is_locked !== "boolean")) {
      throw new Error("Access could not be confirmed");
    }
    const actors = result.data.filter((row) => row.email.toLowerCase() === currentEmail);
    if (actors.length !== 1 || actors[0].is_locked || !canManageUsers(currentEmail, actors[0].role)) {
      throw new Error("Admin access is no longer available");
    }
    return result.data.filter((row) => row.email.toLowerCase() === email);
  }
  try {
    if (remove) {
      const result = await supabase.rpc("admin_delete_approved_user", { target_email: email }).abortSignal(controller.signal);
      if (result.error) {
        const message = String(result.error.message || "").toLowerCase();
        if (!(message.includes("schema cache") && message.includes("function"))) {
          return json({ error: "Removal could not be confirmed. Check the user's current access before trying again." }, 503);
        }
        const targets = await currentTargets();
        if (targets.length > 1) throw new Error("Ambiguous user identity");
        if (targets.length === 1) {
          const fallback = await supabase.from("approved_users").delete().eq("email", targets[0].email).abortSignal(controller.signal);
          if (fallback.error) throw new Error("Removal could not be confirmed");
        }
      }
    }
    const removed = (await currentTargets()).length === 0;
    if (remove && !removed) return json({ error: "This user still has calculator access. No removal was confirmed." }, 409);
    if (remove) revalidatePath("/admin/users");
    return json({ ok: true, email, removed });
  } catch {
    return json({ error: "The user's current access could not be confirmed. Please check again." }, 503);
  } finally {
    clearTimeout(timer);
  }
}

export async function DELETE(request: Request) { return handleRequest(request, true); }
export async function GET(request: Request) { return handleRequest(request, false); }
