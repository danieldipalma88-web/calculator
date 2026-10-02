"use client";

import type { CertificateHistoryRange } from "../../../lib/certificate-history";

const OPTIONS: { value: CertificateHistoryRange; label: string }[] = [
  { value: "4w", label: "Last 4 weeks" },
  { value: "3m", label: "Last 3 months" },
  { value: "6m", label: "Last 6 months" },
  { value: "1y", label: "Last year" },
  { value: "all", label: "All time" },
];

export default function CertificateHistoryRangeSelect({
  value,
  onChange,
}: {
  value: CertificateHistoryRange;
  onChange: (value: CertificateHistoryRange) => void;
}) {
  return (
    <label className="certificate-history-range">
      <span>Time range</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as CertificateHistoryRange)}
      >
        {OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}
