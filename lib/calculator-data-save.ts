import { isDeepStrictEqual } from "node:util";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabasePublishableKey, supabaseUrl } from "./supabase/config";

const SAVE_DEADLINE_MS = 8_000;
const JSON_STORAGE_KEY = /^(?:installer|greenEnergy)?(?:BusinessConfiguration|ManagedPrices|DefaultCostRules|MasterQuoteLog|QuoteOptionDefs|SavedQuoteSets|QuoteSyncTombstones|QuoteLibraryCopyReceipts|WonOptionAdminState|EssSettings|CommissionSettings|ProposalDetails)V1$/;
type CookieToSet = {
  name: string;
  value: string;
  options?: Parameters<Awaited<ReturnType<typeof cookies>>["set"]>[2];
};

function comparableStoredJson(value: unknown): object | null {
  if (typeof value !== "string" || !/^\s*(?:\{|\[)/.test(value)) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    const pending: unknown[] = [parsed];
    while (pending.length) {
      const item = pending.pop();
      if (typeof item === "number" && (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))) return null;
      if (item && typeof item === "object") {
        for (const child of Object.values(item)) pending.push(child);
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

export function sameCalculatorSaveData(stored: unknown, candidate: Record<string, unknown>): boolean {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return false;
  const record = stored as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (Object.keys(record).length !== keys.length) return false;
  return keys.every((key) => {
    if (!Object.hasOwn(record, key)) return false;
    if (isDeepStrictEqual(record[key], candidate[key])) return true;
    // The browser stores these JSON collections as strings. Formatting and
    // object key order do not change a collection; array order still matters.
    if (!JSON_STORAGE_KEY.test(key)) return false;
    const left = comparableStoredJson(record[key]);
    const right = comparableStoredJson(candidate[key]);
    return left !== null && right !== null && isDeepStrictEqual(left, right);
  });
}

export function calculatorSaveUnavailable(code: "CALCULATOR_SAVE_TIMEOUT" | "CALCULATOR_SAVE_UNAVAILABLE") {
  return Response.json({ error: "Calculator save could not be confirmed. Please retry.", code }, {
    status: 503,
    headers: { "Retry-After": "3", "Cache-Control": "no-store" },
  });
}

export function isCalculatorSaveDatabaseTimeout(error: { code?: string } | null | undefined) {
  return error?.code === "57014" || error?.code === "55P03" || error?.code === "PGRST003";
}

export function isCalculatorSaveAuthUnavailable(error: { name?: string; status?: number } | null) {
  return error?.name === "AuthRetryableFetchError" || error?.status === 408 || error?.status === 429 || (error?.status ?? 0) >= 500;
}

export async function withCalculatorSaveDeadline(
  requestSignal: AbortSignal,
  operation: (deadlineFetch: typeof fetch, signal: AbortSignal) => Promise<Response>,
  onDeadline: () => void,
  timeoutMs = SAVE_DEADLINE_MS,
): Promise<Response> {
  const deadline = new AbortController();
  const signal = AbortSignal.any([requestSignal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    const deadlineFetch: typeof fetch = (input, init) => {
      signal.throwIfAborted();
      const upstreamSignal = init?.signal ?? (input instanceof Request ? input.signal : null);
      return fetch(input, { ...init, signal: upstreamSignal ? AbortSignal.any([signal, upstreamSignal]) : signal });
    };
    let response: Response | null = null;
    if (!signal.aborted) {
      try {
        response = await Promise.race([aborted, operation(deadlineFetch, signal)]);
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
    if (response && !signal.aborted) return response;
    if (deadline.signal.aborted) onDeadline();
    return calculatorSaveUnavailable(deadline.signal.aborted ? "CALCULATOR_SAVE_TIMEOUT" : "CALCULATOR_SAVE_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function createCalculatorSaveClient(deadlineFetch: typeof fetch) {
  if (!supabaseUrl || !supabasePublishableKey) throw new Error("Missing Supabase environment variables.");
  const cookieStore = await cookies();
  return createServerClient(supabaseUrl, supabasePublishableKey, {
    global: { fetch: deadlineFetch },
    db: { retry: false },
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet: CookieToSet[]) {
        cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
      },
    },
  });
}
