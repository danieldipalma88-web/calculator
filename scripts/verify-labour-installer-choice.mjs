import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

const controls = [
  { id: "installerRetainsLabour", checked: true },
  { id: "ductedInstallerRetainsLabour", checked: false },
  { id: "multiInstallerRetainsLabour", checked: true },
];

for (const control of controls) {
  const start = html.indexOf(`data-labour-checkbox="${control.id}"`);
  assert.ok(start >= 0, `missing labour installer control for ${control.id}`);
  const panel = html.slice(start, start + 1400);
  assert.match(panel, new RegExp(`setLabourInstallerMode\\('${control.id}',true\\)`), `missing in-house action for ${control.id}`);
  assert.match(panel, new RegExp(`setLabourInstallerMode\\('${control.id}',false\\)`), `missing subcontractor action for ${control.id}`);
  const checkbox = panel.match(new RegExp(`<input id="${control.id}"[^>]*>`))?.[0] || "";
  assert.ok(checkbox, `missing backing checkbox for ${control.id}`);
  assert.equal(/\schecked(?:\s|>)/.test(checkbox), control.checked, `default labour mode changed for ${control.id}`);
}

assert.equal((html.match(/>Who will complete the installation\?<\/div>/g) || []).length, 3, "installer question must appear in all three calculators");
assert.equal((html.match(/>In-house team<\/button>/g) || []).length, 3, "in-house choice must appear in all three calculators");
assert.equal((html.match(/>External subcontractor<\/button>/g) || []).length, 3, "subcontractor choice must appear in all three calculators");
assert.doesNotMatch(html, />Installer retains labour profit<\//, "old installer-retains wording is still visible");
assert.match(html, /function setLabourInstallerMode\(checkboxId,inHouse\)/, "missing labour installer selection handler");
assert.match(html, /checkbox\.checked=!!inHouse;/, "visible choice no longer maps to the existing stored value");
assert.match(html, /const splitLabourRetained=systemType==='split'.*installerRetainsLabour.*\.checked;/, "split labour calculation changed unexpectedly");
assert.match(html, /const ductedLabourRetained=systemType==='ducted'.*ductedInstallerRetainsLabour.*\.checked;/, "ducted labour calculation changed unexpectedly");

console.log("Labour installer choice verifier passed (split, ducted and multi-head)");
