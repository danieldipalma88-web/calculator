export type DirectoryRecord = {
  id: string;
  name: string;
  searchText: string;
  createdAt?: string | null;
  lastActiveAt?: string | null;
};

export type DirectorySort = "name-asc" | "name-desc" | "newest" | "oldest" | "active-newest" | "active-oldest";
export type ActivityFilter = "all" | "today" | "week" | "inactive" | "unknown";

function normalized(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en-AU").trim();
}

export function matchesDirectorySearch(record: DirectoryRecord, query: string) {
  const text = normalized(`${record.name} ${record.searchText}`);
  return normalized(query).split(/\s+/).every((term) => text.includes(term));
}

function timestamp(value: string | null | undefined) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function sortDirectory<T extends DirectoryRecord>(records: T[], sort: DirectorySort): T[] {
  return [...records].sort((a, b) => {
    const byName = a.name.localeCompare(b.name, "en-AU", { sensitivity: "base", numeric: true })
      || a.id.localeCompare(b.id, "en-AU");
    if (sort === "name-asc") return byName;
    if (sort === "name-desc") return -byName;
    const active = sort === "active-newest" || sort === "active-oldest";
    const left = timestamp(active ? a.lastActiveAt : a.createdAt);
    const right = timestamp(active ? b.lastActiveAt : b.createdAt);
    // Unknown activity is not an old login; keep it after dated records in either direction.
    if (left === null || right === null) {
      if (left === right) return byName;
      return left === null ? 1 : -1;
    }
    const oldestFirst = sort === "oldest" || sort === "active-oldest";
    return (oldestFirst ? left - right : right - left) || byName;
  });
}

export function filterDirectoryActivity<T extends DirectoryRecord>(records: T[], filter: ActivityFilter, now = Date.now()): T[] {
  if (filter === "all") return records;
  return records.filter((record) => {
    const active = timestamp(record.lastActiveAt);
    if (filter === "unknown") return active === null;
    if (active === null) return false;
    const elapsed = now - active;
    if (filter === "today") {
      const today = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", year: "numeric", month: "numeric", day: "numeric" }).format(now);
      const date = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", year: "numeric", month: "numeric", day: "numeric" }).format(active);
      return today === date;
    }
    if (filter === "week") return elapsed >= 0 && elapsed < 7 * 86400000;
    return elapsed >= 30 * 86400000;
  });
}

export type DirectoryView = { ids: string[]; visible: string[] };

export function directoryView<T extends DirectoryRecord>(
  records: T[], sort: DirectorySort, query: string, activityFilter: ActivityFilter, now: number,
): DirectoryView {
  const ordered = sortDirectory(records, sort);
  const activityMatched = filterDirectoryActivity(ordered, activityFilter, now);
  return {
    ids: ordered.map((record) => record.id),
    visible: activityMatched.filter((record) => matchesDirectorySearch(record, query)).map((record) => record.id),
  };
}

export function snapshotDirectoryView(view: DirectoryView): DirectoryView {
  return { ids: [...view.ids], visible: [...view.visible] };
}

export function activityLabel(value: string | null | undefined, now = Date.now()) {
  const active = timestamp(value);
  if (active === null) return { text: "No activity recorded", tone: "unknown" as const };
  const elapsed = Math.max(0, now - active);
  if (elapsed < 60000) return { text: "Active just now", tone: "active" as const };
  if (elapsed < 3600000) return { text: `Active ${Math.floor(elapsed / 60000)} minutes ago`, tone: "active" as const };
  if (elapsed < 86400000) return { text: `Active ${Math.floor(elapsed / 3600000)} hours ago`, tone: "active" as const };
  const dayKey = (date: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const [year, month, day] = dayKey(now).split("-").map(Number);
  const [activeYear, activeMonth, activeDay] = dayKey(active).split("-").map(Number);
  const calendarDays = Math.round((Date.UTC(year, month - 1, day) - Date.UTC(activeYear, activeMonth - 1, activeDay)) / 86400000);
  if (calendarDays === 1) return { text: "Active yesterday", tone: "neutral" as const };
  if (elapsed < 30 * 86400000) return { text: `Active ${Math.floor(elapsed / 86400000)} days ago`, tone: "neutral" as const };
  return { text: `Active ${Math.floor(elapsed / 86400000)} days ago`, tone: "stale" as const };
}

export function exactSydneyDate(value: string | null | undefined) {
  const active = timestamp(value);
  return active === null ? "No activity recorded" : new Intl.DateTimeFormat("en-AU", {
    dateStyle: "full", timeStyle: "long", timeZone: "Australia/Sydney",
  }).format(active);
}
