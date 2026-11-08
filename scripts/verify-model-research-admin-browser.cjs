const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');

const root = path.resolve(__dirname, '..');
const screenshotDir = process.env.MODEL_RESEARCH_SCREENSHOT_DIR
  ? path.resolve(process.env.MODEL_RESEARCH_SCREENSHOT_DIR)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'model-research-admin-browser-'));
fs.mkdirSync(screenshotDir, { recursive: true });
const fixture = {
  requests: [
    { id: 'research-no-rebate', requester_name: 'Fixture requester', requester_email: 'fixture@example.invalid', business_name: 'Fixture business', system_type: 'split', brand: 'Submitted Brand', model: 'SUBMITTED-OUT / SUBMITTED-IN', capacity: '2.5kW', phase: 'single', notes: 'Original submitted notes remain visible.', postcode: '2000', install_type: 'replacement', created_at: '2026-11-09T00:00:00Z', status: 'reviewing', job: {
      state: 'added', contact_state: null, contact_next_at: null, existing: false, reason: '', attempts: 0, evidence: {}, product: null, email_state: 'sent', email_error: '', email_sent_at: '2026-11-09T00:40:00Z', outcome_email: { state: 'pending', sent_at: null },
      research: { id: 'research-1', state: 'no_rebate', round: 2, updated_at: '2026-11-09T01:00:00Z', result: {
        summary: 'The verified calculation returned no certificates for this installation.', canonical: { brand: 'Corrected Brand', model: `CORRECTED-${'MODEL-'.repeat(35)}`, systemType: 'split', capacityKw: 2.5, phase: 'Single', registrationNumber: 'REG-123' },
        sourceUrls: ['https://example.invalid/evidence', `https://example.invalid/${'evidence-'.repeat(35)}`, 'javascript:alert(1)'], question: 'Confirm the installation postcode.'
      }, events: [{ kind: 'registry_search', detail: 'Checked exact equipment pairing.', at: '2026-11-09T00:30:00Z' }] },
      activity: [
        ...['pending_verification', 'waiting_for_details', 'complete', 'superseded', 'registry_search', 'api_usage', 'web_research', 'imported', 'applied', 'continuation_deferred', 'recovered', 'no_rebate_sent'].map(kind => ({ kind, detail: 'Fixture event', at: '2026-11-09T00:30:00Z' }))
      ]
    } },
    { id: 'budget', requester_name: 'Fixture', requester_email: '', business_name: '', system_type: 'ducted', brand: 'Brand', model: 'MODEL', capacity: '14kW', phase: '', notes: '', postcode: '', install_type: '', created_at: '2026-11-09T00:00:00Z', status: 'reviewing', job: { state: 'researching', contact_state: null, contact_next_at: null, existing: false, reason: '', attempts: 0, evidence: {}, product: null, email_state: 'pending', email_error: '', email_sent_at: null, research: { state: 'budget_paused', round: 1 } } },
    { id: 'uncertain', requester_name: 'Fixture', requester_email: '', business_name: '', system_type: 'ducted', brand: 'Brand', model: 'MODEL', capacity: '14kW', phase: '', notes: '', postcode: '', install_type: '', created_at: '2026-11-09T00:00:00Z', status: 'reviewing', job: { state: 'researching', contact_state: null, contact_next_at: null, existing: false, reason: '', attempts: 0, evidence: {}, product: null, email_state: 'pending', email_error: '', email_sent_at: null, research: { state: 'reconciliation_required', round: 1 } } },
    { id: 'failed-outcome-email', requester_name: 'Fixture', requester_email: '', business_name: '', system_type: 'split', brand: 'Brand', model: 'MODEL', capacity: '2.5kW', phase: '', notes: '', postcode: '2000', install_type: 'new', created_at: '2026-11-09T00:00:00Z', status: 'complete', job: { state: 'no_rebate', contact_state: null, contact_next_at: null, existing: false, reason: '', attempts: 0, evidence: {}, product: null, email_state: 'pending', email_error: '', email_sent_at: null, outcome_email: { state: 'failed', sent_at: null }, activity: [{ kind: 'no_rebate_sent', detail: 'Earlier accepted message', at: '2026-11-09T00:30:00Z' }] } },
    { id: 'legacy-outcome-queued', requester_name: 'Fixture', requester_email: '', business_name: '', system_type: 'split', brand: 'Legacy', model: 'LEGACY-NO-REBATE', capacity: '', phase: '', notes: '', postcode: '', install_type: '', created_at: '2026-11-09T00:00:00Z', status: 'complete', job: { state: 'no_rebate', contact_state: null, contact_next_at: null, existing: false, reason: '', attempts: 0, evidence: {}, product: null, email_state: 'pending', email_error: '', email_sent_at: null } },
    { id: 'legacy-outcome-sent', requester_name: 'Fixture', requester_email: '', business_name: '', system_type: 'split', brand: 'Legacy', model: 'LEGACY-SENT', capacity: '', phase: '', notes: '', postcode: '', install_type: '', created_at: '2026-11-09T00:00:00Z', status: 'complete', job: { state: 'no_rebate', contact_state: null, contact_next_at: null, existing: false, reason: '', attempts: 0, evidence: {}, product: null, email_state: 'pending', email_error: '', email_sent_at: null, activity: [{ kind: 'no_rebate_sent', detail: '', at: '2026-11-09T00:30:00Z' }] } },
    { id: 'legacy-payload', requester_name: 'Fixture', requester_email: '', business_name: '', system_type: 'split', brand: 'Legacy', model: 'LEGACY-MODEL', capacity: '', phase: '', notes: '', postcode: '', install_type: '', created_at: '2026-11-09T00:00:00Z', status: 'reviewing', job: { state: 'added', contact_state: null, contact_next_at: null, existing: false, reason: '', attempts: 0, evidence: {}, product: null, email_state: 'sent', email_error: '', email_sent_at: null } }
  ],
  products: [], hasMore: false, researchAutomation: { enabled: true, keyConfigured: true },
  researchBudget: { month: '2026-11', spentMicros: 1250000, reservedMicros: 750000, limitMicros: 20000000, pricingReviewBy: '2026-12-09' }
};

