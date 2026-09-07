import assert from "node:assert/strict";
import fs from "node:fs";

const calculator = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const priceDrawerStart = calculator.indexOf('<div id="priceDrawer"');
const certificateDrawerStart = calculator.indexOf('<div id="certDrawer"');
const quoteDrawerStart = calculator.indexOf('<div id="drawer"');
const wonJobsDrawerStart = calculator.indexOf('<div id="wonJobsDrawer"');

assert.ok(priceDrawerStart >= 0, "Price Manager drawer must exist.");
assert.ok(certificateDrawerStart > priceDrawerStart, "Certificate drawer must follow Price Manager.");
assert.ok(wonJobsDrawerStart > quoteDrawerStart, "Won Jobs drawer must follow Quote Builder.");

const priceDrawerMarkup = calculator.slice(priceDrawerStart, certificateDrawerStart);
const quoteDrawerMarkup = calculator.slice(quoteDrawerStart, wonJobsDrawerStart);

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

assert.match(priceDrawerMarkup, /<table class="defaultCostManagerTable">/);
assert.match(priceDrawerMarkup, /<table class="priceManagerTable">/);
assert.match(priceDrawerMarkup, /<details class="totalsManager priceDefaultCosts"/);
assert.doesNotMatch(quoteDrawerMarkup, /priceDefaultCosts|Default install costs/);
assert.match(quoteDrawerMarkup, /<div class="totalsManager" style="margin-top:14px">[\s\S]*Saved quote sets/);
assert.match(calculator, /#priceDrawer\{[^}]*padding:12px 10px calc\(24px \+ env\(safe-area-inset-bottom, 0px\)\)/);
assert.match(calculator, /#priceDrawer \.defaultCostManagerTable tbody\{display:block;width:100%\}/);
assert.doesNotMatch(calculator, /#priceDrawer\{padding-bottom:calc\(24px \+ env\(safe-area-inset-bottom, 0px\)\}/);
assert.match(calculator, /#priceDrawer \.priceDefaultCosts summary[\s\S]*min-height:44px/);
assert.match(calculator, /#priceDrawer \.priceManagerTable[\s\S]*min-width:0!important/);
assert.match(calculator, /#priceDrawer \.priceManagerTable td\[data-label\]::before[\s\S]*content:attr\(data-label\)/);
assert.match(calculator, /#priceDrawer \.priceManagerTable \.priceInput,[\s\S]*font-size:16px/);
assert.match(calculator, /#priceDrawer \.priceManagerTable \.managedLockBtn[\s\S]*min-height:44px/);
assert.match(calculator, /#priceDrawer > \.drawerHead:first-child[\s\S]*position:sticky/);

const defaultCostManager = functionSource("renderDefaultCostManager");
assert.match(defaultCostManager, /data-label="Labour ex GST"/);
assert.match(defaultCostManager, /data-label="Materials inc GST"/);
assert.match(defaultCostManager, /data-label="Power \/ electrician ex GST"/);
assert.match(defaultCostManager, /class="priceInput defaultCostInput"/);

const priceManager = functionSource("renderPriceManager");
assert.match(priceManager, /data-label="Unit price inc GST"/);
assert.match(priceManager, /class="managedRebateColumn" data-label="Rebate"/);
assert.match(priceManager, /data-label="Status"/);
assert.match(priceManager, /data-label="Actions"/);
assert.match(priceManager, /class="\$\{locked\?'is-locked':''\}"/);
assert.match(priceManager, /class="managedModelValue"/);
assert.match(priceManager, /togglePriceLock\(decodeKeyFromDom/);
assert.match(priceDrawerMarkup, /role="dialog" aria-modal="true" aria-labelledby="priceManagerTitle"/);
assert.match(functionSource("openPriceDrawer"), /priceManagerTitle.*focus\(\{preventScroll:true\}\)/);
assert.match(functionSource("togglePriceLock"), /managedLockBtn.*focus\(\{preventScroll:true\}\)/);
assert.match(calculator, /event\.key==='Escape'\)\{event\.preventDefault\(\); closePriceDrawer\(\); return;/);
assert.match(priceDrawerMarkup, /id="priceResultCount"[\s\S]*aria-live="polite"/);

console.log("Price Manager mobile layout guards verified.");
