"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./model-requests.module.css";

type Job = { state: "queued" | "checking" | "review" | "added" | "declined"; contact_state: "waiting" | "closed" | "escalated" | null; contact_next_at: string | null; activity?: { at: string; kind: string; detail: string }[]; existing: boolean; reason: string; attempts: number; evidence: Record<string, unknown>; product: Record<string, unknown> | null; email_state: "pending" | "sending" | "sent" | "failed"; email_error: string; email_sent_at: string | null };
type Request = { id: string; requester_name: string; requester_email: string; business_name: string; system_type: string; brand: string; model: string; capacity: string | number; phase: string; notes: string; postcode: string; install_type: string; created_at: string; status: string; job: Job | null };
type Product = { id: string; product: { brand: string; model: string; systemType: string; capacityKw: string | number; phase: string }; active: boolean; created_at: string };
type Digest = { state: string; week: string; sent_at: string | null };
type Payload = { requests: Request[]; products: Product[]; hasMore: boolean; digest?: Digest | null };
type Filter = "review" | "checking" | "waiting" | "added" | "closed" | "all";

const filters: { value: Filter; label: string }[] = [
  { value: "review", label: "Needs review" }, { value: "checking", label: "Checking" },
  { value: "waiting", label: "Waiting for details" }, { value: "added", label: "Completed" },
  { value: "closed", label: "Closed" }, { value: "all", label: "All" },
];

const stateLabel: Record<string, string> = {
  review: "Needs review", queued: "Queued", checking: "Checking", added: "Added",
  already_available: "Already available", declined: "Declined", waiting: "Waiting for details",
  closed: "Closed: no response", escalated: "Requester needs help",
  response_received: "Response received", question_sent: "Details requested",
  reminder_sent: "Reminder sent", escalation_sent: "Admin alerted", contact_failed: "Email needs review",
  contact_cancelled: "Email cancelled",
  confirmation_sent: "Confirmation accepted", confirmation_failed: "Confirmation needs review",
};

function date(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short", timeZone: "Australia/Sydney" });
}

