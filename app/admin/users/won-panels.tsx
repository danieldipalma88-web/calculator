import { WON_BATCH_LABELS, type WonBatch } from "../../../lib/won-batches";
import {
  summarizeWonReport, wonReportPerson, wonReportRange, WON_MONEY_METRICS,
  type WonReportJob, type WonReportPerson, type WonReportPreset,
} from "../../../lib/won-reporting";
import { ReopenWonBatchButton, WonReportFilters } from "./won-controls";

const money = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
const dateTime = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Sydney", dateStyle: "medium", timeStyle: "short",
});
const compactDay = (value: string) => value.split("-").reverse().join("/");
const periodLabel = (start: string, end: string) => start === end
  ? compactDay(start) : `${compactDay(start)} to ${compactDay(end)}`;
const panelStyle = { padding: "12px 0", borderTop: "1px solid #dce4e8", minWidth: 0, overflowWrap: "anywhere" } as const;
const reportStyles = `
  .won-weekly-report .won-report-totals {
    display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px 20px;
    margin: 0 0 16px; padding: 12px 0; border-block: 1px solid #dce4e8;
  }
  .won-weekly-report .won-report-totals dt { font-size: 13px; }
  .won-weekly-report .won-report-totals dd {
    margin: 3px 0 0; font-weight: 700; font-variant-numeric: tabular-nums;
  }
  .won-weekly-report .won-report-table {
    width: 100%; min-width: 820px; border-collapse: collapse; font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  .won-weekly-report .won-report-table caption { text-align: left; font-weight: 700; padding: 0 0 8px; }
  .won-weekly-report .won-report-table :is(th, td) {
    padding: 10px; border-bottom: 1px solid #dce4e8; text-align: left; vertical-align: top;
  }
  .won-weekly-report .won-report-table thead { background: #f1f5f7; }
  @media (max-width: 640px) {
    .won-weekly-report .won-report-totals { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
`;

function reportAmount(value: { total: number; missing: number }) {
  return value.missing ? `Incomplete (${value.missing} missing)` : money.format(value.total);
}

function difference(value: number, monetary = false) {
  const amount = monetary ? Math.round(Math.abs(value) * 100) / 100 : Math.abs(value);
  return `${amount && value < 0 ? "-" : amount ? "+" : ""}${monetary ? money.format(amount) : amount}`;
}

export type WonSalesReportProps = {
  jobs: WonReportJob[];
  people: WonReportPerson[];
  today: string;
  includeBackups: boolean;
  unavailable: boolean;
  query?: { wonReport?: string; wonSalesperson?: string; wonFrom?: string; wonTo?: string };
};

export function WonSalesReport({ jobs, people, today, includeBackups, unavailable, query }: WonSalesReportProps) {
  const preset: WonReportPreset = query?.wonReport === "custom" || query?.wonReport === "last-month" ? query.wonReport : "last-week";
  const email = wonReportPerson(people, query?.wonSalesperson);
  const start = typeof query?.wonFrom === "string" ? query.wonFrom : "";
  const end = typeof query?.wonTo === "string" ? query.wonTo : "";
  const range = wonReportRange(preset, today, start, end);
  const report = !unavailable && range ? summarizeWonReport(jobs, email, range) : null;
  const person = people.find((entry) => entry.email === email);
  return (
    <details className="won-weekly-report" open={query?.wonReport ? true : undefined} style={panelStyle}>
      <style>{reportStyles}</style>
      <summary><strong>Weekly sales report</strong></summary>
      <WonReportFilters key={JSON.stringify([email, preset, start, end])}
        people={people} email={email} preset={preset} start={start || range?.start || ""}
        end={end || range?.end || ""} today={today} includeBackups={includeBackups} />
      <p>Won date · Australia/Sydney · Monday-start weeks · Current quotes only</p>
      {unavailable && <p role="status">The current Won Quotes could not be read. Report unavailable.</p>}
      {!unavailable && !range && <p role="status">Choose valid dates through today, up to 366 calendar days.</p>}
      {!unavailable && range && !person && <p>Choose a salesperson to see their report.</p>}
      {report && range && person && <>
        <p><strong>{person.name}</strong> · {periodLabel(range.start, range.end)}</p>
        <p>Compared with the same weekdays in the prior week.
          {range.end === today ? " Today is still in progress." : ""}</p>
        <p>Commission totals include paid and unpaid amounts, with GST where applicable.</p>
        {report.invalidDates > 0 && <p role="status">{report.invalidDates} quotes excluded because their won dates are invalid.</p>}
        <h3>Selected range totals</h3>
        <dl className="won-report-totals">
          <div><dt>Sales count</dt><dd>{report.totals.count}</dd></div>
          {WON_MONEY_METRICS.map(([key, label]) => <div key={key}>
            <dt>{label}</dt><dd>{reportAmount(report.totals.money[key])}</dd>
          </div>)}
        </dl>
        <div role="region" aria-label="Weekly details" tabIndex={0} style={{ overflowX: "auto", maxWidth: "100%" }}>
          <table className="won-report-table">
            <caption>Weekly details</caption>
            <thead><tr>
              <th scope="col">Won dates</th>
              <th scope="col">Sales count</th>
              {WON_MONEY_METRICS.map(([key, label]) => <th key={key} scope="col">{label}</th>)}
            </tr></thead>
            <tbody>
              {report.weeks.map((week) => <tr key={week.start}>
                <th scope="row">{periodLabel(week.start, week.end)}<br /><small>vs {periodLabel(week.previousStart, week.previousEnd)}</small></th>
                <td>{week.current.count}<br /><small>vs {week.previous.count} ({difference(week.current.count - week.previous.count)})</small></td>
                {WON_MONEY_METRICS.map(([key]) => {
                  const current = week.current.money[key];
                  const previous = week.previous.money[key];
                  return <td key={key}>{reportAmount(current)}<br /><small>
                    vs {reportAmount(previous)}
                    {!current.missing && !previous.missing ? ` (${difference(current.total - previous.total, true)})` : ""}
                  </small></td>;
                })}
              </tr>)}
            </tbody>
          </table>
        </div>
      </>}
    </details>
  );
}

