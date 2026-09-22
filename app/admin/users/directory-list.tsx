"use client";

import { useId, useState, type ReactNode } from "react";
import { matchesDirectorySearch, sortDirectory, type DirectoryRecord, type DirectorySort } from "../../../lib/admin-directory";
import styles from "./directory-list.module.css";

type DirectoryItem = DirectoryRecord & { content: ReactNode };

export default function DirectoryList({
  items, kind, className, defaultSort = "name-asc", activitySort = false,
}: {
  items: DirectoryItem[];
  kind: "businesses" | "users";
  className: string;
  defaultSort?: DirectorySort;
  activitySort?: boolean;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<DirectorySort>(defaultSort);
  const ordered = sortDirectory(items, sort);
  const visible = new Set(items.filter((item) => matchesDirectorySearch(item, query)).map((item) => item.id));

  return (
    <div className={styles.directory}>
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <label htmlFor={`${id}-search`}>Search {kind}</label>
          <input id={`${id}-search`} type="search" autoComplete="off" value={query}
            placeholder={kind === "users" ? "Name, email or business" : "Business name or state"}
            onChange={(event) => setQuery(event.target.value)} aria-controls={`${id}-results`} />
        </div>
        <div className={styles.sort}>
          <label htmlFor={`${id}-sort`}>Sort {kind} by</label>
          <select id={`${id}-sort`} value={sort} onChange={(event) => setSort(event.target.value as DirectorySort)}>
            <option value="name-asc">Name (A-Z)</option>
            <option value="name-desc">Name (Z-A)</option>
            <option value="newest">Newest added</option>
            <option value="oldest">Oldest added</option>
            {activitySort ? <option value="active-newest">Recently active</option> : null}
            {activitySort ? <option value="active-oldest">Least recently active</option> : null}
          </select>
        </div>
      </div>
      <p className={styles.count} role="status">{visible.size} of {items.length} {kind}</p>
      <div id={`${id}-results`} className={className}>
        {ordered.map((item) => (
          // Hide rather than unmount so filtering never discards an unsaved edit.
          <div key={item.id} className={styles.entry} hidden={!visible.has(item.id)}>
            {item.content}
          </div>
        ))}
      </div>
      {!visible.size ? <div className="empty-card">{items.length ? `No ${kind} match your search.` : `No ${kind} yet.`}</div> : null}
    </div>
  );
}
