import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { maintainModelRequestContacts, modelAutomationEnabled, processModelRequest, processModelRequestContact } from "../../../../lib/model-request-worker";
import { researchAutomationEnabled } from "../../../../lib/model-request-research";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  const expected = `Bearer ${process.env.CRON_SECRET || ""}`;
  const actual = request.headers.get("authorization") || "";
  if (!process.env.CRON_SECRET || Buffer.byteLength(actual) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!modelAutomationEnabled()) return NextResponse.json({ enabled: false });
  const results = [];
  const started = Date.now();
  let failed = false;
  // Bounded backstop. Normal new submissions run immediately after their response.
  try {
    while (results.length < (researchAutomationEnabled() ? 1 : 3) && Date.now() - started < 120_000) {
      const result = await processModelRequest();
      if (!result.processed) break;
      results.push(result);
    }
  } catch { failed = true; console.error("[model-request-cron] verification pass failed"); }
  try { await maintainModelRequestContacts(); }
  catch { failed = true; console.error("[model-request-cron] contact maintenance failed"); }
  let contactProcessed = 0;
  try {
    while (contactProcessed < 12 && Date.now() - started < 235_000 && await processModelRequestContact()) contactProcessed += 1;
  } catch { failed = true; console.error("[model-request-cron] contact delivery pass failed"); }
  return NextResponse.json({ processed: results.length, contactProcessed }, { status: failed ? 503 : 200, headers: { "Cache-Control": "no-store" } });
}
