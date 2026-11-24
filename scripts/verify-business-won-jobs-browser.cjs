const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const ts = require('typescript');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/danie/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = path.resolve(__dirname, '..'), output = path.join(root, 'outputs/business-won-jobs');
const port = 65374, base = `http://127.0.0.1:${port}`, businessId = '11111111-1111-4111-8111-111111111111';
const allowed = ['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'];
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.includes(key.toUpperCase())));
env.NEXT_TELEMETRY_DISABLED = '1';
const payload = { businessId, businessName: 'Fictional Air Conditioning & Electrical', checkedAt: '2026-11-24T00:30:00Z', jobs: Array.from({ length: 31 }, (_, n) => ({
  key: `job-${n}`, quoteName: n === 0 ? 'Fictional Customer With A Long Name For Mobile Checking' : `Customer ${n}`,
  wonAt: n < 15 ? '2026-11-23T22:00:00Z' : '2026-11-20T22:00:00Z', salespersonName: n % 2 ? 'Alex Example' : 'Daniel Example',
  address: '10 Fictional Street, Example NSW 2000', installationDate: '2026-07-15',
  rows: [{ brand: 'Fixture', model: `OUT-${n} / IN-${n}`, type: 'split', size: '2.5kW', install: 'new', finalInc: 2000, rebate: 400, netProfit: 600 }],
  customerTotal: 2000, rebateTotal: 400, installerProfit: 600,
})) };
const calculator = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const source = [...calculator.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n');
const ast = ts.createSourceFile('calculator.js', source, ts.ScriptTarget.Latest, true);
const entryFunctions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['businessWonJobsUrl', 'updateWonJobsCount', 'openWonJobsDrawer', 'openOwnWonJobsDrawer'].includes(node.name?.text)).map(node => node.getText(ast)).join('\n');
const entryFixture = `<!doctype html><meta name="viewport" content="width=device-width"><button onclick="openWonJobsDrawer()">Won Jobs (<span data-won-jobs-count>0</span>)</button><div id="wonJobsDrawer"></div><script>
var fixtureUser={role:'business_owner',businessId:'${businessId}',email:'owner@example.invalid',viewingEmail:'owner@example.invalid'},ownOpens=0;
function calculatorUserContext(){return fixtureUser;}function ensureSecondaryStartup(){}function renderWonJobs(){ownOpens++;}function $(id){return document.getElementById(id);}function syncOverlayState(){}function collectWonJobs(){throw Error('Unexpected owner startup quote scan');}
${entryFunctions}
localStorage.setItem('fictionalPendingQuote','UNCHANGED');updateWonJobsCount();updateWonJobsCount();</script>`;
fs.mkdirSync(output, { recursive: true });
let server, logs = '';
async function waitReady() {
  let last = '';
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(logs);
    try { const response = await fetch(`${base}/business-won-jobs?businessId=${businessId}`); if (response.ok) return; last = `HTTP ${response.status}`; } catch (error) { last = String(error.cause || error); }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Local fixture server did not respond (${last}): ${logs}`);
}
async function scenario(engine, options, label) {
  const browser = await engine.launch(options);
  try {
    const context = await browser.newContext({ viewport: label === 'desktop' ? { width: 1366, height: 1000 } : { width: 390, height: 844 } });
    let apiReads = 0, mode = 'success', prepareReads = 0;
    const errors = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) throw new Error(`Unexpected external request: ${url.origin}`);
      if (url.pathname === '/_fixture/owner-entry') return route.fulfill({ contentType: 'text/html', body: entryFixture });
      if (url.pathname === '/api/business-won-jobs') {
        apiReads++; assert.equal(route.request().method(), 'GET');
        await new Promise(resolve => setTimeout(resolve, 180));
        if (mode === 'prepare' && prepareReads++ === 0) return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ status: 'refreshing', businessId, retryAfterMs: 1000 }) });
        if (mode === 'prepare') mode = 'success';
        return route.fulfill({ status: mode === 'success' ? 200 : 503, contentType: 'application/json', body: JSON.stringify(mode === 'success' ? payload : { error: 'Temporary fixture outage. Please try again.' }) });
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/_fixture/owner-entry`);
    assert.equal(await page.getByRole('button', { name: 'My Won Jobs', exact: true }).count(), 1, 'No duplicate own-job controls');
    const opened = context.waitForEvent('page');
    await page.getByRole('button', { name: 'Business Won Jobs', exact: true }).click();
    const report = await opened;
    await report.waitForURL(`${base}/business-won-jobs?businessId=${businessId}`);
    await report.getByRole('button', { name: 'Refresh', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('fictionalPendingQuote')), 'UNCHANGED');
    assert.ok(page.url().endsWith('/_fixture/owner-entry'));
    await report.close();
    await page.getByRole('button', { name: 'My Won Jobs', exact: true }).click();
    assert.equal(await page.evaluate(() => ownOpens), 1);
    apiReads = 0;
    await page.goto(`${base}/business-won-jobs?businessId=${businessId}`);
    await page.getByRole('heading', { name: 'Won Jobs', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Refresh', exact: true }).waitFor();
    assert.equal(apiReads, 1);
    assert.equal(await page.locator('article').count(), 25);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    assert.equal(await page.locator('article').count(), 6);
    await page.getByRole('button', { name: 'Previous', exact: true }).click();
    await page.getByLabel('Salesperson', { exact: true }).selectOption('Alex Example');
    assert.equal(await page.locator('article').count(), 15);
    await page.getByLabel('Search', { exact: true }).fill('OUT-3');
    assert.equal(await page.locator('article').count(), 1);
    await page.getByLabel('Search', { exact: true }).fill('');
    await page.getByLabel('Salesperson', { exact: true }).selectOption('');
    await page.getByLabel('Won from', { exact: true }).fill('2026-11-24');
    assert.equal(await page.locator('article').count(), 15, 'Sydney date boundary');
    await page.getByLabel('Won to', { exact: true }).fill('2026-11-22');
    assert.equal(await page.locator('article').count(), 0);
    await page.getByText('The end date must be on or after the start date.').waitFor();
    await page.getByLabel('Won from', { exact: true }).fill('');
    await page.getByLabel('Won to', { exact: true }).fill('');
    await page.locator('summary').first().click();
    assert.ok((await page.locator('article').first().textContent()).includes('15/07/2026'), 'Winter install dates must not shift');
    assert.equal(apiReads, 1, 'Filtering and paging do not query the database');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal overflow');
    await page.screenshot({ path: path.join(output, `${label}.png`), fullPage: false });
    mode = 'prepare';
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('Preparing business Won Jobs...').waitFor();
    assert.equal(await page.locator('article').count(), 0, 'Preparation must hide previous financial results');
    assert.equal(await page.getByRole('region', { name: 'Business totals', exact: true }).count(), 0, 'Preparation must hide previous totals');
    await page.getByRole('button', { name: 'Refresh', exact: true }).waitFor();
    assert.equal(await page.locator('article').count(), 25, 'Completed preparation restores the verified report');
    assert.equal(apiReads, 3, 'Bounded preparation resumes only the requested report');
    mode = 'outage';
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('Temporary fixture outage. Please try again.').waitFor();
    assert.equal(await page.locator('article').count(), 0, 'Failed authorization/read must not leave old data visible');
    assert.equal(await page.getByRole('button', { name: 'Refresh', exact: true }).isEnabled(), true);
    mode = 'success';
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.locator('article').first().waitFor();
    assert.deepEqual(errors, []);
    console.log(`${label}: paging, local filters, loading, outage/retry, date, read-only requests and responsive layout passed (${apiReads} explicit reads).`);
  } finally { await browser.close(); }
}
(async () => {
  // A pre-existing port is never reused or terminated.
  const net = require('node:net');
  const probe = net.createServer(); await new Promise((resolve, reject) => probe.once('error', reject).listen(port, '127.0.0.1', resolve));
  await new Promise(resolve => probe.close(resolve));
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', bytes => { logs += bytes; }); server.stderr.on('data', bytes => { logs += bytes; });
  try {
    await waitReady();
    await scenario(chromium, { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true }, 'desktop');
    await scenario(webkit, { headless: true }, 'mobile-webkit');
  } finally {
    if (server.exitCode === null) { server.kill(); await once(server, 'exit'); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
