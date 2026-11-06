type UpdateWindow = Window & {
  __calculatorCanRefresh?: () => boolean;
};

// Serialized into the existing calculator document; no customer data is polled.
function mountCalculatorUpdateNotice(loadedVersion: string) {
  const app = window as UpdateWindow;
  let currentVersion = loadedVersion;
  let lastCheck = 0;
  let request: AbortController | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let readiness: ReturnType<typeof setInterval> | null = null;
  let initial: ReturnType<typeof setTimeout> | null = null;
  let notice: HTMLElement | null = null;
  let button: HTMLButtonElement | null = null;
  let detail: HTMLElement | null = null;

  function canRefresh() {
    try { return app.__calculatorCanRefresh?.() === true; }
    catch { return false; }
  }
  function updateReadiness() {
    if (!button || !detail || document.visibilityState !== "visible") return;
    const ready = canRefresh();
    button.disabled = !ready;
    detail.textContent = ready ? "Ready when you are." : "Save or cancel open edits and resolve any pending saves first.";
  }
  function render() {
    if (currentVersion === loadedVersion) {
      notice?.remove();
      notice = null; button = null; detail = null;
      if (readiness) clearInterval(readiness);
      readiness = null;
      return;
    }
    if (!notice) {
      notice = document.createElement("section");
      notice.className = "calculator-update-notice";
      notice.id = "calculatorUpdateNotice";
      notice.setAttribute("aria-label", "Calculator update");
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = "Calculator update available";
      title.setAttribute("role", "status");
      detail = document.createElement("span");
      detail.id = "calculatorUpdateDetail";
      copy.append(title, detail);
      button = document.createElement("button");
      button.type = "button";
      button.textContent = "Refresh calculator";
      button.setAttribute("aria-describedby", detail.id);
      button.addEventListener("click", () => {
        updateReadiness();
        if (!canRefresh()) return;
        if (!window.confirm("Refresh the calculator now? Saved quotes will remain. Any system not added to a quote and unfinished form entries will be reset.")) return;
        // Recheck after confirmation: another tab may have changed the workspace.
        if (!canRefresh()) { updateReadiness(); return; }
        window.location.reload();
      });
      notice.append(copy, button);
      document.body.prepend(notice);
      readiness = setInterval(updateReadiness, 5000);
    }
    updateReadiness();
  }
  async function checkVersion() {
    if (document.visibilityState !== "visible" || request || Date.now() - lastCheck < 60000) return;
    lastCheck = Date.now();
    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch("/api/calculator-version", {
        cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal,
      });
      if (!response.ok) return;
      const result = await response.json();
      if (controller.signal.aborted || typeof result?.version !== "string" || !/^[a-f0-9]{40}$/.test(result.version)) return;
      currentVersion = result.version;
      render();
    } catch {
      // Version checks must never interrupt calculation, saving or sign-in.
    } finally {
      clearTimeout(timeout);
      if (request === controller) request = null;
    }
  }
  function start() {
    if (poll) return;
    initial = setTimeout(checkVersion, 15000 + Math.floor(Math.random() * 15000));
    poll = setInterval(checkVersion, 300000);
    if (notice && !readiness) readiness = setInterval(updateReadiness, 5000);
  }
  window.addEventListener("pagehide", () => {
    request?.abort();
    if (poll) clearInterval(poll);
    if (readiness) clearInterval(readiness);
    if (initial) clearTimeout(initial);
    poll = null; readiness = null; initial = null;
  });
  window.addEventListener("pageshow", start);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { updateReadiness(); void checkVersion(); }
  });
  window.addEventListener("calculator-cloud-save-status", () => setTimeout(updateReadiness, 0));
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}

export function calculatorUpdateNoticeScript(version: string | null) {
  if (!version || !/^[a-f0-9]{40}$/.test(version)) return "";
  return `<style>
.calculator-update-notice{position:sticky;top:0;z-index:40;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 20px;background:#e7f5f1;border-bottom:1px solid #98cdc2;color:#123d37;font-size:14px;line-height:1.4;letter-spacing:0}
.calculator-update-notice>div{display:grid;gap:2px;min-width:0}
.calculator-update-notice strong{font-size:14px;font-weight:700}
.calculator-update-notice span{font-size:12px;color:#345d56}
.calculator-update-notice button{flex-shrink:0;min-height:44px;padding:10px 14px;border:1px solid #0f766e;border-radius:6px;background:#0f766e;color:white;font-family:inherit;font-size:13px;line-height:1.3;font-weight:700;cursor:pointer;letter-spacing:0}
.calculator-update-notice button:disabled{background:#e3e9e7;color:#4c5c57;border-color:#aebcb7;cursor:not-allowed}
.calculator-update-notice button:focus-visible{outline:3px solid #0f172a;outline-offset:3px}
@media(max-width:480px){.calculator-update-notice{align-items:stretch;flex-direction:column;padding:10px 14px;gap:8px}.calculator-update-notice button{width:100%}}
</style><script>(${mountCalculatorUpdateNotice.toString()})(${JSON.stringify(version)});</script>`;
}

export function injectCalculatorUpdateNotice(html: string, version: string | null) {
  // The calculator also contains a printable HTML template inside its script.
  return html.replace(/<\/body>\s*<\/html>\s*$/, ending => calculatorUpdateNoticeScript(version) + ending);
}
