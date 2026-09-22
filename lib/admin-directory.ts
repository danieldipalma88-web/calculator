export type DirectoryRecord = {
  id: string;
  name: string;
  searchText: string;
  createdAt?: string | null;
  lastActiveAt?: string | null;
};

export type DirectorySort = "name-asc" | "name-desc" | "newest" | "oldest" | "active-newest" | "active-oldest";

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
