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
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)) {
    throw new Error("Model request completion requires a request UUID");
  }
  const requestId = input.requestId.toLowerCase();
  return sendModelRequestMail(input.recipient, `model-request-completion/${requestId}`, {
    ...buildModelRequestEmail({ ...input, requestId }), reply_to: REPLY_TO,
  });
}

export type ModelRequestContactMail = {
  mail_key: string;
  request_id: string | null;
  kind: "question" | "reminder" | "escalation" | "weekly" | "no_rebate";
  recipient: string;
  payload: Record<string, unknown>;
  lease: string;
  state: "sending" | "failed";
};

export async function sendModelRequestContact(mail: ModelRequestContactMail) {
  const payload = mail.payload;
  const label = (key: string) => String(payload[key] ?? "").trim();
  const lines = (key: string) => Array.isArray(payload[key]) ? (payload[key] as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const product = [label("brand"), label("model")].filter(Boolean).join(" ");
  const admin = mail.kind === "weekly" || mail.kind === "escalation";
  if (!admin && !/^[0-9a-f-]{36}$/i.test(mail.request_id || "")) throw new Error("Invalid request link");
  const url = mail.kind === "no_rebate" ? CALCULATOR_URL
    : admin ? "https://calculator.rebateportal.com.au/admin/model-requests"
    : `https://calculator.rebateportal.com.au/model-requests/${mail.request_id}`;
  const action = mail.kind === "no_rebate" ? "Browse other models" : admin ? "Open model requests" : "Update your request";
  const subject = mail.kind === "weekly" ? "Rebate Portal: Weekly model request summary"
    : mail.kind === "escalation" ? "Rebate Portal: A model requester needs help"
    : mail.kind === "no_rebate" ? "Rebate Portal: Your model request has been checked"
    : mail.kind === "reminder" ? "Rebate Portal: Reminder about your model request"
    : "Rebate Portal: One more detail for your model request";
  const details = mail.kind === "no_rebate" ? [
    "We have completed the research and rebate check for your request.",
    `Registered system: ${product}`,
    `GEMS registration: ${label("registration")}`,
    `Installation checked: postcode ${label("postcode")}, ${label("install_type") === "replacement" ? "replacement" : "new installation"}.`,
    "The verified calculation returned 0 ESC and 0 PRC certificates for this installation. We have not added it as a rebate-generating option.",
    "You can browse the calculator for other models. This result applies to the installation details checked, not every possible installation.",
    "If those details are incorrect or you have another model to check, reply to this email and we can help.",
    `Request reference: ${mail.request_id}`,
  ] : mail.kind === "weekly" ? [
    `Week beginning ${label("week")}`,
    `Added: ${label("added")} | Already available: ${label("existing")} | Closed without response: ${label("closed")}`,
    ...(payload.no_rebate !== undefined ? [`No rebate for the submitted installation: ${label("no_rebate")}`] : []),
    ...(payload.research_paused !== undefined ? [`Research paused for budget or review: ${label("research_paused")}`] : []),
    `Waiting for details: ${label("waiting")} | Needs attention: ${label("review")}`,
    ...lines("models"),
  ] : mail.kind === "escalation" ? [
    product, [label("requester"), label("business")].filter(Boolean).join(" / "),
    `Submitted: ${label("submitted")}`, `Last question: ${label("question")}`,
    `Response: ${label("message") || "Asked for a person to review this request."}`,
    "Automated follow-ups are paused.",
  ] : [
    product,
    label("question"),
    ...lines("candidates"),
    "Sign in with the account that submitted the request and use the link below to send the details or ask for help.",
  ];
  return sendModelRequestMail(admin ? REPLY_TO : mail.recipient, `model-request-contact/${mail.mail_key}`, {
    subject,
    ...(mail.kind === "no_rebate" ? { reply_to: REPLY_TO } : {}),
    text: ["Rebate Portal", ...details, `${action}: ${url}`].join("\n\n"),
    html: `<!doctype html><html lang="en"><body style="margin:0;background:#f3f6f8;color:#0f172a;font-family:Arial,sans-serif">
<div style="max-width:600px;margin:auto;padding:24px"><div style="background:white;border:1px solid #dbe4ec">
<h1 style="margin:0;padding:18px 24px;background:#0f766e;color:white;font-size:22px">Rebate Portal</h1>
<div style="padding:12px 24px;line-height:1.5">${details.map(detail => `<p>${escapeHtml(detail)}</p>`).join("")}
<p><a href="${url}" style="color:#0f766e">${action}</a></p></div></div></div></body></html>`,
  });
}

async function sendModelRequestMail(to: string, idempotencyKey: string, content: { subject: string; text: string; html: string; reply_to?: string }) {
  const from = process.env.MODEL_REQUEST_FROM_EMAIL?.trim();
  if (from !== SENDER_ADDRESS && from !== SENDER) {
    throw new Error(`MODEL_REQUEST_FROM_EMAIL must use ${SENDER_ADDRESS}`);
  }
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured");
  const recipient = to.trim();
  if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(recipient)) {
    throw new Error("Model request completion requires a single recipient email address");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      ...content,
      from: SENDER,
      to: [recipient],
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
