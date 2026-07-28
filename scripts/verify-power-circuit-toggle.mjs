import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const calculator = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");

function functionSource(name) {
  const start = calculator.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Missing ${name}`);
  let depth = 0;
  let opened = false;
  for (let index = start; index < calculator.length; index += 1) {
    if (calculator[index] === "{") {
      depth += 1;
      opened = true;
    } else if (calculator[index] === "}") {
      depth -= 1;
      if (opened && depth === 0) return calculator.slice(start, index + 1);
    }
  }
  throw new Error(`Could not parse ${name}`);
}

assert.match(calculator, /id="powerCircuitToggle" type="checkbox"/, "The visible power-circuit switch must exist.");
assert.match(calculator, /id="powerCircuitStateLabel">Not included</, "The visible state label must exist.");
assert.match(calculator, /id="powerCircuitCostHint"[^>]*>Not applied to this quote</, "The power-cost application hint must exist.");
assert.match(calculator, /id="powerMode" class="hidden"[\s\S]*?<option value="auto">[\s\S]*?<option value="on">[\s\S]*?<option value="off">/, "The saved auto/on/off control must remain compatible.");
assert.match(calculator, /id="powerCircuitReset"[\s\S]*?onclick="resetPowerCircuitToAuto\(\)"/, "The automatic-rule reset must be available.");
assert.match(calculator, /\.powerCircuitSwitch input:checked \+ \.toggleTrack\{background:#16a34a\}/, "The on state must use a clear green switch track.");
assert.match(calculator, /\.powerCircuitRule\[data-enabled="true"\]\{[\s\S]*?background:#f0fdf4;/, "The on state must use a green-tinted container.");
assert.match(calculator, /powerMode:\$\('powerMode'\)\.value/, "Saved quotes must retain the power mode.");
assert.match(calculator, /fieldIds=\[[^\]]*'powerMode'/, "Loaded quotes must restore the power mode.");
assert.match(functionSource("render"), /syncPowerCircuitControl\(\);/, "Rendering must synchronize the visible switch.");

let mode = "auto";
let toggleChecked = false;
let autoFinalCalls = 0;
let renderCalls = 0;
let capacity = 5;
const rule = { dataset: {} };
const stateLabel = { textContent: "" };
const status = { textContent: "" };
const costHint = { textContent: "" };
const costClasses = new Set();
const costField = {
  classList: {
    toggle(name, enabled) {
      if (enabled) costClasses.add(name);
      else costClasses.delete(name);
    },
  },
};
const resetClasses = new Set(["hidden"]);
const reset = {
  classList: {
    toggle(name, enabled) {
      if (enabled) resetClasses.add(name);
      else resetClasses.delete(name);
    },
  },
};
const context = {
  finalPriceLocked: false,
  $: (id) => {
    if (id === "powerMode") return { get value() { return mode; }, set value(value) { mode = value; } };
    if (id === "powerCircuitToggle") return { get checked() { return toggleChecked; }, set checked(value) { toggleChecked = value; } };
    if (id === "powerCircuitRule") return rule;
    if (id === "powerCircuitStateLabel") return stateLabel;
    if (id === "powerCircuitStatus") return status;
    if (id === "powerCircuitCostField") return costField;
    if (id === "powerCircuitCostHint") return costHint;
    if (id === "powerCircuitReset") return reset;
    return null;
  },
  cap: () => capacity,
  product: () => ({}),
  autoFinal: () => { autoFinalCalls += 1; },
  render: () => { renderCalls += 1; },
};

vm.runInNewContext(
  [
    functionSource("powerCircuitEnabled"),
    functionSource("syncPowerCircuitControl"),
    functionSource("setPowerCircuitFromToggle"),
    functionSource("resetPowerCircuitToAuto"),
    "result = { powerCircuitEnabled, syncPowerCircuitControl, setPowerCircuitFromToggle, resetPowerCircuitToAuto };",
  ].join("\n"),
  context,
);

assert.equal(context.result.powerCircuitEnabled(3.5), false, "Automatic mode must remain off at 3.5kW.");
assert.equal(context.result.powerCircuitEnabled(5), true, "Automatic mode must remain on above 3.5kW.");

context.result.syncPowerCircuitControl();
assert.equal(toggleChecked, true, "An automatic active circuit must show the switch as on.");
assert.equal(rule.dataset.enabled, "true", "An active circuit must expose the on visual state.");
assert.equal(stateLabel.textContent, "Included", "An active circuit must be labelled Included.");
assert.equal(costHint.textContent, "Applied to this quote", "An active circuit must confirm the cost is applied.");
assert.equal(costClasses.has("active"), true, "An active circuit must highlight the cost field.");

capacity = 3.5;
context.result.syncPowerCircuitControl();
assert.equal(toggleChecked, false, "An automatic inactive circuit must show the switch as off.");
assert.equal(rule.dataset.enabled, "false", "An inactive circuit must expose the off visual state.");
assert.equal(stateLabel.textContent, "Not included", "An inactive circuit must be labelled Not included.");
assert.equal(costHint.textContent, "Not applied to this quote", "An inactive circuit must confirm the cost is not applied.");
assert.equal(costClasses.has("inactive"), true, "An inactive circuit must dim the cost field.");

toggleChecked = false;
context.result.setPowerCircuitFromToggle();
assert.equal(mode, "off", "Switching off must save the existing off value.");

toggleChecked = true;
context.result.setPowerCircuitFromToggle();
assert.equal(mode, "on", "Switching on must save the existing on value.");

context.result.resetPowerCircuitToAuto();
assert.equal(mode, "auto", "Reset must restore the existing automatic value.");
assert.equal(autoFinalCalls, 3, "Each mode change must recalculate an unlocked price.");
assert.equal(renderCalls, 3, "Each mode change must rerender immediately.");

console.log("power circuit toggle checks passed");
