export type CertificateHistoryRange = "4w" | "3m" | "6m" | "1y" | "all";

export type CertificateHistoryRow = {
  id: number;
  effectiveWeek: string;
  observedAt: string;
  escSpotPrice: number;
  prcSpotPrice: number;
  source: string;
  observedByEmail: string;
};

export function sortCertificateHistory(rows: CertificateHistoryRow[]) {
  return [...rows].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
}

export function sydneyDate(value: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

export function certificateHistoryCutoff(range: CertificateHistoryRange, now = new Date()) {
  if (range === "all") return null;
  const [year, month, day] = sydneyDate(now).split("-").map(Number);
  const cutoff = new Date(Date.UTC(year, month - 1, day));
  if (range === "4w") {
    cutoff.setUTCDate(cutoff.getUTCDate() - 28);
    return cutoff.toISOString().slice(0, 10);
  }
  if (range === "3m" || range === "6m") {
    const months = range === "3m" ? 3 : 6;
    const targetMonth = cutoff.getUTCMonth() - months;
    const target = new Date(Date.UTC(cutoff.getUTCFullYear(), targetMonth, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(day, lastDay));
    return target.toISOString().slice(0, 10);
  }
  const targetYear = cutoff.getUTCFullYear() - 1;
  const lastDay = new Date(Date.UTC(targetYear, cutoff.getUTCMonth() + 1, 0)).getUTCDate();
  cutoff.setUTCFullYear(targetYear, cutoff.getUTCMonth(), Math.min(cutoff.getUTCDate(), lastDay));
  return cutoff.toISOString().slice(0, 10);
}

export function filterCertificateHistory(
  rows: CertificateHistoryRow[],
  range: CertificateHistoryRange,
  now = new Date(),
) {
  const cutoff = certificateHistoryCutoff(range, now);
  return cutoff ? rows.filter((row) => row.effectiveWeek >= cutoff) : [...rows];
}

export function certificateHistoryChartPoints(
  rows: CertificateHistoryRow[],
  metric: "escSpotPrice" | "prcSpotPrice",
  width: number,
  height: number,
  padding = { left: 56, right: 12, top: 12, bottom: 34 },
) {
  if (rows.length < 2) return [];
  const times = rows.map((row) => Date.parse(row.observedAt));
  const values = rows.map((row) => row[metric]);
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const valuePadding = Math.max((maxValue - minValue) * 0.15, maxValue * 0.02, 0.02);
  const yMin = Math.max(0, minValue - valuePadding);
  const yMax = maxValue + valuePadding;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  return rows.map((row, index) => ({
    x: maxTime === minTime
      ? padding.left + (plotWidth / 2)
      : padding.left + ((times[index] - minTime) / (maxTime - minTime)) * plotWidth,
    y: padding.top + ((yMax - values[index]) / (yMax - yMin || 1)) * plotHeight,
    value: values[index],
    date: row.observedAt,
    id: row.id,
  }));
}
