// SPDX-License-Identifier: AGPL-3.0-only
import { calculateNswFallback } from "../engine/nsw-calculation-fallback.mjs";

function sourceUrl() {
  const revision = process.env.VERCEL_GIT_COMMIT_SHA || "";
  return /^[a-f0-9]{40}$/.test(revision)
    ? `https://github.com/danieldipalma88-web/calculator/tree/${revision}/services/nsw-rebate-backup` : null;
}
const MAX_BYTES = 16384;
const ALLOWED_ORIGINS = new Set(["https://calculator.rebateportal.com.au"]);

function headers(origin, source) {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-NSW-Calculation-Source": "OpenFisca-ae8d778-HVAC1_PDRSAug24",
    ...(source ? { Link: `<${source}>; rel="source"` } : {}),
    Vary: "Origin",
    ...(ALLOWED_ORIGINS.has(origin) ? {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Expose-Headers": "X-NSW-Calculation-Source, Link",
      "Access-Control-Max-Age": "3600",
    } : {}),
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get("origin") || "";
    const source = sourceUrl();
    const responseHeaders = headers(origin, source);
    const reply = (value, status = 200) => Response.json(value, { status, headers: responseHeaders });
    if (process.env.VERCEL === "1" && !source) return reply({ error: "Source revision not configured" }, 503);
    if (origin && !ALLOWED_ORIGINS.has(origin)) return reply({ error: "Origin not allowed" }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders });
    if (request.method === "GET") return reply({ service: "NSW rebate calculation backup", source, license: "AGPL-3.0-only", upstreamRevision: "ae8d778f18e0612bd38c69a2527ff9d7e12d3747" });
    if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);
    if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || "")) return reply({ error: "JSON required" }, 415);
    if (Number(request.headers.get("content-length")) > MAX_BYTES) return reply({ error: "Request too large" }, 413);
    const reader = request.body?.getReader();
    if (!reader) return reply({ error: "Request body required" }, 400);
    let bytes = 0;
    const chunks = [];
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) {
          await reader.cancel();
          return reply({ error: "Request too large" }, 413);
        }
        chunks.push(value);
      }
      const text = Buffer.concat(chunks).toString("utf8");
      return reply(calculateNswFallback(JSON.parse(text)));
    } catch (error) {
      if (error?.code === "NSW_UNSUPPORTED_ESS_CLIMATE") {
        return reply({ error: "no field of name 0 in the NSW ESS postcode table", code: "NSW_UNSUPPORTED_ESS_CLIMATE" }, 400);
      }
      // Never log model payloads or echo untrusted input.
      console.warn("NSW backup rejected calculation", error instanceof SyntaxError ? "invalid-json" : "unsupported-input");
      return reply({ error: "Unsupported or incomplete calculation request" }, 422);
    }
  },
};
