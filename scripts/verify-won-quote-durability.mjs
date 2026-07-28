import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const raw = await readFile(new URL("../app/calculator/raw/route.ts", import.meta.url), "utf8");
const ui = await readFile(new URL("../index.html", import.meta.url), "utf8");

const retentionFunction = ui.match(/function removeExpiredQuoteRows\(rows\)\{([\s\S]*?)\n\}/)?.[1] || "";
assert.ok(retentionFunction, "The stored quote-row normalizer must exist.");
assert.match(
  retentionFunction,
  /return Array\.isArray\(rows\)\?rows:\[\];/,
  "Saved quote systems must be retained until the user removes them.",
);
assert.doesNotMatch(
  retentionFunction,
  /Date\.now|SEVEN_DAYS|timestamp|recordQuoteSyncDeletions/,
  "Saved quote systems must not be deleted based on age.",
);
assert.doesNotMatch(ui, /Working quotes are stored for 7 days/i, "The UI must not promise seven-day retention.");

assert.match(
  raw,
  /window\.__calculatorFlushCloudSave = function\(timeoutMs\)/,
  "The calculator wrapper must expose an explicit cloud-save confirmation.",
);
assert.match(
  raw,
  /settleCloudSaveWaiters\(request\.json, null\)/,
  "A successful server save must resolve the matching confirmation.",
);
assert.match(
  raw,
  /error\.permanent = response\.status >= 400/,
  "Permanent server rejections must be distinguished from retryable failures.",
);
assert.match(
  raw,
  /settleCloudSaveWaiters\(request\.json, error\)/,
  "A permanent server rejection must reject the matching confirmation.",
);

const completeWon = ui.match(/async function completeOptionWon\(id,details\)\{([\s\S]*?)\n\}\nasync function confirmWonDetails/)?.[1] || "";
assert.ok(completeWon, "The durable won-quote workflow must exist.");
assert.match(
  completeWon,
  /await window\.__calculatorFlushCloudSave\(20000\)/,
  "Won quotes must wait for server persistence before reporting success.",
);
assert.match(
  completeWon,
  /marked as won and saved/,
  "The success message must describe a confirmed save.",
);
assert.match(
  completeWon,
  /restoreWonSaveSnapshot\(def,previousDef,rollbackUpdatedAt\)/,
  "A failed won save must roll the quote definition back.",
);
assert.match(
  completeWon,
  /Nothing was marked as won/,
  "A failed won save must clearly tell the user the action was not applied.",
);
assert.ok(
  completeWon.indexOf("await window.__calculatorFlushCloudSave(20000)") <
    completeWon.indexOf("marked as won and saved"),
  "The UI must not announce a won quote before the server confirms it.",
);

console.log("Won quote durability checks passed.");
