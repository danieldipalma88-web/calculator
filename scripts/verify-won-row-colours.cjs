const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");

const read = name => fs.readFileSync(path.resolve(__dirname, "..", name), "utf8");
const source = read("app/admin/users/page.tsx");
const tree = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const helpers = ["formatMoney", "formatShortDate", "wonPaymentStatus", "wonOutstandingLabel"];
const functions = tree.statements.filter(n => ts.isFunctionDeclaration(n) && helpers.includes(n.name?.text));
const summary = source.match(/<summary className="won-card-summary">[\s\S]*?<\/summary>/)[0];
const card = source.match(/<details\s+className=\{.won-card won-card-[\s\S]*?key=\{wonOptionDomKey\(option\)\}\s*>/)[0];
const attrs = card.split(/\r?\n/).filter(line => /^\s*(className=|data-payment-)/.test(line)).join("\n");
const fixture = ts.transpileModule(functions.map(n => n.getText(tree)).join("\n") +
  '\nconst wonOptionDomKey = o => o.optionName; module.exports = option => { option.paymentStatus = wonPaymentStatus(option.paymentRequestedAt, option.paidInAt, option.paidOutAt); return <details ' +
  attrs + '>' + summary + '<div className="won-card-body">Sample job details</div></details> };',
  { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
const fixtureModule = { exports: {} };
new Function("React", "module", fixture)(React, fixtureModule);

const cases = [
  [0,0,0,"#ffdfdf","#d14349","Not requested"], [1,0,0,"#fff0c9","#bc7b0b","Awaiting payment"],
  [0,1,0,"#dfeeff","#347ec7","Received"], [1,1,0,"#dfeeff","#347ec7","Received"],
  [0,0,1,"#ede2fa","#8853b5","Not requested"], [1,0,1,"#ede2fa","#8853b5","Awaiting payment"],
  [0,1,1,"#dbf3e3","#238555","Received"], [1,1,1,"#dbf3e3","#238555","Received"],
];
const rowMarkup = ([requested, received, paid], index, agency = 300, commission = 140) => renderToStaticMarkup(fixtureModule.exports({
  optionName: "Sample " + index, userName: "Salesperson", businessName: "Sample business", wonAt: "2026-11-20",
  agencyCommissionTotal: 300, salespersonCommissionTotal: 140,
  review: { amounts: { agencyCommissionTotal: agency, salespersonCommissionTotal: commission } },
  paymentRequestedAt: requested, paidInAt: received, paidOutAt: paid,
}));
const rows = cases.map((values, i) => rowMarkup(values, i));
const html = '<meta name="viewport" content="width=device-width,initial-scale=1"><style>' + read("app/globals.css") +
  '</style><main class="admin-shell"><div class="admin-card admin-workspace"><section id="won-options" class="admin-section won-options-section"><div class="admin-section-body won-grid">' +
  rows.join("") + '</div></section></div></main><aside>' + rows[0] + '</aside><div id="missing">' +
  rowMarkup([0,0,0],8,null) + rowMarkup([0,1,0],9,300,null) + rowMarkup([0,0,0],10,0) + '</div>';
const rgb = hex => "rgb(" + hex.slice(1).match(/../g).map(pair => parseInt(pair,16)).join(", ") + ")";
function luminance(rgbString) {
  const [r,g,b] = rgbString.match(/\d+/g).map(c => Number(c) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126*r + 0.7152*g + 0.0722*b;
}

(async () => {
  const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (fs.existsSync(chrome) ? chrome : undefined);
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.abort());
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 840 });
      await page.setContent(html);
      const cards = page.locator("#won-options .won-card");
      assert.deepEqual(await page.locator("#missing .won-row-metric-payment strong").allTextContents(), ["Incomplete","Incomplete","$0.00"]);
      assert.equal(await cards.count(), cases.length);
      for (const [i, [, received, paid, fill, stripe, agency]] of cases.entries()) {
        const row = cards.nth(i);
        const summary = row.locator("summary");
        assert.equal(await summary.evaluate(el => getComputedStyle(el).backgroundColor), rgb(fill));
        assert.equal(await row.evaluate(el => getComputedStyle(el,"::before").backgroundColor), rgb(stripe));
        assert.equal(await row.locator(".won-payment-summary").innerText(), "Agency: " + agency + "\nCommission: " + (paid ? "Paid" : "Not paid"));
        const inks = await row.locator(".won-payment-summary span").evaluateAll(labels => labels.map(el => getComputedStyle(el).color));
        assert.ok(inks.every(ink => (luminance(rgb(fill)) + 0.05) / (luminance(ink) + 0.05) >= 4.5));
        assert.equal(await row.locator(".won-row-metric-payment strong").textContent(), received ? (paid ? "$0.00" : "$140.00") : "$300.00");
        assert.ok(await row.getByRole("checkbox").isVisible());
        assert.ok(await summary.evaluate(el => el.getBoundingClientRect().right <= innerWidth));
      }
      await cards.first().locator(".won-expand-label").click();
      assert.ok(await cards.first().locator(".won-card-body").isVisible());
      assert.equal(await page.locator("aside summary").evaluate(el => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)");
    }
    console.log("All eight payment combinations: desktop/mobile colours, labels, balances, expand and admin-only scope passed.");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
