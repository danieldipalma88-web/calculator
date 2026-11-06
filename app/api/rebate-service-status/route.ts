import { NextResponse } from "next/server";
import { readRebateServiceStatus } from "../../../lib/rebate-service-status";
import { getApprovedCalculatorSession } from "../../../lib/supabase/approved-calculator-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function GET() {
  const headers = { "Cache-Control": "private, no-store" };
  const approval = await getApprovedCalculatorSession();
  if (approval.status !== 200) {
    return NextResponse.json({ error: approval.error }, { status: approval.status, headers });
  }
  return NextResponse.json(await readRebateServiceStatus(), {
    headers,
  });
}
