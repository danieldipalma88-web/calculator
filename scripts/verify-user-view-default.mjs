import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../app/calculator/page.tsx", import.meta.url), "utf8");
const checks = [
  ["const isPreviewingAsAdmin = isViewingAnotherUser && params?.admin === \"1\";", "explicit admin preview mode"],
  ["const isPreviewingAsUser = isViewingAnotherUser && !isPreviewingAsAdmin;", "user view default"],
  ['isPreviewingAsUser ? "&preview=1" : ""', "restricted raw calculator view"],
  ["&admin=1", "admin preview link"],
  ['...(isPreviewingAsAdmin ? [{ name: "admin", value: "1" }] : [])', "admin mode preserved during business switching"],
];

const missing = checks.filter(([needle]) => !source.includes(needle));
if (missing.length) {
  for (const [, label] of missing) console.error(`Missing ${label}.`);
  process.exit(1);
}

console.log("user view default checks passed");
