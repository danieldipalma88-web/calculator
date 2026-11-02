const SENDER_ADDRESS = "notifications@mail.rebateportal.com.au";
const SENDER = `Rebate Portal <${SENDER_ADDRESS}>`;
const REPLY_TO = "danieldipalma88@gmail.com";
const CALCULATOR_URL = "https://calculator.rebateportal.com.au/calculator";
const SEND_TIMEOUT_MS = 10_000;

export type ModelRequestEmailInput = {
  requestId: string;
  brand: string;
  model: string;
  systemType: string;
  existing: boolean;
};

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function buildModelRequestEmail({ requestId, brand, model, systemType, existing }: ModelRequestEmailInput) {
  const subject = existing ? "Rebate Portal: Model already in the calculator" : "Rebate Portal: Requested model added";
  const status = existing
    ? "The requested model is already in the Rebate Portal calculator catalogue."
    : "The requested model has been added to the Rebate Portal calculator catalogue.";
  const product = `${brand} ${model} (${systemType})`;
  const pricing = existing
    ? "If the equipment price is still $0, a business admin must set a catalogue price for the model to appear for salespeople."
    : "The model was added with a $0 equipment price. A business admin must set a catalogue price for the model to appear for salespeople.";
  const quotePricing = "If you already have access to the model, you can enter the equipment price directly in the calculator before quoting without saving it to the catalogue.";
  const section = systemType.toLowerCase() === "ducted" ? "Ducted System"
    : systemType.toLowerCase() === "split" ? "Split System" : "relevant system";
  const directions = `Refresh the calculator page, then select the ${section} section and choose ${brand}. You do not need to sign out.`;
  const details = [pricing, quotePricing, directions];
  if (!existing) details.push("Warranty and WiFi details have not been confirmed.");
  const reference = `Request reference: ${requestId}`;

  return {
    subject,
    html: `<!doctype html><html lang="en"><body style="margin:0;background:#f3f6f8;color:#0f172a;font-family:Arial,sans-serif">
<div style="max-width:600px;margin:auto;padding:24px"><div style="background:#fff;border:1px solid #dbe4ec">
<h1 style="margin:0;padding:20px 24px;background:#0f766e;color:#fff;font-size:22px">Rebate Portal</h1>
<div style="padding:12px 24px;line-height:1.5">
<p>${escapeHtml(status)}</p><p><strong>${escapeHtml(product)}</strong></p>
${details.map((detail) => `<p>${escapeHtml(detail)}</p>`).join("")}
<p><a href="${CALCULATOR_URL}" style="color:#0f766e">Open the calculator</a></p>
<p>${escapeHtml(reference)}</p></div></div></div></body></html>`,
    text: ["Rebate Portal", status, product, ...details, `Open the calculator: ${CALCULATOR_URL}`, reference].join("\n\n"),
  };
}

// The caller must confirm publication and persist the provider message ID.
export async function sendModelRequestConfirmation(input: ModelRequestEmailInput & { recipient: string }) {
  const from = process.env.MODEL_REQUEST_FROM_EMAIL?.trim();
  if (from !== SENDER_ADDRESS && from !== SENDER) {
    throw new Error(`MODEL_REQUEST_FROM_EMAIL must use ${SENDER_ADDRESS}`);
  }
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)) {
    throw new Error("Model request completion requires a request UUID");
  }
  const recipient = input.recipient.trim();
  if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(recipient)) {
    throw new Error("Model request completion requires a single recipient email address");
  }

  const requestId = input.requestId.toLowerCase();
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `model-request-completion/${requestId}`,
    },
    body: JSON.stringify({
      ...buildModelRequestEmail({ ...input, requestId }),
      from: SENDER,
      to: [recipient],
      reply_to: REPLY_TO,
    }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Resend returned HTTP ${response.status}`);
  const result = (await response.json()) as { id?: unknown } | null;
  if (typeof result?.id !== "string" || !result.id.trim()) throw new Error("Resend did not return a message ID");
  return result.id;
}
