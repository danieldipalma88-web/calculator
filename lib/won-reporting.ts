export const WON_MONEY_METRICS = [
  ["salespersonCommissionTotal", "Salesperson commission earned"],
  ["agencyCommissionTotal", "Agency gross commission inc GST"],
  ["agencyProfitAfterSalesTotal", "Agency profit after commission inc GST"],
  ["installerProfitTotal", "Installer profit ex GST"],
  ["customerTotal", "Customer revenue inc GST"],
] as const;

type MoneyMetric = typeof WON_MONEY_METRICS[number][0];
export type WonReportAmounts = Record<MoneyMetric, number | null>;
export type WonReportJob = {
  userEmail: string;
  wonAt: string;
  reportAmounts: WonReportAmounts;
};
type DateRange = { start: string; end: string };
export type WonReportPreset = "last-week" | "last-month" | "custom";
export type WonReportPerson = { email: string; name: string };

const DAY_MS = 86400000;
const sydneyDate = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
});

function calendarDay(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time / DAY_MS : null;
}

function dateString(day: number) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function monday(day: number) {
  return day - (new Date(day * DAY_MS).getUTCDay() + 6) % 7;
}

export function wonSydneyDate(value: string) {
  if (calendarDay(value) !== null) return value;
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/i.test(value)
      || calendarDay(value.slice(0, 10)) === null) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const parts = sydneyDate.formatToParts(time);
  return ["year", "month", "day"].map((part) => parts.find((item) => item.type === part)?.value).join("-");
}

export function wonReportRange(preset: WonReportPreset, today: string, from = "", to = "") {
  const day = calendarDay(today);
  if (day === null) return null;
  if (preset === "last-week") {
    const currentMonday = monday(day);
    return { start: dateString(currentMonday - 7), end: dateString(currentMonday - 1) };
  }
  if (preset === "last-month") {
    const monthStart = calendarDay(`${today.slice(0, 7)}-01`)!;
    const end = dateString(monthStart - 1);
    return { start: `${end.slice(0, 7)}-01`, end };
  }
  const start = calendarDay(from);
  const end = calendarDay(to);
  return start !== null && end !== null && end >= start && end <= day && end - start < 366
    ? { start: from, end: to }
    : null;
}

export function isStoredWonAmount(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())
    && Number.isFinite(Number(value));
}

// The legacy Won Quote totals are unchanged. Missing source fields only affect
// completeness of the new report and selected summaries.
export function wonReportAmounts(totals: Record<MoneyMetric, number>, rows: Record<string, unknown>[]): WonReportAmounts {
  const agency = (row: Record<string, unknown>) => row.agencyCommissionInc ?? row.commissionInc;
  const sources: Record<MoneyMetric, (row: Record<string, unknown>) => boolean> = {
    customerTotal: (row) => isStoredWonAmount(row.finalInc),
    agencyCommissionTotal: (row) => isStoredWonAmount(agency(row)),
    salespersonCommissionTotal: (row) => isStoredWonAmount(row.salespersonCommissionInc),
    agencyProfitAfterSalesTotal: (row) => isStoredWonAmount(agency(row)) && isStoredWonAmount(row.salespersonCommissionInc),
    installerProfitTotal: (row) => isStoredWonAmount(row.netProfit),
  };
  return Object.fromEntries(WON_MONEY_METRICS.map(([key]) => [
    key, rows.length && rows.every(sources[key]) && Number.isFinite(totals[key]) ? totals[key] : null,
  ])) as WonReportAmounts;
}

export function isWonReportDefaultPerson(name: string) {
  return name.trim().replace(/\s+/g, " ").toLowerCase() === "daniel parisotto";
}

export function wonReportPerson(people: WonReportPerson[], requested?: string) {
  if (requested !== undefined) return typeof requested === "string"
    ? people.find((person) => person.email === requested.toLowerCase())?.email || ""
    : "";
  const matches = people.filter(({ name }) => isWonReportDefaultPerson(name));
  return matches.length === 1 ? matches[0].email : "";
}

function emptyTotals() {
  return {
    count: 0,
    money: Object.fromEntries(WON_MONEY_METRICS.map(([key]) => [key, { total: 0, missing: 0 }])) as
      Record<MoneyMetric, { total: number; missing: number }>,
  };
}

type Totals = ReturnType<typeof emptyTotals>;

function addJob(totals: Totals, job: WonReportJob) {
  totals.count += 1;
  for (const [key] of WON_MONEY_METRICS) {
    const value = job.reportAmounts[key];
    if (value === null || !Number.isFinite(value)) totals.money[key].missing += 1;
    else totals.money[key].total += value;
  }
}

export function summarizeWonReport(jobs: WonReportJob[], email: string, range: DateRange) {
  const start = calendarDay(range.start);
  const end = calendarDay(range.end);
  if (!email || start === null || end === null || end < start || end - start >= 366) return null;
  const byDay = new Map<number, WonReportJob[]>();
  const totals = emptyTotals();
  let invalidDates = 0;
  for (const job of jobs) {
    if (job.userEmail.toLowerCase() !== email.toLowerCase()) continue;
    const date = wonSydneyDate(job.wonAt);
    if (date === null) { invalidDates += 1; continue; }
    const day = calendarDay(date);
    if (day === null || day < start - 7 || day > end) continue;
    const group = byDay.get(day);
    if (group) group.push(job);
    else byDay.set(day, [job]);
    if (day >= start) addJob(totals, job);
  }

  const weeks = [];
  for (let week = monday(start); week <= end; week += 7) {
    const first = Math.max(week, start);
    const last = Math.min(week + 6, end);
    const current = emptyTotals();
    const previous = emptyTotals();
    for (let day = first; day <= last; day += 1) {
      for (const job of byDay.get(day) || []) addJob(current, job);
      for (const job of byDay.get(day - 7) || []) addJob(previous, job);
    }
    weeks.push({
      start: dateString(first), end: dateString(last),
      previousStart: dateString(first - 7), previousEnd: dateString(last - 7),
      current, previous,
    });
  }
  return { totals, weeks, invalidDates };
}
