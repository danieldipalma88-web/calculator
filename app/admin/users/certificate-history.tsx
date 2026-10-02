"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  certificateHistoryChartPoints,
  filterCertificateHistory,
  sortCertificateHistory,
  type CertificateHistoryRange,
  type CertificateHistoryRow,
} from "../../../lib/certificate-history";
import CertificateHistoryRangeSelect from "./certificate-history-range";

export type { CertificateHistoryRange, CertificateHistoryRow } from "../../../lib/certificate-history";

const money = (value: number) => `$${value.toFixed(2)}`;
const dateLabel = (value: string) => new Date(value).toLocaleDateString("en-AU", {
  timeZone: "Australia/Sydney", day: "numeric", month: "short", year: "numeric",
});
const chartDateLabel = (value: string) => new Date(value).toLocaleDateString("en-AU", {
  timeZone: "Australia/Sydney", day: "numeric", month: "short",
});
const dateTimeLabel = (value: string) => new Date(value).toLocaleString("en-AU", {
  timeZone: "Australia/Sydney", dateStyle: "medium", timeStyle: "short",
});
const rangeLabels: Record<CertificateHistoryRange, string> = {
  "4w": "Last 4 weeks", "3m": "Last 3 months", "6m": "Last 6 months", "1y": "Last year", all: "All time",
};

function HistoryChart({
  rows, metric, label, color,
}: {
  rows: CertificateHistoryRow[];
  metric: "escSpotPrice" | "prcSpotPrice";
  label: string;
  color: string;
}) {
  const chartHost = useRef<HTMLDivElement>(null);
  const pointRefs = useRef<Array<SVGCircleElement | null>>([]);
  const [width, setWidth] = useState(240);
  const [selected, setSelected] = useState(Math.max(rows.length - 1, 0));
  const height = 230;
  const hasTrend = rows.length > 1;
  useEffect(() => {
    const host = chartHost.current;
    if (!host || !hasTrend) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.max(240, Math.floor(entry.contentRect.width)));
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [hasTrend]);
  useEffect(() => {
    setSelected(Math.max(rows.length - 1, 0));
  }, [rows]);
  if (!rows.length) return <div className="certificate-chart-empty">No observations in this range.</div>;
  if (rows.length === 1) return (
    <div className="certificate-chart-empty">
      <strong>{money(rows[0][metric])} · {dateLabel(rows[0].observedAt)}</strong>
      <span>Insufficient history to show a trend.</span>
    </div>
  );

  const points = certificateHistoryChartPoints(rows, metric, width, height);
  const values = points.map((point) => point.value);
  const min = Math.max(0, Math.min(...values) - Math.max((Math.max(...values) - Math.min(...values)) * 0.15, Math.max(...values) * 0.02, 0.02));
  const max = Math.max(...values) + Math.max((Math.max(...values) - Math.min(...values)) * 0.15, Math.max(...values) * 0.02, 0.02);
  const left = 56;
  const right = width - 12;
  const top = 12;
  const bottom = 196;
  const formatAxis = (value: number) => `$${value.toFixed(2)}`;
  const path = points.map((point) => `${point.x},${point.y}`).join(" ");
  const active = Math.min(selected, rows.length - 1);
  const previous = points[0];
  const last = points[points.length - 1];

  return (
    <div>
      <div ref={chartHost} className="certificate-history-chart-scroll" style={{ width: "100%", overflowX: "auto" }}>
      <svg className="certificate-price-chart" style={{ width, height, maxWidth: "none" }} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`${label} spot price history chart`}>
        {[0, 0.5, 1].map((fraction) => {
          const y = top + fraction * (bottom - top);
          const value = max - fraction * (max - min);
          return <g key={fraction}>
            <line x1={left} x2={right} y1={y} y2={y} className="certificate-chart-gridline" />
            <text x={left - 8} y={y + 4} textAnchor="end" className="certificate-history-axis-label" fill="#59677a" fontSize="11">{formatAxis(value)}</text>
          </g>;
        })}
        <line x1={left} x2={right} y1={bottom} y2={bottom} className="certificate-history-axis" />
        <polyline points={path} fill="none" stroke={color} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((point, index) => (
          <g key={point.id}>
            <circle
              ref={(element) => { pointRefs.current[index] = element; }}
              cx={point.x}
              cy={point.y}
              r={14}
              fill="transparent"
              stroke="transparent"
              strokeWidth={1}
              pointerEvents="all"
              tabIndex={index === active ? 0 : -1}
              role="button"
              aria-label={`${label} ${money(point.value)} on ${dateTimeLabel(point.date)}`}
              aria-pressed={index === active}
              onFocus={() => setSelected(index)}
              onClick={() => setSelected(index)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                  event.preventDefault();
                  const direction = event.key === "ArrowRight" ? 1 : -1;
                  const next = Math.max(0, Math.min(active + direction, points.length - 1));
                  setSelected(next);
                  pointRefs.current[next]?.focus();
                } else if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelected(index);
                }
              }}
            />
            <circle
              cx={point.x}
              cy={point.y}
              r={index === active ? 7 : 5}
              fill="#fff"
              stroke={color}
              strokeWidth={index === active ? 4 : 2}
              pointerEvents="none"
            />
          </g>
        ))}
        <text x={left} y={height - 4} textAnchor="start" className="certificate-history-axis-label" fill="#59677a" fontSize="11">
          <title>{dateLabel(previous.date)}</title>{chartDateLabel(previous.date)}
        </text>
        <text x={right} y={height - 4} textAnchor="end" className="certificate-history-axis-label" fill="#59677a" fontSize="11">
          <title>{dateLabel(last.date)}</title>{chartDateLabel(last.date)}
        </text>
      </svg>
      </div>
      <div className="certificate-history-point-controls" role="group" aria-label={`${label} history point controls`}>
        <button className="certificate-history-point-button" type="button" onClick={() => { const next = Math.max(active - 1, 0); setSelected(next); pointRefs.current[next]?.focus(); }} disabled={active === 0} aria-label="Previous observation">&larr; Previous</button>
        <span>{active + 1} of {points.length}</span>
        <button className="certificate-history-point-button" type="button" onClick={() => { const next = Math.min(active + 1, points.length - 1); setSelected(next); pointRefs.current[next]?.focus(); }} disabled={active === points.length - 1} aria-label="Next observation">Next &rarr;</button>
      </div>
      <p className="certificate-history-point-readout" aria-live="polite">
        <strong>{money(points[active].value)}</strong> · {dateTimeLabel(points[active].date)} (Sydney)
      </p>
    </div>
  );
}

