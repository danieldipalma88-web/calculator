import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchesDirectorySearch, sortDirectory } from "../lib/admin-directory.ts";

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

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const component = read("app/admin/users/directory-list.tsx");
assert.match(component, /hidden=\{!visible\.has\(item\.id\)\}/, "Hidden edits must stay mounted");
assert.match(component, /key=\{item\.id\}/, "Sorting must preserve each row identity");
assert.doesNotMatch(component, /fetch\(|router\.|requestSubmit|<form/, "Directory search must remain local and must not submit an admin form");
const page = read("app/admin/users/page.tsx");
assert.match(page, /lastActiveAt: approvedUser\.last_active_at/);
assert.match(page, /const \{ supabase, email: currentEmail \} = await requireAdmin\(\)/);
const assignment = read("app/admin/users/business-multi-select.tsx");
assert.match(assignment, /businesses\.map\(\(business\) =>/);
assert.doesNotMatch(assignment, /businesses\.filter\(.*\)\.map/, "Filtering must not drop selected checkbox form values");
assert.match(assignment, /event\.key === "Enter"\) event\.preventDefault\(\)/);
console.log("Admin directory search, sorting and draft-preservation guards passed.");
