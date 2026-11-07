import { createGunzip } from "node:zlib";

const MAX_WIRE_BYTES = 4_400_000;
const MAX_JSON_BYTES = 32_000_000;
export const CALCULATOR_GZIP_CONTENT_TYPE = "application/vnd.rebate-portal.calculator-save+gzip";

export class CalculatorSavePayloadError extends Error {
  constructor(public code: "CALCULATOR_SAVE_TOO_LARGE" | "CALCULATOR_SAVE_INVALID", public status: number, message: string) {
    super(message);
    this.name = "CalculatorSavePayloadError";
  }
}

function tooLarge() {
  return new CalculatorSavePayloadError("CALCULATOR_SAVE_TOO_LARGE", 413,
    "This save is too large to transfer. Keep this tab open and download your pending changes before refreshing.");
}

// Decode only after authentication. The wire format changes, not the saved data or merge rules.
export async function readCalculatorSavePayload(request: Request, signal: AbortSignal = request.signal): Promise<Record<string, any>> {
  signal.throwIfAborted();
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_WIRE_BYTES) throw tooLarge();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  if (reader) {
    const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      while (true) {
        signal.throwIfAborted();
        const result = await reader.read();
        signal.throwIfAborted();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > MAX_WIRE_BYTES) {
          void reader.cancel().catch(() => {});
          throw tooLarge();
        }
        chunks.push(result.value);
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
  }
  const bytes = Buffer.concat(chunks, size);
  const contentType = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  try {
    const decoded = contentType === CALCULATOR_GZIP_CONTENT_TYPE
      ? await new Promise<Buffer>((resolve, reject) => {
        const decoder = createGunzip();
        const output: Buffer[] = [];
        let decodedSize = 0;
        const abort = () => decoder.destroy(signal.reason);
        const cleanup = () => signal.removeEventListener("abort", abort);
        decoder.on("data", (chunk: Buffer) => {
          decodedSize += chunk.byteLength;
          if (decodedSize > MAX_JSON_BYTES) decoder.destroy(tooLarge());
          else output.push(chunk);
        });
        decoder.once("error", (error) => { cleanup(); reject(error); });
        decoder.once("end", () => { cleanup(); resolve(Buffer.concat(output, decodedSize)); });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        else decoder.end(bytes);
      })
      : bytes;
    signal.throwIfAborted();
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
    return value as Record<string, any>;
  } catch (error) {
    if (signal.aborted || error instanceof CalculatorSavePayloadError) throw error;
    if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw tooLarge();
    throw new CalculatorSavePayloadError("CALCULATOR_SAVE_INVALID", 400,
      "The save could not be read. Your changes have not been confirmed; keep this tab open and retry.");
  }
}
