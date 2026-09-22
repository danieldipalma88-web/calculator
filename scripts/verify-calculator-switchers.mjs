import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { filterSelectOptions } from "../app/calculator/auto-submit-select-utils.ts";

const options = [
  { label: "Alex Smith", secondaryLabel: "alex@example.test", value: "alex" },
  { label: "Beth Jones", secondaryLabel: "beth@example.test", value: "beth" },
  { label: "Bright Air Conditioning", value: "business-123" },
];
assert.deepEqual(filterSelectOptions(options, ""), options);
assert.deepEqual(filterSelectOptions(options, "  ALEX SMITH  "), [options[0]]);
assert.deepEqual(filterSelectOptions(options, "beth@example"), [options[1]]);
assert.deepEqual(filterSelectOptions(options, "bright air"), [options[2]]);
assert.deepEqual(filterSelectOptions(options, "business-123"), [options[2]]);
assert.deepEqual(filterSelectOptions(options, "missing"), []);
assert.equal(options.length, 3);

const component = await readFile(new URL("../app/calculator/auto-submit-select.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../app/calculator/auto-submit-select.module.css", import.meta.url), "utf8");
const page = await readFile(new URL("../app/calculator/page.tsx", import.meta.url), "utf8");
const checks = [
  [component, 'method="get"', "GET form submission"], [component, "hiddenFields.map", "hidden field preservation"],
  [component, "formRef.current?.requestSubmit()", "explicit selection submission"], [component, "type=\"search\"", "search input"],
  [component, 'event.key === "ArrowDown"', "arrow navigation"], [component, 'event.key === "Enter"', "Enter selection"],
  [component, 'event.key === "Escape"', "Escape close"], [component, "pointerdown", "outside click close"],
  [component, 'role="combobox"', "combobox semantics"], [component, "No results found.", "empty search state"], [page, "secondaryLabel: approvedUser.email", "user email disambiguation"],
  [page, 'name: "admin", value: "1"', "admin mode preservation"], [page, 'name: "as", value: viewingEmail', "viewed user preservation"],
  [component, "tabIndex={-1}", "non-tabbable option buttons"], [component, "scrollIntoView({ block: \"nearest\" })", "active option scrolling"],
  [component, "window.addEventListener(\"pageshow\"", "back-forward cache recovery"], [component, "setSelectedValue(value)", "selected value prop synchronization"],
  [styles, ".form:global(.workspace-business-switcher), .form:global(.workspace-business-switcher) .root, .form:global(.workspace-business-switcher) .trigger { width: 100%; }", "responsive business full width"],
  [styles, ".search { min-height: 44px; font-size: 16px; }", "mobile search sizing"], [styles, "letter-spacing: 0", "zero letter spacing"],
  [component, 'aria-label={`${ariaLabel}: ${selectedOption?.label || "Choose an option"}`}', "current selection in trigger name"],
  [component, 'role="status" aria-live="polite"', "announced empty state"],
];
const missing = checks.filter(([source, needle]) => !source.includes(needle));
if (missing.length) { for (const [, , label] of missing) console.error(`Missing ${label}.`); process.exit(1); }
console.log("calculator switcher checks passed");