function readable(value: unknown) {
  if (value == null || value === "") return "Not recorded";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function capacityLabel(value: string | number) {
  const capacity = String(value ?? "").trim();
  if (!capacity) return "";
  return typeof value === "number" || /^\d+(?:\.\d+)?$/.test(capacity) ? `${capacity} kW` : capacity;
}

function legacyLabel(status: string) {
  if (status === "closed" || status === "declined") return "Closed request";
  if (status === "new" || status === "reviewing") return "Legacy request";
  return "Legacy request";
}

function failureMessage(cause: unknown, fallback: string) {
  if (cause instanceof DOMException && cause.name === "TimeoutError") return "Request timed out. Check your connection and try again.";
  if (cause instanceof Error) return cause.message;
  return fallback;
}

export default function RequestList() {
  const [data, setData] = useState<Payload>({ requests: [], products: [], hasMore: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("review");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const requestSequence = useRef(0);

  const loadPage = useCallback(async ({ offset, append, signal, pageFilter, pageQuery }: {
    offset: number; append: boolean; signal?: AbortSignal; pageFilter: Filter; pageQuery: string;
  }) => {
    const sequence = ++requestSequence.current;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError("");
    try {
      const timeout = AbortSignal.timeout(15000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const params = new URLSearchParams({ filter: pageFilter, q: pageQuery.trim(), offset: String(offset) });
      const response = await fetch(`/api/admin/model-requests?${params}`, { method: "GET", cache: "no-store", credentials: "same-origin", signal: requestSignal });
      const payload = await response.json() as Partial<Payload> & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not load model requests.");
      if (sequence !== requestSequence.current) return;
      const requests = Array.isArray(payload.requests) ? payload.requests : [];
      setData((previous) => ({
        requests: append ? [...previous.requests, ...requests] : requests,
        products: Array.isArray(payload.products) ? payload.products : previous.products,
        hasMore: Boolean(payload.hasMore),
        digest: payload.digest,
      }));
    } catch (cause) {
      if (sequence === requestSequence.current && !(cause instanceof DOMException && cause.name === "AbortError")) setError(failureMessage(cause, "Could not load model requests."));
    } finally {
      if (sequence === requestSequence.current) { setLoading(false); setLoadingMore(false); }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadingMore(false);
    const timer = window.setTimeout(() => {
      void loadPage({ offset: 0, append: false, signal: controller.signal, pageFilter: filter, pageQuery: query });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); requestSequence.current += 1; };
  }, [filter, query, loadPage]);

  async function act(id: string, action: "retry" | "decline" | "disable") {
    setBusy(id); setError(""); setNotice("");
    try {
      const response = await fetch("/api/admin/model-requests", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action }), signal: AbortSignal.timeout(15000) });
      const result = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(result.error || "The action could not be completed.");
      setNotice(result.message || (action === "retry" ? "Verification queued." : action === "decline" ? "Request closed." : "Product disabled."));
      await loadPage({ offset: 0, append: false, pageFilter: filter, pageQuery: query });
    } catch (cause) { setError(failureMessage(cause, "The action could not be completed.")); }
    finally { setBusy(""); }
  }

  const refresh = () => { void loadPage({ offset: 0, append: false, pageFilter: filter, pageQuery: query }); };

  return <div className={styles.page}>
    <section className={styles.controls} aria-label="Request filters">
      <label className={styles.search}>Search brands, models or requesters
        <input type="search" value={query} disabled={Boolean(busy)} onChange={(event) => setQuery(event.target.value)} placeholder="Brand, model, name or email" />
      </label>
      <div className={styles.filters} role="group" aria-label="Filter requests">
        {filters.map((item) => <button key={item.value} type="button" disabled={Boolean(busy)} aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}</button>)}
        <button type="button" className={styles.refresh} aria-label="Refresh model requests" title="Refresh model requests" disabled={Boolean(busy) || loading} onClick={refresh}>↻</button>
      </div>
    </section>
    {error && <p className={styles.error} role="alert">{error} <button type="button" disabled={Boolean(busy)} onClick={refresh}>Retry loading</button></p>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {data.digest && <p className={data.digest.state === "failed" ? styles.error : styles.count}>
      Weekly summary for {data.digest.week}: {data.digest.state === "sent" ? "accepted by email provider"
        : data.digest.state === "failed" ? "delivery needs review" : "queued"}
    </p>}
    {loading ? <p className={styles.state} role="status">Loading model requests...</p> : <>
      <p className={styles.count} role="status">{data.requests.length} requests loaded</p>
      <div className={styles.list}>
        {data.requests.map((item) => {
          const job = item.job;
          const state = job?.contact_state || (job?.state === "added" && job.existing ? "already_available" : job?.state);
          const modelName = [item.brand, item.model].filter(Boolean).join(" ") || "Unspecified model";
          return <article className={styles.request} key={item.id}>
            <div className={styles.requestHead}>
              <div className={styles.identity}><h2>{modelName}</h2><p>{item.requester_name || "Unknown requester"} <span>·</span> {item.requester_email || "No email"}</p></div>
              <span className={styles.badge} data-state={state || item.status || "legacy"}>{state ? stateLabel[state] : legacyLabel(item.status)}</span>
            </div>
            <dl className={styles.details}>
              <div><dt>Business</dt><dd>{item.business_name || "Not recorded"}</dd></div>
              <div><dt>System</dt><dd>{[item.system_type, capacityLabel(item.capacity), item.phase].filter(Boolean).join(" · ") || "Not recorded"}</dd></div>
              <div><dt>Installation</dt><dd>{[item.install_type, item.postcode].filter(Boolean).join(" · ") || "Not recorded"}</dd></div>
              <div><dt>Requested</dt><dd>{date(item.created_at)}</dd></div>
            </dl>
            {item.notes && <p className={styles.notes}>{item.notes}</p>}
            {!job ? <p className={styles.legacy}>Legacy request - manual review</p> : <div className={styles.jobInfo}>
              {job.reason && <p><strong>Reason:</strong> {job.reason}</p>}
              {job.attempts > 0 && <p><strong>Verification attempts:</strong> {job.attempts}</p>}
              {job.contact_next_at && <p><strong>Next scheduled action:</strong> {date(job.contact_next_at)} (Sydney)</p>}
              {!!job.activity?.length && <details><summary>Request activity ({job.activity.length})</summary>
                <dl className={styles.evidence}>{[...job.activity].reverse().map((event, i) => <div key={i}>
                  <dt>{stateLabel[event.kind] || event.kind}</dt><dd>{date(event.at)}{event.detail && ` | ${event.detail}`}</dd>
                </div>)}</dl>
              </details>}
              <details><summary>Verification details</summary>
                <dl className={styles.evidence}>{Object.entries(job.evidence || {}).length ? Object.entries(job.evidence).map(([key, value]) => <div key={key}><dt>{key.replace(/[_-]/g, " ")}</dt><dd>{readable(value)}</dd></div>) : <div><dt>Evidence</dt><dd>None recorded</dd></div>}</dl>
              </details>
              <p><strong>Confirmation email:</strong> {job.state === "added" ? `${job.email_state}${job.email_error ? ` - ${job.email_error}` : ""}${job.email_sent_at ? ` (${date(job.email_sent_at)})` : ""}` : "Confirmation held until verified"}</p>
              {job.product && <p><strong>Matched product:</strong> {readable(job.product)}</p>}
            </div>}
            <div className={styles.actions}>
              <button type="button" className={styles.copy} disabled={Boolean(busy)} onClick={async () => { try { await navigator.clipboard.writeText(modelName); setNotice("Model copied."); } catch { setError("Could not access the clipboard."); } }}>Copy model</button>
              {job?.state === "review" && job.contact_state !== "waiting" && job.contact_state !== "closed" && <>
                <button type="button" disabled={Boolean(busy)} onClick={() => void act(item.id, "retry")}>{busy === item.id ? "Working..." : "Retry verification"}</button>
                <button type="button" className={styles.close} disabled={Boolean(busy)} onClick={() => void act(item.id, "decline")}>Close request</button>
              </>}
            </div>
          </article>;
        })}
      </div>
      {!data.requests.length && <p className={styles.state}>{query.trim() ? "No requests match this search." : "No requests in this view."}</p>}
      {data.hasMore && <div className={styles.loadMore}><button type="button" disabled={loadingMore || Boolean(busy)} onClick={() => void loadPage({ offset: data.requests.length, append: true, pageFilter: filter, pageQuery: query })}>{loadingMore ? "Loading..." : "Load more"}</button></div>}
      <section className={styles.products}>
        <h2>Automated catalogue products</h2>
        {!data.products.length ? <p className={styles.state}>No automated products.</p> : data.products.map((item) => <div className={styles.product} key={item.id}>
          <div><strong>{item.product.brand} {item.product.model}</strong><span>{[item.product.systemType, `${item.product.capacityKw} kW`, item.product.phase].filter(Boolean).join(" · ")} · {item.active ? "Active" : "Disabled"}</span></div>
          {item.active && <button type="button" className={styles.close} disabled={Boolean(busy)} onClick={() => { if (window.confirm(`Disable ${item.product.brand} ${item.product.model} from the automated catalogue?`)) void act(item.id, "disable"); }}>{busy === item.id ? "Working..." : "Disable product"}</button>}
        </div>)}
      </section>
    </>}
  </div>;
}
