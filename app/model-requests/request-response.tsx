"use client";

import { useState } from "react";
import styles from "./model-requests.module.css";

type RequestData = {
  brand: string;
  model: string;
  system_type: string;
  postcode: string;
  install_type: string;
  state: string;
  question: string;
  candidates: string[];
  next_at: string | null;
  round: number | null;
  product?: { model: string };
  outcome?: string;
  summary?: string;
  matchedModel?: string;
  no_rebate?: boolean;
};

const labels: Record<string, string> = {
  waiting: "Waiting for your response",
  closed: "Request closed",
  escalated: "Referred for human review",
  queued: "Response received",
  checking: "Being checked",
  researching: "Researching",
  review: "Under review",
  added: "Model added",
  declined: "Request declined",
  no_rebate: "No rebate for this installation",
};

export default function RequestResponse({ id, request }: { id: string; request: RequestData }) {
  const [data, setData] = useState(request);
  const [candidate, setCandidate] = useState("");
  const [model, setModel] = useState("");
  const [postcode, setPostcode] = useState(request.postcode || "");
  const [installType, setInstallType] = useState(request.install_type || "");
  const [message, setMessage] = useState("");
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const canRespond = data.state === "waiting" || data.state === "closed";

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/model-requests/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          round: data.round,
          model: model.trim() || candidate,
          postcode,
          install_type: installType,
          message,
          help,
        }),
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Your response could not be saved.");
      setData(result as RequestData);
      setNotice(help ? "Your response was received and human help was requested." : "Your response was received.");
      setCandidate("");
      setModel("");
      setMessage("");
      setHelp(false);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Your response could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return <>
    <p className={styles.status} aria-live="polite">{data.no_rebate || data.outcome === "no_rebate" ? labels.no_rebate : labels[data.state] || "Request status"}</p>
    {(data.summary || data.matchedModel) && <div className={styles.question}>
      {data.matchedModel && <h2>Registered model pair</h2>}
      {data.matchedModel && <p style={{ overflowWrap: "anywhere" }}>{data.matchedModel}</p>}
      {data.summary && <p>{data.summary}</p>}
      {(data.no_rebate || data.outcome === "no_rebate") && <p>The verified calculation returned 0 ESC and 0 PRC certificates for the submitted installation.</p>}
    </div>}
    {canRespond && data.question && <div className={styles.question}><h2>More information needed</h2><p>{data.question}</p></div>}
    {data.state === "closed" && <p>Sending the requested details will reopen this request.</p>}
    {canRespond ? <form className={styles.form} onSubmit={submit} aria-busy={busy}>
      {data.candidates?.length ? <div className={styles.field}>
        <label htmlFor="candidate">Suggested model</label>
        <select id="candidate" value={candidate} onChange={(event) => setCandidate(event.target.value)}>
          <option value="">Choose the pair on your equipment</option>
          {data.candidates.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </div> : null}
      <div className={styles.field}>
        <label htmlFor="model">Exact model or full model pair</label>
        <input id="model" value={model} maxLength={180} onChange={(event) => setModel(event.target.value)} placeholder="Enter the exact model name(s)" />
        <span className={styles.hint}>Enter indoor and outdoor model numbers together when applicable. A typed model takes priority over a suggestion.</span>
      </div>
      <div className={styles.twoFields}>
        <div className={styles.field}>
          <label htmlFor="postcode">Installation postcode</label>
          <input id="postcode" inputMode="numeric" autoComplete="postal-code" pattern="[0-9]{4}" maxLength={4} value={postcode} onChange={(event) => setPostcode(event.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="e.g. 2000" />
        </div>
        <div className={styles.field}>
          <label htmlFor="install-type">Installation type</label>
          <select id="install-type" value={installType} onChange={(event) => setInstallType(event.target.value)}>
            <option value="">Choose if known</option><option value="new">New installation</option><option value="replacement">Replacement</option>
          </select>
        </div>
      </div>
      <div className={styles.field}>
        <label htmlFor="message">Additional details</label>
        <textarea id="message" maxLength={1000} rows={4} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Add any details that may help with this request" />
      </div>
      <label className={styles.checkbox}><input type="checkbox" checked={help} onChange={(event) => setHelp(event.target.checked)} /> <span>Please have a person review this request</span></label>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {notice ? <p className={styles.success} role="status">{notice}</p> : null}
      <button className={styles.submit} type="submit" disabled={busy}>{busy ? "Sending response..." : data.state === "closed" ? "Reopen request" : "Send response"}</button>
    </form> : notice ? <p className={styles.success} role="status">{notice}</p> : null}
  </>;
}
