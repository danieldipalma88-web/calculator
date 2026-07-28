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
assert.match(calculator, /id="powerMode" class="hidden"[\s\S]*?<option value="auto">[\s\S]*?<option value="on">[\s\S]*?<option value="off">/, "The saved auto/on/off control must remain compatible.");
assert.match(calculator, /id="powerCircuitReset"[\s\S]*?onclick="resetPowerCircuitToAuto\(\)"/, "The automatic-rule reset must be available.");
assert.match(calculator, /powerMode:\$\('powerMode'\)\.value/, "Saved quotes must retain the power mode.");
assert.match(calculator, /fieldIds=\[[^\]]*'powerMode'/, "Loaded quotes must restore the power mode.");
assert.match(functionSource("render"), /syncPowerCircuitControl\(\);/, "Rendering must synchronize the visible switch.");

let mode = "auto";
let toggleChecked = false;
let autoFinalCalls = 0;
let renderCalls = 0;
const context = {
  finalPriceLocked: false,
  $: (id) => {
    if (id === "powerMode") return { get value() { return mode; }, set value(value) { mode = value; } };
    if (id === "powerCircuitToggle") return { get checked() { return toggleChecked; }, set checked(value) { toggleChecked = value; } };
    return null;
  },
  autoFinal: () => { autoFinalCalls += 1; },
  render: () => { renderCalls += 1; },
};

vm.runInNewContext(
  [
    functionSource("powerCircuitEnabled"),
    functionSource("setPowerCircuitFromToggle"),
    functionSource("resetPowerCircuitToAuto"),
    "result = { powerCircuitEnabled, setPowerCircuitFromToggle, resetPowerCircuitToAuto };",
  ].join("\n"),
  context,
);

assert.equal(context.result.powerCircuitEnabled(3.5), false, "Automatic mode must remain off at 3.5kW.");
assert.equal(context.result.powerCircuitEnabled(5), true, "Automatic mode must remain on above 3.5kW.");

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
