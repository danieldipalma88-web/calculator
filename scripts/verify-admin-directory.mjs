import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { activityLabel, directoryView, exactSydneyDate, filterDirectoryActivity, matchesDirectorySearch, snapshotDirectoryView, sortDirectory } from "../lib/admin-directory.ts";

const rows = [
  { id: "b", name: "Beth Jones", searchText: "beth@example.test Green Energy Climate Control", createdAt: "2026-03-01", lastActiveAt: "2026-09-01T09:00:00Z" },
  { id: "a", name: "Alex Smith", searchText: "alex@example.test Sheer Comfort", createdAt: "2026-01-01", lastActiveAt: "2026-09-21T09:00:00Z" },
  { id: "c", name: "Chloe", searchText: "chloe@example.test LCN", createdAt: "2026-04-01", lastActiveAt: null },
  { id: "d", name: "Daniel", searchText: "daniel@example.test", createdAt: "invalid", lastActiveAt: "invalid" },
];
const ids = (sort) => sortDirectory(rows, sort).map(row => row.id);
assert.deepEqual(ids("name-asc"), ["a", "b", "c", "d"]);
assert.deepEqual(ids("name-desc"), ["d", "c", "b", "a"]);
assert.deepEqual(ids("newest"), ["c", "b", "a", "d"]);
assert.deepEqual(ids("oldest"), ["a", "b", "c", "d"]);
assert.deepEqual(ids("active-newest"), ["a", "b", "c", "d"]);
assert.deepEqual(ids("active-oldest"), ["b", "a", "c", "d"]);
assert.deepEqual(rows.map(row => row.id), ["b", "a", "c", "d"], "Sorting must not mutate loaded data");
assert.equal(matchesDirectorySearch(rows[0], " CLIMATE   beth "), true);
assert.equal(matchesDirectorySearch(rows[1], "ALEX@EXAMPLE"), true);
assert.equal(matchesDirectorySearch(rows[0], "Sheer"), false);
assert.equal(matchesDirectorySearch(rows[2], "  "), true);
assert.equal(matchesDirectorySearch({ ...rows[2], name: "Chloé" }, "chloe"), true);
assert.equal(sortDirectory([{ ...rows[0], id: "z", name: "Beth Jones" }, rows[0]], "active-newest")[0].id, "b", "Tied dates have a deterministic order");