export default function CertificateHistory({
  rows,
  initialRange = "all",
  initialOpen = false,
}: {
  rows: CertificateHistoryRow[];
  initialRange?: CertificateHistoryRange;
  initialOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(initialOpen);
  const [range, setRange] = useState(initialRange);
  const chronological = useMemo(() => sortCertificateHistory(rows), [rows]);
  const visible = useMemo(() => filterCertificateHistory(chronological, range), [chronological, range]);
  const tableRows = [...visible].reverse();
  const latest = chronological.at(-1);
  const extrema = (metric: "escSpotPrice" | "prcSpotPrice") => visible.length
    ? { high: Math.max(...visible.map((row) => row[metric])), low: Math.min(...visible.map((row) => row[metric])) }
    : { high: null, low: null };

  return (
    <details
      className="certificate-history-panel"
      id="certificate-price-history"
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary>
        <div>
          <strong>{isOpen ? "Hide price history" : "Show price history"}</strong>
          <span>{latest
            ? `${rows.length} recorded ${rows.length === 1 ? "observation" : "observations"}; latest ${dateLabel(latest.effectiveWeek)}.`
            : "History will appear after the first verified spot-price observation."}</span>
        </div>
        <span className="section-chevron" aria-hidden="true" />
      </summary>
      <div className="certificate-history-body">
        <div className="certificate-history-toolbar">
          <div>
            <h3>Spot-price trend</h3>
            <p>{rangeLabels[range]}. The fixed DCCEEW $30 contract rate is separate from these market prices.</p>
          </div>
          <CertificateHistoryRangeSelect value={range} onChange={setRange} />
        </div>
        <div className="certificate-chart-grid">
          {([[
            "escSpotPrice", "ESC", "#0f766e",
          ], ["prcSpotPrice", "PERC", "#c2410c"]] as const).map(([metric, label, color]) => {
            const limits = extrema(metric);
            return <article className="certificate-chart-card" key={metric}>
              <div className="certificate-chart-heading">
                <div><span>{label} spot price</span><strong>$ per certificate</strong></div>
                <div className="certificate-chart-extremes">
                  <span>High {limits.high === null ? "-" : money(limits.high)}</span>
                  <span>Low {limits.low === null ? "-" : money(limits.low)}</span>
                </div>
              </div>
              <HistoryChart rows={visible} metric={metric} label={label} color={color} />
            </article>;
          })}
        </div>
        <div className="certificate-history-table-wrap">
          <table className="certificate-history-table">
            <thead><tr><th>Date</th><th>ESC spot</th><th>PERC spot</th><th>Source</th></tr></thead>
            <tbody>{tableRows.length ? tableRows.map((row) => (
              <tr key={row.id}>
                <td><strong>{dateLabel(row.effectiveWeek)}</strong><span>{dateTimeLabel(row.observedAt)} Sydney</span></td>
                <td>{money(row.escSpotPrice)}</td>
                <td>{money(row.prcSpotPrice)}</td>
                <td><strong>{/automation|automated|system|refresh|bot/i.test(`${row.source} ${row.observedByEmail}`) ? "Automated" : row.source}</strong></td>
              </tr>
            )) : <tr><td colSpan={4} className="certificate-history-empty">No spot-price observations fall within this range.</td></tr>}</tbody>
          </table>
        </div>
      </div>
    </details>
  );
}
