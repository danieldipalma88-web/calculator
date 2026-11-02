import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { modelAutomationEnabled, processModelRequest } from "../../../../lib/model-request-worker";

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
  // Bounded backstop. Normal new submissions run immediately after their response.
  while (results.length < 3 && Date.now() - started < 120_000) {
    const result = await processModelRequest();
    if (!result.processed) break;
    results.push(result);
  }
  return NextResponse.json({ processed: results.length, results }, { headers: { "Cache-Control": "no-store" } });
}