const fixedNow = Date.parse("2026-10-02T03:00:00Z"); // 1:00 pm in Sydney
const activityRows = [
  { ...rows[0], id: "today", lastActiveAt: "2026-10-01T14:00:00Z" },
  { ...rows[0], id: "week", lastActiveAt: "2026-09-28T02:00:00Z" },
  { ...rows[0], id: "inactive", lastActiveAt: "2026-08-30T02:00:00Z" },
  { ...rows[0], id: "unknown", lastActiveAt: null },
];
const filteredIds = (filter) => filterDirectoryActivity(activityRows, filter, fixedNow).map(row => row.id);
assert.deepEqual(filteredIds("today"), ["today"], "Today uses Sydney calendar boundaries");
assert.deepEqual(filteredIds("week"), ["today", "week"], "Last 7 days excludes older and unknown activity");
assert.deepEqual(filteredIds("inactive"), ["inactive"]);
assert.deepEqual(filteredIds("unknown"), ["unknown"]);
const activityView = directoryView(activityRows, "name-asc", "", "inactive", fixedNow);
assert.deepEqual(activityView.ids, ["inactive", "today", "unknown", "week"], "Activity filtering retains every row in its render order");
assert.deepEqual(activityView.visible, ["inactive"], "Only qualifying activity rows are visible");
const searchView = directoryView(rows, "name-asc", "alex", "all", fixedNow);
assert.deepEqual(searchView.ids, ["a", "b", "c", "d"], "Search filtering never removes mounted row IDs");
assert.deepEqual(searchView.visible, ["a"]);
const refreshedSnapshot = snapshotDirectoryView(searchView);
assert.deepEqual(refreshedSnapshot, { ids: ["a", "b", "c", "d"], visible: ["a"] }, "A refreshed snapshot uses the post-change query result");
refreshedSnapshot.visible.length = 0;
assert.deepEqual(searchView.visible, ["a"], "Snapshots do not mutate the live view");
assert.equal(activityLabel("2026-10-02T01:50:00Z", fixedNow).tone, "active", "Activity under 24 hours is green");
assert.deepEqual(activityLabel("2026-10-01T01:00:00Z", fixedNow), { text: "Active yesterday", tone: "neutral" });
assert.equal(activityLabel(null, fixedNow).text, "No activity recorded");
assert.equal(activityLabel("invalid", fixedNow).tone, "unknown");
assert.match(exactSydneyDate("2026-10-02T03:00:00Z"), /1:00:00 pm/);

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const component = read("app/admin/users/directory-list.tsx");
assert.match(component, /hidden=\{!visibleIds\.has\(itemId\)\}/, "Hidden edits must stay mounted with constant-time visibility checks");
assert.match(component, /key=\{itemId\}/, "Sorting must preserve each row identity");
assert.doesNotMatch(component, /router\.|requestSubmit|<form/, "Directory controls must not submit an admin forms");
assert.match(component, /useState\(\"\"\)/, "Preference state must be deterministic during SSR and hydration");
assert.match(component, /loadedPrefix === prefix/, "Stored values must load before writes begin");
assert.match(component, /new MutationObserver\(checkVisibility\)/, "Activity polling must react promptly to panel visibility");
assert.match(component, /if \(hasExpandedUser\(\) \|\| \(activeInResults && !activityFocus\)\) return;/, "Expanded and editable records retain snapshots, while activity-only focus can release them");
assert.match(component, /Most recently active/, "Activity sort label must describe the direction");
assert.match(component, /const view = useMemo\(\(\) => directoryView\(/, "Search and activity filters produce a memoized visibility set");
assert.match(component, /displayed\.ids\.map\(\(itemId\)/, "Every directory record stays mounted across filters");
assert.match(component, /snapshot\.current = snapshotDirectoryView\(currentView\.current\)/, "Explicit changes refresh snapshots from the current rendered view");
assert.match(component, /snapshotCriteria\.current === criteria \? snapshot\.current : view/, "An older edit snapshot cannot override newer explicit search or filter criteria");
assert.doesNotMatch(component, /setTimeout\(\(\) => \{ if \(hasExpandedUser\(\)\) engage\(\)/, "Freeze refresh must not capture stale rendered IDs");
assert.doesNotMatch(component, /now \|\| Date\.now\(\)|Date\.now\(\)\s*\}/, "Render output must not use a nondeterministic clock");
const activityComponent = read("app/admin/users/user-activity.tsx");
const activityStyles = read("app/admin/users/user-activity.module.css");
assert.match(activityComponent, /<button type="button" aria-expanded=\{expanded\} aria-controls=/, "Activity timestamp control must be an accessible button");
assert.match(activityComponent, /event\.stopPropagation\(\)/, "Activity button events must not toggle the parent summary");
assert.match(activityComponent, /<time id=.*hidden=\{!expanded\}/, "Exact time must expand inline within the clipped card");
assert.doesNotMatch(activityComponent, /<details|<summary/, "Activity must not nest disclosure elements in the user summary");
for (const tone of ["active", "neutral", "stale", "unknown"]) {
  assert.match(activityStyles, new RegExp(`:global\\(\\.user-summary-identity\\) \.activity\\.${tone} \\{ color:`), `The ${tone} label tone must override the summary muted text`);
}
assert.match(component, /!target\.closest\("\[data-directory-activity\]"\)/, "Activity controls must not engage the edit freeze");
assert.match(activityComponent, /data-directory-activity/, "Activity exclusion must work with hashed CSS-module classes");
assert.match(component, /const provider = useMemo<ActivityContextValue>/, "Typing must not invalidate every activity consumer");
assert.match(component, /const onRemoved = useCallback/, "Typing must not invalidate every removal control");
const page = read("app/admin/users/page.tsx");
assert.match(page, /lastActiveAt: approvedUser\.last_active_at/);
assert.match(page, /const \{ supabase, email: currentEmail \} = await requireAdmin\(\)/);
const assignment = read("app/admin/users/business-multi-select.tsx");
assert.match(assignment, /businesses\.map\(\(business\) =>/);
assert.doesNotMatch(assignment, /businesses\.filter\(matches\)/, "Search filtering must not drop selected checkbox form values");
assert.match(assignment, /!hasOpened \? businesses\.filter\(\(business\) => selected\.includes\(business\.id\)\)/, "Unopened menus must preserve the original checkbox submission order");
assert.match(assignment, /if \(detailsRef\.current\?\.open\) setHasOpened\(true\)/, "A picker opened before hydration must populate without another click");
assert.match(assignment, /hasOpened \? <div className="business-multiselect-menu"/, "Build assignment options only when first opened");
assert.doesNotMatch(assignment, /setHasOpened\(false\)/, "Opened menus must retain checkbox and search state when closed");
assert.match(assignment, /event\.key === "Enter"\) event\.preventDefault\(\)/);
console.log("Admin directory search, sorting and draft-preservation guards passed.");