function renderComponent(file, hooks = React, props = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports = {};
  vm.runInThisContext(`(function(exports,require){${code}\n})`)(exports, id => id === 'react' ? hooks : id.endsWith('.css') ? new Proxy({}, { get: (_, name) => name === '__esModule' ? false : String(name) }) : require(id));
  return renderToStaticMarkup(React.createElement(exports.default, props));
}

function adminMarkup(payload = fixture) {
  let hook = 0;
  const hooks = { ...React, useState: initial => { hook++; return [hook === 1 ? payload : hook === 2 ? false : initial, () => {}]; }, useRef: value => ({ current: value }), useEffect: () => {}, useCallback: fn => fn };
  return renderComponent('app/admin/model-requests/request-list.tsx', hooks);
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const admin = adminMarkup();
    assert.match(admin, /Original submitted notes remain visible/);
    assert.match(admin, /SUBMITTED-OUT \/ SUBMITTED-IN/);
    assert.match(admin, /CORRECTED-MODEL-MODEL-MODEL/);
    assert.match(admin, /A\$20 monthly ceiling/);
    assert.match(admin, /spent \+ .*reserved/);
    assert.match(admin, /Paused: budget/);
    assert.match(admin, /Paused: spend reconciliation/);
    assert.match(admin, /Research active/);
    assert.match(admin, /Outcome email:<\/strong> Outcome email queued/);
    assert.match(admin, /Outcome email:<\/strong> Delivery needs review/);
    assert.match(admin, /Outcome email:<\/strong> Accepted by email provider/);
    assert.match(admin, /Confirmation email:<\/strong> sent/);
    assert.match(admin, /This result applies only to the submitted installation\./);
    for (const label of ['Awaiting calculator verification', 'Waiting for details', 'Completed', 'Superseded', 'Registry search', 'API usage', 'Web research', 'Imported', 'Applied', 'Continuation deferred', 'Recovered', 'No-rebate email accepted']) assert.ok(admin.includes(label), `Missing friendly label: ${label}`);
    assert.match(admin, /https:\/\/example\.invalid\/evidence/);
    assert.doesNotMatch(admin, /javascript:alert/);
    assert.doesNotMatch(admin, /test-secret|api[_-]?key/i);
    assert.doesNotMatch(admin, /keyConfigured|key configured/i);
    assert.match(adminMarkup({ ...fixture, researchAutomation: { enabled: true, keyConfigured: false } }), /Research paused/);
    const { researchAutomation, ...oldPayload } = fixture;
    assert.doesNotMatch(adminMarkup(oldPayload), /Research (?:active|paused)/);

    const response = renderComponent('app/model-requests/request-response.tsx', React, { id: 'fixture', request: {
      brand: 'Submitted Brand', model: 'SUBMITTED-OUT / SUBMITTED-IN', system_type: 'split', postcode: '2000', install_type: 'replacement',
      state: 'no_rebate', question: 'Please confirm the installation postcode.', candidates: [], next_at: null, round: 1,
      outcome: 'no_rebate', no_rebate: true, summary: 'The verified calculation returned 0 ESC and 0 PRC certificates for the submitted installation.', matchedModel: `CORRECTED-${'MODEL-'.repeat(35)}`
    } });
    assert.match(response, /No rebate for this installation/);
    assert.ok(response.includes(`CORRECTED-${'MODEL-'.repeat(35)}`), 'Requester response should render the complete fixture matchedModel');
    assert.match(response, /The verified calculation returned 0 ESC and 0 PRC certificates for the submitted installation/);
    assert.doesNotMatch(response, /<form/);
    const oldRequesterPayload = renderComponent('app/model-requests/request-response.tsx', React, { id: 'legacy', request: {
      brand: 'Legacy', model: 'LEGACY-MODEL', system_type: 'split', postcode: '', install_type: '', state: 'researching', question: '', candidates: [], next_at: null, round: 1
    } });
    assert.match(oldRequesterPayload, /Researching/);
    assert.doesNotMatch(oldRequesterPayload, /<form/);

    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const css = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'app/admin/model-requests/model-requests.module.css'), 'utf8');
      await page.setContent(`<html><head><style>${css}</style></head><body><main class="admin-shell"><section class="admin-card"><header class="admin-head"><h1>Model requests</h1></header>${admin}</section></main></body></html>`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `admin overflow at ${width}px`);
      await page.locator('.research details summary').first().focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('.research details').first().evaluate(node => node.open), true);
      for (const details of await page.locator('details').all()) await details.evaluate(node => { node.open = true; });
      assert.equal(await page.locator('.sourceList a').count(), 2);
      assert.equal(await page.locator('.sourceList a').first().getAttribute('href'), 'https://example.invalid/evidence');
      assert.equal(await page.locator('.sourceList a').first().getAttribute('rel'), 'noreferrer');
      assert.equal(await page.locator('.researchHead').first().evaluate(node => node.scrollWidth <= node.clientWidth), true, `long model overflow at ${width}px`);
      assert.equal(await page.locator('.sourceList').first().evaluate(node => node.scrollWidth <= node.clientWidth), true, `long sources overflow at ${width}px`);
      assert.deepEqual(errors, []);
      const adminScreenshot = path.join(screenshotDir, `admin-${width}.png`);
      await page.screenshot({ path: adminScreenshot, fullPage: true });
      await page.close();

      const requesterPage = await browser.newPage({ viewport: { width, height: 900 } });
      await requesterPage.setContent(`<html><head><style>${fs.readFileSync(path.join(root, 'app/model-requests/model-requests.module.css'), 'utf8')}</style></head><body><main class="shell"><section class="panel">${response}</section></main></body></html>`);
      assert.equal(await requesterPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `requester overflow at ${width}px`);
      assert.equal(await requesterPage.getByText('No rebate for this installation').count(), 1);
      assert.equal(await requesterPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `long requester model overflow at ${width}px`);
      const requesterScreenshot = path.join(screenshotDir, `requester-${width}.png`);
      await requesterPage.screenshot({ path: requesterScreenshot, fullPage: true });
      await requesterPage.close();
      console.log(`Model research UI ${width}px: status, bounded budget, evidence links, no-rebate copy, keyboard disclosure and horizontal fit passed.`);
      console.log(`Screenshots: ${adminScreenshot} | ${requesterScreenshot}`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
