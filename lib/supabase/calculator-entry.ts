// Bound the whole operation, including SDK initialization, locks and retry delays.
export class CalculatorAuthTimeout extends Error {}

export async function withCalculatorAuthDeadline<T>(
  run: (signal: AbortSignal, authFetch: typeof fetch) => Promise<T>,
  timeoutMs = 6000,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new CalculatorAuthTimeout("Calculator sign-in timed out"));
      controller.abort();
    }, timeoutMs);
  });
  const authFetch: typeof fetch = (input, init) => {
    // Once authentication succeeds the page reuses this client for normal data reads.
    if (finished && !controller.signal.aborted) return fetch(input, init);
    return fetch(input, { ...init, signal: controller.signal });
  };
  try {
    return await Promise.race([run(controller.signal, authFetch), deadline]);
  } finally {
    finished = true;
    clearTimeout(timer);
  }
}

export function temporaryAuthFailure(error: unknown) {
  if (error instanceof CalculatorAuthTimeout) return true;
  if (!error || typeof error !== "object") return false;
  const { name, status } = error as { name?: string; status?: number };
  return name === "AuthRetryableFetchError" || status === 429 || (status ?? 0) >= 500;
}
