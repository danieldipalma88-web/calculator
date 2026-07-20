import assert from "node:assert/strict";
import {
  mergeCalculatorData,
  QUOTE_SYNC_TOMBSTONES_STORAGE_KEY,
} from "../lib/quote-sync.ts";

const rowsKey = "installerMasterQuoteLogV1";
const optionsKey = "installerQuoteOptionDefsV1";
const stored = (value) => JSON.stringify(value);
const parsed = (data, key) => JSON.parse(data[key]);

const original = {
  [rowsKey]: stored([
    { id: "system-a", timestamp: 100, syncUpdatedAt: 100, model: "A" },
    { id: "system-b", timestamp: 110, syncUpdatedAt: 110, model: "B" },
  ]),
  [optionsKey]: stored([{ id: "quote-eric", name: "Eric Liu", syncUpdatedAt: 100 }]),
};

const staleMissingSystem = {
  [rowsKey]: stored([{ id: "system-a", timestamp: 100, syncUpdatedAt: 100, model: "A" }]),
  [optionsKey]: stored([{ id: "quote-eric", name: "Eric Liu", syncUpdatedAt: 100 }]),
};
const protectedMerge = mergeCalculatorData(original, staleMissingSystem);
assert.deepEqual(
  parsed(protectedMerge, rowsKey).map((row) => row.id),
  ["system-a", "system-b"],
  "A stale snapshot must not remove an existing system.",
);

const staleEdit = mergeCalculatorData(original, {
  [rowsKey]: stored([{ id: "system-a", timestamp: 100, syncUpdatedAt: 90, model: "OLD" }]),
});
assert.equal(parsed(staleEdit, rowsKey)[0].model, "A", "An older row cannot overwrite a newer row.");

const freshEdit = mergeCalculatorData(original, {
  [rowsKey]: stored([{ id: "system-a", timestamp: 100, syncUpdatedAt: 120, model: "NEW" }]),
});
assert.equal(parsed(freshEdit, rowsKey)[0].model, "NEW", "A newer row edit must be accepted.");
assert.equal(parsed(freshEdit, rowsKey).length, 2, "A row edit must retain unrelated systems.");

const intentionalDelete = mergeCalculatorData(original, {
  [rowsKey]: stored([{ id: "system-a", timestamp: 100, syncUpdatedAt: 100, model: "A" }]),
  [QUOTE_SYNC_TOMBSTONES_STORAGE_KEY]: stored({ rows: { "system-b": 200 }, options: {} }),
});
assert.deepEqual(
  parsed(intentionalDelete, rowsKey).map((row) => row.id),
  ["system-a"],
  "A deletion tombstone must remove the selected system.",
);

const intentionalQuoteDelete = mergeCalculatorData(original, {
  [optionsKey]: stored([]),
  [QUOTE_SYNC_TOMBSTONES_STORAGE_KEY]: stored({ rows: {}, options: { "quote-eric": 200 } }),
});
assert.equal(parsed(intentionalQuoteDelete, optionsKey).length, 0, "A quote tombstone must remove its definition.");

const recreatedAfterDelete = mergeCalculatorData(intentionalDelete, {
  [rowsKey]: stored([{ id: "system-b", timestamp: 300, syncUpdatedAt: 300, model: "B2" }]),
});
assert.equal(parsed(recreatedAfterDelete, rowsKey).find((row) => row.id === "system-b")?.model, "B2");

console.log("Quote sync safety checks passed.");
