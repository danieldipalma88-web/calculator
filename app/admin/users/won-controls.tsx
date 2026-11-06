"use client";

import { useEffect, useState } from "react";
import type { WonReportPerson, WonReportPreset } from "../../../lib/won-reporting";

export function WonSelectionScope({ scope }: { scope: string }) {
  useEffect(() => {
    document.dispatchEvent(new Event("admin:won-selection-scope-changed"));
  }, [scope]);
  return null;
}

export function WonReportFilters({ people, email, preset, start, end, today, includeBackups }: {
  people: WonReportPerson[];
  email: string;
  preset: WonReportPreset;
  start: string;
  end: string;
  today: string;
  includeBackups: boolean;
}) {
  const [range, setRange] = useState(preset);
  return (
    <form method="get" action="/admin/users#won-options" className="won-filter-controls" style={{
      display: "flex", flexWrap: "wrap", alignItems: "end", gap: 12,
    }}>
      {includeBackups && <input type="hidden" name="checkBackups" value="1" />}
      <label className="won-filter-field" style={{ flex: "1 1 220px", minWidth: 0 }}>
        <span>Salesperson</span>
        <select name="wonSalesperson" defaultValue={email} required style={{ width: "100%", minWidth: 0 }}>
          <option value="">Choose a salesperson</option>
          {people.map((person) => <option key={person.email} value={person.email}>
            {person.name === person.email ? person.name : `${person.name} (${person.email})`}
          </option>)}
        </select>
      </label>
      <label className="won-filter-field" style={{ flex: "1 1 130px", minWidth: 0 }}>
        <span>Date range</span>
        <select name="wonReport" value={range} onChange={(event) => setRange(event.target.value as WonReportPreset)}>
          <option value="last-week">Last week</option>
          <option value="last-month">Last month</option>
          <option value="custom">Custom dates</option>
        </select>
      </label>
      {range === "custom" && <>
        <label className="won-filter-field" style={{ flex: "1 1 132px", minWidth: 0 }}>
          <span>From</span>
          <input name="wonFrom" type="date" defaultValue={start} max={today} required />
        </label>
        <label className="won-filter-field" style={{ flex: "1 1 132px", minWidth: 0 }}>
          <span>To</span>
          <input name="wonTo" type="date" defaultValue={end} max={today} required />
        </label>
      </>}
      <button className="secondary" type="submit">Apply report filters</button>
    </form>
  );
}

export function ReopenWonBatchButton({ ids, available }: { ids: string[]; available: number }) {
  const [notice, setNotice] = useState("");
  return <>
    <button className="secondary" type="button" disabled={!available} onClick={() => {
      const detail = { ids, opened: false };
      document.dispatchEvent(new CustomEvent("admin:reopen-won-batch", { detail }));
      setNotice(detail.opened ? "" : "Won Quotes is busy or still loading. Try again in a moment.");
    }}>
      {available === ids.length ? "Select this group" : "Select available quotes"}
    </button>
    {notice && <p role="status">{notice}</p>}
  </>;
}
