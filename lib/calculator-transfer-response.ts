export async function calculatorTransferResponse(_request: Request, body: string, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  // Next/Vercel can strip a custom Content-Encoding then compress the bytes again.
  // Send UTF-8 and let the host negotiate compression; stream large quote histories.
  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  if (!headers.has("Content-Type")) headers.set("Content-Type", "text/plain; charset=utf-8");
  if (Buffer.byteLength(body) < 262144) return new Response(body, { ...init, headers });
  let bytes: Buffer | null = Buffer.from(body, "utf8");
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!bytes) return;
      const end = Math.min(offset + 65536, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
      if (offset === bytes.length) {
        bytes = null;
        controller.close();
      }
    },
    cancel() {
      bytes = null;
    },
  });
  return new Response(stream, { ...init, headers });
}

export function calculatorJsonResponse(request: Request, value: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return calculatorTransferResponse(request, JSON.stringify(value), { ...init, headers });
}
