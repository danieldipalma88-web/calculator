import assert from "node:assert/strict";
import { validateNewWonJobTransitions } from "../lib/won-job-validation.ts";

const optionsKey = "installerQuoteOptionDefsV1";
const rowsKey = "installerMasterQuoteLogV1";
const stored = (value) => JSON.stringify(value);

function snapshot(option, rows = []) {
  return {
    [optionsKey]: stored(option ? [option] : []),
    [rowsKey]: stored(rows),
  };
}

const completeDetails = {
  installationAddress: "4 Example Street, Sydney NSW 2000, Australia",
  googlePlaceId: "ChIJ-example",
  proposedInstallationDate: "2026-08-14",
};

assert.deepEqual(
  validateNewWonJobTransitions({}, snapshot({
    id: "quote-complete",
    name: "Complete customer",
    wonAt: "2026-07-22T00:00:00.000Z",
    ...completeDetails,
  })),
  { valid: true },
  "A complete new won quote should be accepted.",
);

for (const missingField of Object.keys(completeDetails)) {
  const details = { ...completeDetails };
  delete details[missingField];
  const result = validateNewWonJobTransitions({}, snapshot({
    id: `quote-missing-${missingField}`,
    name: "Incomplete customer",
    wonAt: "2026-07-22T00:00:00.000Z",
    ...details,
  }));
  assert.equal(result.valid, false, `A new won quote missing ${missingField} must be rejected.`);
}

const invalidDate = validateNewWonJobTransitions({}, snapshot({
  id: "quote-invalid-date",
  name: "Invalid date customer",
  wonAt: "2026-07-22T00:00:00.000Z",
  ...completeDetails,
  proposedInstallationDate: "2026-02-30",
}));
assert.equal(invalidDate.valid, false, "An impossible installation date must be rejected.");

const legacyWon = snapshot({
  id: "quote-lawrence",
  name: "Lawrence Weinert",
  wonAt: "2026-07-22T00:19:51.026Z",
});
assert.deepEqual(
  validateNewWonJobTransitions(legacyWon, legacyWon),
  { valid: true },
  "An already-saved legacy won quote must not block later saves.",
);

const rewonLegacy = snapshot({
  id: "quote-lawrence",
  name: "Lawrence Weinert",
  wonAt: "2026-07-22T00:20:51.026Z",
});
assert.equal(
  validateNewWonJobTransitions(legacyWon, rewonLegacy).valid,
  false,
  "Changing a won timestamp must be treated as a new transition.",
);

const detailsOnRow = validateNewWonJobTransitions({}, snapshot(
  { id: "quote-row-details", name: "Row details", wonAt: "2026-07-22T00:00:00.000Z" },
  [{
    id: "system-1",
    optionId: "quote-row-details",
    optionName: "Row details",
    wonAt: "2026-07-22T00:00:00.000Z",
    ...completeDetails,
  }],
));
assert.deepEqual(detailsOnRow, { valid: true }, "Details saved on a quote row should satisfy the requirement.");

const rowOnlyWin = validateNewWonJobTransitions({}, snapshot(null, [{
  id: "system-2",
  optionId: "quote-row-only",
  optionName: "Row-only customer",
  wonAt: "2026-07-22T00:00:00.000Z",
}]));
assert.equal(rowOnlyWin.valid, false, "A row-only won transition must also be validated.");

console.log("Won job server validation checks passed.");
