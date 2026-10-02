"use client";

import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { directoryView, snapshotDirectoryView, type ActivityFilter, type DirectoryRecord, type DirectorySort, type DirectoryView } from "../../../lib/admin-directory";
import styles from "./directory-list.module.css";

type DirectoryItem = DirectoryRecord & { content: ReactNode };
type ActivityContextValue = { getActivity: (email: string, initial: string | null | undefined) => string | null | undefined; now: number | null };
const ActivityContext = createContext<ActivityContextValue>({ getActivity: (_email, initial) => initial, now: 0 });
const UserRemovalContext = createContext<(email: string) => void>(() => {});
export function useUserRemoval() { return useContext(UserRemovalContext); }
export function useDirectoryActivity(email: string, initial: string | null | undefined) {
  const context = useContext(ActivityContext);
  return { lastActiveAt: context.getActivity(email, initial), now: context.now };
}

function readStored(key: string, fallback: string) {
  try { return sessionStorage.getItem(key) || fallback; } catch { return fallback; }
}
function writeStored(key: string, value: string) {
  try { sessionStorage.setItem(key, value); } catch { /* Storage can be disabled by the browser. */ }
}

export default function DirectoryList({
  items, kind, className, defaultSort = "name-asc", activitySort = false, storageScope = "default",
}: {
  items: DirectoryItem[];
  kind: "businesses" | "users";
  className: string;
  defaultSort?: DirectorySort;
  activitySort?: boolean;
  storageScope?: string;
}) {
  const id = useId();
  const prefix = `admin-directory:${storageScope}:${kind}:`;
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<DirectorySort>(defaultSort);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [loadedPrefix, setLoadedPrefix] = useState<string | null>(null);
  const [activity, setActivity] = useState<Record<string, string | null>>({});
  const [now, setNow] = useState<number | null>(null);
  const [removed, setRemoved] = useState<string[]>([]);
  const [removalNotice, setRemovalNotice] = useState("");
  const [locked, setLocked] = useState(false);
  const lockedRef = useRef(false);
  const snapshot = useRef<DirectoryView | null>(null);
  const currentView = useRef<DirectoryView>({ ids: [], visible: [] });
  const pendingSnapshotRefresh = useRef(false);
  const activityRef = useRef(activity);

  useEffect(() => {
    setQuery(readStored(prefix + "search", ""));
    setSort(readStored(prefix + "sort", defaultSort) as DirectorySort);
    setActivityFilter(readStored(prefix + "activity", "all") as ActivityFilter);
    setLoadedPrefix(prefix);
  }, [prefix, defaultSort]);
  useEffect(() => { if (loadedPrefix === prefix) writeStored(prefix + "search", query); }, [prefix, query, loadedPrefix]);
  useEffect(() => { if (loadedPrefix === prefix) writeStored(prefix + "sort", sort); }, [prefix, sort, loadedPrefix]);
  useEffect(() => { if (loadedPrefix === prefix) writeStored(prefix + "activity", activityFilter); }, [prefix, activityFilter, loadedPrefix]);
  useEffect(() => { activityRef.current = activity; }, [activity]);
  useEffect(() => {
    // A new server snapshot can include an account that has been added again.
    setRemoved((previous) => previous.length ? [] : previous);
  }, [items]);
  useEffect(() => {
    if (kind !== "users") return;
    let disposed = false;
    let controller: AbortController | null = null;
    const panel = document.querySelector<HTMLElement>('[data-admin-panel="users"]');
    const panelVisible = () => {
      return !document.hidden && (!panel || !panel.hidden);
    };
    const refresh = async () => {
      if (!panelVisible() || controller) return;
      controller = new AbortController();
      const timer = window.setTimeout(() => controller?.abort(), 12000);
      try {
        const response = await fetch("/api/admin/user-activity", { method: "GET", cache: "no-store", credentials: "same-origin", signal: controller.signal });
        if (!response.ok) return;
        const payload = await response.json() as { activity?: { email: string; last_active_at: string | null }[] };
        if (disposed || !Array.isArray(payload.activity)) return;
        const next = { ...activityRef.current };
        for (const row of payload.activity) if (row.email) next[row.email.toLowerCase()] = row.last_active_at;
        activityRef.current = next;
        setActivity(next);
      } catch { /* Preserve the last known activity when the read endpoint is unavailable. */ }
      finally { window.clearTimeout(timer); controller = null; }
    };
    const timer = window.setInterval(() => { void refresh(); }, 60000);
    const tick = window.setInterval(() => { if (panelVisible()) setNow(Date.now()); }, 30000);
    let wasVisible = panelVisible();
    const checkVisibility = () => {
      const visible = panelVisible();
      if (visible && !wasVisible) void refresh();
      if (visible) setNow(Date.now());
      wasVisible = visible;
    };
    const observer = new MutationObserver(checkVisibility);
    if (panel) observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
    document.addEventListener("visibilitychange", checkVisibility);
    void refresh();
    setNow(Date.now());
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(timer);
      window.clearInterval(tick);
      observer.disconnect();
      document.removeEventListener("visibilitychange", checkVisibility);
    };
  }, [kind]);

  const currentActivityItems = useMemo(() => items.filter((item) => !removed.includes(item.id.toLowerCase())).map((item) => kind === "users"
    ? { ...item, lastActiveAt: Object.prototype.hasOwnProperty.call(activity, item.id.toLowerCase()) ? activity[item.id.toLowerCase()] : item.lastActiveAt }
    : item), [items, activity, kind, removed]);
  const view = directoryView(currentActivityItems, sort, query, activityFilter, now ?? 0);
  currentView.current = view;
  if (!locked && snapshot.current) snapshot.current = null;
  const stableView = locked && snapshot.current ? snapshot.current : view;
  const byId = new Map(currentActivityItems.map((item) => [item.id, item]));
  const displayed = { ids: stableView.ids.filter((itemId) => byId.has(itemId)), visible: stableView.visible.filter((itemId) => byId.has(itemId)) };

  function hasExpandedUser() {
    return kind === "users" && document.querySelector(`#${CSS.escape(id)}-results .user-card-collapsible[open]`) !== null;
  }
  function unlockForExplicitChange() {
    lockedRef.current = false;
    snapshot.current = null;
    setLocked(false);
    pendingSnapshotRefresh.current = true;
  }
  function engage() {
    if (!lockedRef.current) {
      snapshot.current = snapshotDirectoryView(currentView.current);
      lockedRef.current = true;
      setLocked(true);
    }
  }
  function release() {
    window.setTimeout(() => {
      if (hasExpandedUser() || (document.activeElement instanceof HTMLElement && document.activeElement.closest(`#${CSS.escape(id)}-results`))) return;
      lockedRef.current = false;
      setLocked(false);
    }, 0);
  }
  useEffect(() => {
    if (!pendingSnapshotRefresh.current) return;
    pendingSnapshotRefresh.current = false;
    const activeInResults = document.activeElement instanceof HTMLElement
      && document.activeElement.closest(`#${CSS.escape(id)}-results`);
    if (!hasExpandedUser() && !activeInResults) return;
    snapshot.current = snapshotDirectoryView(currentView.current);
    lockedRef.current = true;
    setLocked(true);
  });

  const provider: ActivityContextValue = {
    getActivity: (email, initial) => Object.prototype.hasOwnProperty.call(activity, email.toLowerCase()) ? activity[email.toLowerCase()] : initial,
    now,
  };
  return (
    <UserRemovalContext.Provider value={(email) => {
      setRemoved((previous) => [...new Set([...previous, email.toLowerCase()])]);
      setRemovalNotice(`Calculator access removed for ${email}. Saved quotes and payment records are unchanged.`);
    }}><ActivityContext.Provider value={provider}>
      <div className={styles.directory} onFocusCapture={(event) => {
        if (!(event.target as HTMLElement).closest(".activity")) engage();
      }} onBlurCapture={release} onClickCapture={(event) => {
        const target = event.target as HTMLElement;
        if (!target.closest(".activity") && target.closest(".user-card-collapsible > summary")) engage();
      }}>
        <div className={styles.toolbar}>
          <div className={styles.search}>
            <label htmlFor={`${id}-search`}>Search {kind}</label>
            <div className={styles.searchControl}>
              <input id={`${id}-search`} type="search" autoComplete="off" value={query}
                placeholder={kind === "users" ? "Name, email or business" : "Business name or state"}
                onChange={(event) => { unlockForExplicitChange(); setQuery(event.target.value); }} aria-controls={`${id}-results`} />
              {query ? <button type="button" aria-label={`Clear ${kind} search`} onClick={() => { unlockForExplicitChange(); setQuery(""); }}>Clear</button> : null}
            </div>
          </div>
          <div className={styles.sort}>
            <label htmlFor={`${id}-sort`}>Sort {kind} by</label>
            <select id={`${id}-sort`} value={sort} onChange={(event) => { unlockForExplicitChange(); setSort(event.target.value as DirectorySort); }}>
              <option value="name-asc">Name (A-Z)</option><option value="name-desc">Name (Z-A)</option>
              <option value="newest">Newest added</option><option value="oldest">Oldest added</option>
              {activitySort ? <><option value="active-newest">Most recently active</option><option value="active-oldest">Least recently active</option></> : null}
            </select>
          </div>
        </div>
        {kind === "users" ? <div className={styles.filters} role="group" aria-label="Filter users by activity">
          {([ ["all", "All"], ["today", "Active today"], ["week", "Last 7 days"], ["inactive", "Inactive 30+ days"], ["unknown", "No activity recorded"] ] as [ActivityFilter, string][]).map(([value, label]) =>
            <button key={value} type="button" aria-pressed={activityFilter === value} onClick={() => { unlockForExplicitChange(); setActivityFilter(value); }}>{label}</button>)}
        </div> : null}
        {removalNotice && <p className="notice success" role="status">{removalNotice}</p>}
        <p className={styles.count} role="status">{displayed.visible.length} of {currentActivityItems.length} {kind}</p>
        <div id={`${id}-results`} className={className}>
          {displayed.ids.map((itemId) => {
            const item = byId.get(itemId);
            return item ? <div key={itemId} className={styles.entry} hidden={!displayed.visible.includes(itemId)}>{item.content}</div> : null;
          })}
        </div>
        {!displayed.visible.length ? <div className="empty-card">{currentActivityItems.length ? `No ${kind} match the current filters.` : `No ${kind} yet.`}</div> : null}
      </div>
    </ActivityContext.Provider></UserRemovalContext.Provider>
  );
}
