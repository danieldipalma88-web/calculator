import { readFile } from "node:fs/promises";

const ui = await readFile(new URL("../index.html", import.meta.url), "utf8");
const inlineScripts = [...ui.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((source) => source.trim());

for (const source of inlineScripts) new Function(source);

const checks = [
  ["const QUOTE_SEARCH_SELECT_IDS=['addOptionSelect','drawerAddOptionSelect','multiAddOptionSelect']", "all quote selectors"],
  ["input.setAttribute('role','combobox')", "accessible combobox role"],
  ["input.setAttribute('aria-autocomplete','list')", "combobox autocomplete behavior"],
  [".toLocaleLowerCase().includes(query)", "case-insensitive partial matching"],
  ["if(a.id===selectedId) return -1", "selected quote ordering"],
  ["return quoteSearchUpdatedAt(b)-quoteSearchUpdatedAt(a)", "recent quote ordering"],
  ["event.key==='ArrowDown'", "keyboard navigation"],
  ["event.key==='Enter'&&buttons[active]", "keyboard selection"],
  ["No quotes found. Try another customer name.", "empty result state"],
  ["onOptionSelectionChange(def.id)", "existing quote selection path"],
];

const missing = checks.filter(([needle]) => !ui.includes(needle));
if (missing.length) {
  for (const [, label] of missing) console.error(`Missing ${label}.`);
  process.exit(1);
}

console.log("quote search checks passed");
