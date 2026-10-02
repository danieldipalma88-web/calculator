export async function requestUserRemoval(email: string, checkOnly = false) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(`/api/admin/approved-users${checkOnly ? `?email=${encodeURIComponent(email)}` : ""}`, {
          method: checkOnly ? "GET" : "DELETE", credentials: "same-origin", cache: "no-store",
          headers: checkOnly ? undefined : { "Content-Type": "application/json" },
          body: checkOnly ? undefined : JSON.stringify({ email }), signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok || result.ok !== true || result.email !== email.trim().toLowerCase()
          || typeof result.removed !== "boolean") {
          throw new Error(result.error || "The user's current access could not be confirmed.");
        }
        return result as { ok: true; email: string; removed: boolean };
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("The request took too long. Removal has not been confirmed. Check the user's current access before trying again."));
          controller.abort();
        }, 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
