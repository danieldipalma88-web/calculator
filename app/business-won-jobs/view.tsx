"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { BusinessWonJob, BusinessWonJobs } from "../../lib/business-won-jobs";
import styles from "./view.module.css";

const currencyFormat = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" });
const money = (value: number | null) => value === null ? "Not recorded" : currencyFormat.format(value);
const date = (value: string) => {
  const calendar = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (calendar) return `${calendar[3]}/${calendar[2]}/${calendar[1]}`;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" }) : "Not recorded";
};
const day = (value: string) => {
  const parts = dayFormat.formatToParts(new Date(value));
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)?.value).join("-");
};
const sum = (jobs: BusinessWonJob[], key: "customerTotal" | "rebateTotal" | "installerProfit") => jobs.some(job => job[key] === null) ? null : jobs.reduce((n, job) => n + job[key]!, 0);

export default function BusinessWonJobsView({ businessId, viewingEmail }: { businessId: string; viewingEmail: string }) {
  const [data, setData] = useState<BusinessWonJobs | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState("");
  const [salesperson, setSalesperson] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);
  const scope = useRef("");
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const params = new URLSearchParams({ businessId });
    if (viewingEmail) params.set("as", viewingEmail);
    // A changed workspace must never show the previous business while it loads.
    if (scope.current !== params.toString()) { setData(null); setSearch(""); setSalesperson(""); setFrom(""); setTo(""); setPage(0); }
    scope.current = params.toString();
    let active = true;
    setBusy(true); setPreparing(false); setError("");
    const load = async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const response = await fetch(`/api/business-won-jobs?${params}`, { cache: "no-store", signal: controller.signal });
        const result = await response.json();
        if (response.status === 202 && result.status === "refreshing" && result.businessId === businessId) {
          if (active) { setData(null); setPreparing(true); }
          await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(delay); reject(new Error("Loading cancelled")); };
            const delay = setTimeout(() => { controller.signal.removeEventListener("abort", abort); resolve(); }, 1000);
            if (controller.signal.aborted) abort();
            else controller.signal.addEventListener("abort", abort, { once: true });
          });
          continue;
        }
        if (!response.ok) throw new Error(result.error || "Won Jobs could not be loaded.");
        if (result.businessId !== businessId || !Array.isArray(result.jobs)) throw new Error("Won Jobs could not be verified.");
        if (active) { setData(result); setPage(0); }
        return;
      }
      throw new Error("Business Won Jobs is still preparing. Please refresh to continue.");
    };
    load()
      .catch(reason => {
        if (active) {
          setData(null);
          setError(controller.signal.aborted ? "Loading took too long. Please try again." : reason.message || "Won Jobs could not be loaded.");
        }
      })
      .finally(() => { clearTimeout(timer); if (active) setBusy(false); });
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [businessId, viewingEmail, refresh]);
  const people = useMemo(() => [...new Set(data?.jobs.map(job => job.salespersonName).filter(Boolean) || [])].sort(), [data]);
  const invalidRange = !!from && !!to && from > to;
  const jobs = useMemo(() => {
    if (invalidRange) return [];
    const query = search.trim().toLowerCase();
    return (data?.jobs || []).filter(job => (!salesperson || job.salespersonName === salesperson)
      && (!from || day(job.wonAt) >= from) && (!to || day(job.wonAt) <= to)
      && (!query || [job.quoteName, job.address, job.salespersonName, ...job.rows.map(row => `${row.brand} ${row.model}`)].join(" ").toLowerCase().includes(query)));
  }, [data, salesperson, search, from, to, invalidRange]);
  const lastPage = Math.max(0, Math.ceil(jobs.length / 25) - 1);
  const shownPage = Math.min(page, lastPage);
  const filtered = !!search || !!salesperson || !!from || !!to;
  return <main className={styles.page}>
    <header className={styles.header}>
      <div><p className={styles.business}>{data?.businessName || "Business"}</p><h1>Won Jobs</h1>
        {viewingEmail && <p className={styles.muted}>Account preview: {viewingEmail}</p>}</div>
      <button type="button" onClick={() => setRefresh(value => value + 1)} disabled={busy}>{busy ? "Loading..." : "Refresh"}</button>
    </header>
    {error && <div className={styles.error} role="alert">{error}</div>}
    <p className={styles.status} role="status">{busy ? preparing ? "Preparing business Won Jobs..." : "Loading business Won Jobs..." : data ? `Updated ${new Date(data.checkedAt).toLocaleString("en-AU", { timeZone: "Australia/Sydney" })}` : ""}</p>
    {data && <>
      <section className={styles.filters} aria-label="Filter Won Jobs">
        <div><label htmlFor="won-search">Search</label><input id="won-search" type="search" value={search} placeholder="Customer, model or address" onChange={event => { setSearch(event.target.value); setPage(0); }} /></div>
        <div><label htmlFor="won-salesperson">Salesperson</label><select id="won-salesperson" value={salesperson} onChange={event => { setSalesperson(event.target.value); setPage(0); }}><option value="">All salespeople</option>{people.map(person => <option key={person}>{person}</option>)}</select></div>
        <div><label htmlFor="won-from">Won from</label><input id="won-from" type="date" value={from} onChange={event => { setFrom(event.target.value); setPage(0); }} /></div>
        <div><label htmlFor="won-to">Won to</label><input id="won-to" type="date" value={to} onChange={event => { setTo(event.target.value); setPage(0); }} /></div>
      </section>
      {invalidRange && <p className={styles.error} role="alert">The end date must be on or after the start date.</p>}
      <section className={styles.totals} aria-label={filtered ? "Filtered totals" : "Business totals"}>
        <div><span>{filtered ? "Matching won jobs" : "Won jobs"}</span><strong>{jobs.length}</strong></div>
        <div><span>Customer total inc GST</span><strong>{money(sum(jobs, "customerTotal"))}</strong></div>
        <div><span>Saved rebate</span><strong>{money(sum(jobs, "rebateTotal"))}</strong></div>
        <div><span>Installer profit ex GST</span><strong>{money(sum(jobs, "installerProfit"))}</strong></div>
      </section>
      {!jobs.length && <p className={styles.empty}>{filtered ? "No won jobs match these filters." : "No won jobs recorded for this business."}</p>}
      <section aria-label="Won jobs list" className={styles.list}>
        {jobs.slice(shownPage * 25, (shownPage + 1) * 25).map(job => <article key={job.key} className={styles.job}>
          <div className={styles.jobHead}><div><h2>{job.quoteName}</h2><p>{job.salespersonName || "Salesperson not recorded"} <span className={styles.muted}>| Won {date(job.wonAt)}</span></p></div>
            <div className={styles.jobMoney}><div><span>Customer total inc GST</span><strong>{money(job.customerTotal)}</strong></div><div><span>Installer profit ex GST</span><strong>{money(job.installerProfit)}</strong></div></div>
          </div>
          <p className={styles.location}>{job.address || "Installation address not recorded"}{job.installationDate && <> <span>| Proposed install: {date(job.installationDate)}</span></>}</p>
          <details><summary>{job.rows.length} {job.rows.length === 1 ? "system" : "systems"}</summary>
            <div className={styles.systems}>{job.rows.map((row, index) => <div key={index}><div><strong>{[row.brand, row.size, row.type].filter(Boolean).join(" ") || "System"}</strong><p>{row.model}{row.install && ` | ${row.install}`}</p></div><span>{money(row.finalInc)}</span></div>)}</div>
          </details>
        </article>)}
      </section>
      {lastPage > 0 && <nav className={styles.paging} aria-label="Won Jobs pages"><button disabled={shownPage === 0} onClick={() => setPage(shownPage - 1)}>Previous</button><span>Page {shownPage + 1} of {lastPage + 1}</span><button disabled={shownPage === lastPage} onClick={() => setPage(shownPage + 1)}>Next</button></nav>}
    </>}
  </main>;
}