export type WonBatchHistoryProps = {
  batches: WonBatch[];
  activeBatch?: WonBatch | null;
  activeBatchId?: string;
  availableIds: ReadonlySet<string>;
  includeBackups: boolean;
  unavailable: boolean;
  page: number;
  hasMore: boolean;
};

export function WonBatchHistory({
  batches, activeBatch, activeBatchId, availableIds, includeBackups, unavailable, page, hasMore,
}: WonBatchHistoryProps) {
  const visible = activeBatch && !batches.some(({ id }) => id === activeBatch.id) ? [activeBatch, ...batches] : batches;
  function pageHref(next: number) {
    const params = new URLSearchParams({ wonBatchPage: String(next) });
    if (includeBackups) params.set("checkBackups", "1");
    return `/admin/users?${params}#won-options`;
  }
  return (
    <details open={activeBatchId || page > 1 || unavailable ? true : undefined} style={panelStyle}>
      <summary><strong>Batch history and manual groups</strong></summary>
      {unavailable ? <p role="status">Batch history is unavailable. Bulk payment actions and manual saves require batch storage.</p> : <>
        <p>Older batch selections were not recorded. This log records admin actions, not proof of payment. Current statuses are on each quote.</p>
        {activeBatchId && !visible.some(({ id }) => id === activeBatchId) && <p role="status">This batch could not be found.</p>}
        {!visible.length && <p>No batches on this page.</p>}
        {visible.map((batch) => {
          const outcomes = new Map(batch.outcomes.map((outcome) => [outcome.id, outcome]));
          const ids = batch.items.map(({ id }) => id);
          const available = ids.filter((id) => availableIds.has(id)).length;
          const preview = batch.items.slice(0, 2).map(({ quote }) => quote).join(", ");
          const count = (status: string) => batch.outcomes.filter((outcome) => outcome.status === status).length;
          return <details key={batch.id} open={batch.id === activeBatchId ? true : undefined} style={panelStyle}>
            <summary><strong>{batch.label || WON_BATCH_LABELS[batch.kind]}</strong>
              {" · "}{dateTime.format(new Date(batch.created_at))}{" · "}{ids.length} quotes
              {preview ? ` · ${preview}${ids.length > 2 ? ", ..." : ""}` : ""}
            </summary>
            <p>Saved by {batch.actor_email} · {WON_BATCH_LABELS[batch.kind]}</p>
            {batch.kind === "manual" ? <p>No payment statuses changed.</p> : <p>
              {count("confirmed")} status updates logged · {count("already_recorded")} already recorded · {count("failed")} failed
              {" · "}{ids.length - outcomes.size} unconfirmed
            </p>}
            <ul>
              {batch.items.map((item) => {
                const outcome = outcomes.get(item.id);
                const status = outcome?.status === "confirmed" ? "Status update logged" : outcome?.status === "already_recorded"
                  ? "Already recorded" : outcome?.status === "failed" ? "Failed" : "Unconfirmed";
                return <li key={item.id}>
                  <strong>{item.quote}</strong> · {item.salesperson}
                  {batch.kind !== "manual" && ` · ${status}`}
                  {outcome?.detail && `: ${outcome.detail}`}
                  {item.recovered && " · Recovered backup"}
                  {!availableIds.has(item.id) && " · Unavailable in current view"}
                </li>;
              })}
            </ul>
            {available < ids.length && <p>{ids.length - available} original quotes are unavailable in this view.</p>}
            <ReopenWonBatchButton ids={ids} available={available} />
          </details>;
        })}
        {(page > 1 || hasMore) && <nav aria-label="Batch history pages" style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {page > 1 && <a href={pageHref(page - 1)}>Newer batches</a>}
          {hasMore && <a href={pageHref(page + 1)}>Older batches</a>}
        </nav>}
      </>}
    </details>
  );
}
