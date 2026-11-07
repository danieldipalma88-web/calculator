import { gzip } from "node:zlib";

function acceptsGzip(request: Request) {
  const encodings = (request.headers.get("accept-encoding") || "").split(",").map((entry) => {
    const [name, ...parameters] = entry.trim().toLowerCase().split(";");
    const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
    const weight = quality ? Number(quality.trim().slice(2)) : 1;
    return { name: name.trim(), weight: Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0 };
  });
  return ((encodings.find(({ name }) => name === "gzip") || encodings.find(({ name }) => name === "*"))?.weight ?? 0) > 0;
}

// Compress before the hosting response-size check. Browser fetch transparently decodes this.
export async function calculatorTransferResponse(request: Request, body: string, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  const vary = (headers.get("Vary") || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!vary.some((value) => value === "*" || value.toLowerCase() === "accept-encoding")) vary.push("Accept-Encoding");
  headers.set("Vary", vary.join(", "));
  if (Buffer.byteLength(body) < 262144 || !acceptsGzip(request)) return new Response(body, { ...init, headers });
  const encoded = await new Promise<Buffer>((resolve, reject) => {
    gzip(body, { level: 1 }, (error, output) => error ? reject(error) : resolve(output));
  });
  headers.set("Content-Encoding", "gzip");
  headers.delete("Content-Length");
  return new Response(new Uint8Array(encoded), { ...init, headers });
}

export function calculatorJsonResponse(request: Request, value: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return calculatorTransferResponse(request, JSON.stringify(value), { ...init, headers });
}
