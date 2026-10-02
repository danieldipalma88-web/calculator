"use client";

import { useEffect, useMemo, useState } from "react";
import { paymentFollowUp, sydneyToday, type PaymentFollowUpJob } from "../../../lib/payment-follow-up";

type Job = PaymentFollowUpJob & {
  key: string;
  name: string;
  salesperson: string;
  business: string;
};

export default function PaymentFollowUpNotice({ jobs, initialToday, unavailable = false }: {
  jobs: Job[]; initialToday: string; unavailable?: boolean;
}) {
  const [today, setToday] = useState(initialToday);
  const [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const updateDay = () => { if (!document.hidden) setToday(sydneyToday()); };
    updateDay();
    const timer = window.setInterval(updateDay, 60000);
    window.addEventListener("focus", updateDay);
    document.addEventListener("visibilitychange", updateDay);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", updateDay);
      document.removeEventListener("visibilitychange", updateDay);
    };
  }, []);
  const reminders = useMemo(() => jobs.flatMap((job) => {
    const followUp = paymentFollowUp(job, today);
    return followUp ? [{ job, followUp }] : [];
  }).sort((a, b) => (b.followUp.daysSinceInstall ?? -1) - (a.followUp.daysSinceInstall ?? -1)), [jobs, today]);
  const summary = useMemo(() => {
    const counts = new Map<string, number>();
    reminders.forEach(({ followUp }) => counts.set(followUp.label, (counts.get(followUp.label) || 0) + 1));
    return [...counts].map(([label, count]) => `${count} ${label.toLowerCase()}`).join(" / ");
  }, [reminders]);

  if (unavailable) return <aside className="payment-follow-up-notice" aria-label="Payment follow-up">
    <strong>Payment reminders could not be checked</strong>
    <p>Review Won Jobs before assuming there are no outstanding payments.</p>
  </aside>;
  if (!reminders.length) return null;

  function reviewJob(key: string) {
    const detail = { key, opened: false };
    const event = new CustomEvent("admin:review-won-job", { detail, cancelable: true });
    if (!document.dispatchEvent(event) || !detail.opened) {
      setMessage("Wait for the current job update to finish, then try again.");
      return;
    }
    setMessage("");
    setExpanded(false);
  }

  return <aside className="payment-follow-up-notice" aria-labelledby="payment-follow-up-heading">
    <div className="payment-follow-up-heading">
      <div aria-live="polite" aria-atomic="true">
        <span className="payment-follow-up-eyebrow">Your payment reminders</span>
        <h2 id="payment-follow-up-heading">{reminders.length} {reminders.length === 1 ? "job needs" : "jobs need"} follow-up</h2>
        <p>{summary}</p>
      </div>
      <button type="button" className="payment-follow-up-toggle" aria-expanded={expanded}
        aria-controls="payment-follow-up-list" onClick={() => setExpanded(!expanded)}>
        {expanded ? "Hide list" : "Review jobs"}
      </button>
    </div>
    <div id="payment-follow-up-list" hidden={!expanded}>
      <p className="payment-follow-up-note">Based on the proposed install date and recorded payments. Confirm the install is complete before requesting or paying money.</p>
      <ul className="payment-follow-up-list">
        {reminders.map(({ job, followUp }) => <li key={job.key}>
          <div className="payment-follow-up-job">
            <strong>{job.name}</strong>
            <span>{job.salesperson} - {job.business}</span>
            <small>{followUp.daysSinceInstall === null ? "Install date missing or invalid" :
              `Install ${job.proposedInstallationDate.split("-").reverse().join("/")} (${followUp.daysSinceInstall} ${followUp.daysSinceInstall === 1 ? "day" : "days"} ago)`}</small>
          </div>
          <div className="payment-follow-up-action">
            <strong>{followUp.label}</strong>
            <span>{followUp.amount.toLocaleString("en-AU", { style: "currency", currency: "AUD" })}</span>
          </div>
          <button type="button" className="secondary" aria-label={`Review ${job.name}`} onClick={() => reviewJob(job.key)}>Review job</button>
        </li>)}
      </ul>
    </div>
    {message ? <p role="status">{message}</p> : null}
  </aside>;
}
