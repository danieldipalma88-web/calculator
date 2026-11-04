import { after, NextResponse } from "next/server";
import { getApprovedCalculatorSession } from "../../../../lib/supabase/approved-calculator-session";
import { processModelRequest } from "../../../../lib/model-request-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function validId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function GET(request: Request) {
  const approval = await getApprovedCalculatorSession();
  if (approval.status !== 200) return json({ error: approval.error }, approval.status);
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!validId(id)) return json({ error: "This model request could not be found." }, 404);

  const { data, error } = await approval.session.supabase.rpc("model_request_self", {
    p_id: id,
    p_response: null,
  });
  if (error || !data) return json({ error: "This model request could not be found." }, 404);
  return json(data);
}

type ResponseBody = {
  id?: unknown;
  round?: unknown;
  model?: unknown;
  postcode?: unknown;
  install_type?: unknown;
  message?: unknown;
  help?: unknown;
};

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    return json({ error: "This request could not be verified. Refresh and try again." }, 403);
  }

  const approval = await getApprovedCalculatorSession();
  if (approval.status !== 200) return json({ error: approval.error }, approval.status);
  const body = (await request.json().catch(() => null)) as ResponseBody | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Enter your response and try again." }, 400);
  }

  const stringField = (value: unknown, max: number) => {
    if (value === undefined) return { value: "", valid: true };
    if (typeof value !== "string" || value.length > max) return { value: "", valid: false };
    return { value: value.trim(), valid: true };
  };
  const id = typeof body.id === "string" ? body.id : "";
  const model = stringField(body.model, 180);
  const postcode = stringField(body.postcode, 4);
  const installType = stringField(body.install_type, 20);
  const message = stringField(body.message, 1000);
  if (!validId(id)) return json({ error: "This model request could not be found." }, 404);
  if (typeof body.round !== "number" || !Number.isSafeInteger(body.round) || body.round < 1 || body.round > 3) {
    return json({ error: "This request has changed. Reload the page and try again." }, 409);
  }
  if (!model.valid || !postcode.valid || !installType.valid || !message.valid || (body.help !== undefined && typeof body.help !== "boolean")) {
    return json({ error: "One or more response fields are invalid." }, 400);
  }
  if (postcode.value && (!/^\d{4}$/.test(postcode.value) || postcode.value === "0000")) {
    return json({ error: "Enter a four-digit postcode." }, 400);
  }
  if (installType.value && !["new", "replacement"].includes(installType.value)) {
    return json({ error: "Choose new or replacement." }, 400);
  }

  const { data, error } = await approval.session.supabase.rpc("model_request_self", {
    p_id: id,
    p_response: {
      round: body.round,
      model: model.value,
      postcode: postcode.value,
      install_type: installType.value,
      message: message.value,
      help: body.help === true,
    },
  });
  if (error) return json({ error: error.message.startsWith("Add the requested information")
    ? "Enter the requested details in the model or installation fields, or select the human-help option."
    : "This request could not be updated. Reload the page and try again." }, 409);
  if (!data) return json({ error: "This model request could not be found." }, 404);

  const state = typeof data === "object" && data ? (data as { state?: unknown }).state : undefined;
  if (state === "queued" || state === "escalated") {
    after(async () => {
      try {
        await processModelRequest(id);
      } catch (workerError) {
        console.error("[model-request-response] processing deferred", {
          requestId: id,
          error: workerError instanceof Error ? workerError.message : "Worker unavailable",
        });
      }
    });
  }
  return json(data);
}
