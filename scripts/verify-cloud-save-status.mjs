import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const raw = await readFile(new URL("../app/calculator/raw/route.ts", import.meta.url), "utf8");
const ui = await readFile(new URL("../index.html", import.meta.url), "utf8");

assert.match(ui, /\.cloudSaveStatus\[data-tone="idle"\]\{opacity:0;visibility:hidden;/, "Idle save status must be hidden.");
assert.match(raw, /var saveRequestTimeoutMs = 12000;/, "Cloud saves must have a bounded request time.");
assert.match(raw, /controller\.abort\(\)/, "A stalled cloud save must be aborted.");
assert.match(raw, /fetchOptions\.signal = controller\.signal;/, "The cloud-save request must use the timeout signal.");
assert.match(raw, /inFlightSnapshotJson = request\.json;/, "The active snapshot must be tracked.");
assert.match(raw, /nextJson === inFlightSnapshotJson/, "Unchanged in-flight data must not be queued again.");
assert.match(raw, /setCloudSaveStatus\('Saving\.\.\.', 'saving'\);/, "An actual request must show Saving.");
assert.match(raw, /setCloudSaveStatus\('Retrying\.\.\.', 'retrying'\);/, "A failed or timed-out request must show Retrying.");
assert.match(raw, /setCloudSaveStatus\(pendingSnapshot \? 'Saving\.\.\.' : 'Saved'/, "A successful request must show Saved.");
assert.match(raw, /if \(nextTone === 'saved'\)[\s\S]*?\}, 1800\);/, "Saved confirmation must hide automatically.");

const scheduleSync = raw.match(/function scheduleSync\(force\)\{([\s\S]*?)\n  \}/)?.[1] || "";
assert.ok(scheduleSync, "scheduleSync must exist.");
assert.doesNotMatch(scheduleSync, /setCloudSaveStatus/, "Input events must not claim a save started before a changed snapshot exists.");

assert.match(raw, /setCloudSaveStatus\('', 'idle'\)/, "The badge must initialize hidden instead of permanently showing Saved.");

console.log("cloud save status checks passed");
