import { timingSafeEqual } from "node:crypto";
import { after, NextResponse } from "next/server";
import { modelAutomationEnabled, processModelRequest } from "../../../../lib/model-request-worker";
import { researchAutomationEnabled, researchHealth } from "../../../../lib/model-request-research";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

function authorized(request: Request) {
  const secret = process.env.MODEL_REQUEST_WORKER_SECRET || "";
  const expected = `Bearer ${secret}`;
  const actual = request.headers.get("authorization") || "";
  return secret.length >= 40 && Buffer.byteLength(actual) === Buffer.byteLength(expected)
    && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(request: Request) {
  if (!authorized(request)) return json({ error: "Unauthorized" }, 401);
  return json(await researchHealth());
}

export async function POST(request: Request) {
  if (!authorized(request)) return json({ error: "Unauthorized" }, 401);
  if (!modelAutomationEnabled() || !researchAutomationEnabled()) return json({ enabled: false }, 409);
  if (Number(request.headers.get("content-length") || 0) > 1024) return json({ error: "Invalid continuation" }, 400);
  const body = await request.json().catch(() => null);
  if (!body || Object.keys(body).length !== 1 || typeof body.jobId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.jobId)) {
    return json({ error: "Invalid continuation" }, 400);
  }
  after(async () => {
    try { await processModelRequest(undefined, body.jobId); }
    catch { console.error("[model-research] continuation deferred to durable recovery"); }
  });
  return json({ accepted: true }, 202);
}
