import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { bootstrapHtml, loadTsModule } from './verify-business-configuration.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const { calculatorTransferResponse, calculatorJsonResponse } = loadTsModule('lib/calculator-transfer-response.ts');
const { readCalculatorSavePayload } = loadTsModule('lib/calculator-save-payload.ts');
const history = JSON.stringify([{ id: 'synthetic-backup', name: 'Large fixture', quotes: [
  { id: 'synthetic-row', model: 'TEST-OUT/TEST-IN', unitPriceInc: 1000, rebate: 500, notes: '"'.repeat(1400000) },
] }]);
let stored, unavailable = false;
const transfers = [], browserErrors = [];
const server = createServer(async (incoming, outgoing) => {
  try {
    const request = new Request('http://' + incoming.headers.host + incoming.url, {
      method: incoming.method, headers: incoming.headers,
      ...(incoming.method === 'PUT' ? { body: incoming, duplex: 'half' } : {}),
    });
    let response;
    if (incoming.method === 'PUT' && incoming.url.startsWith('/api/calculator-data')) {
      const body = await readCalculatorSavePayload(request);
      transfers.push({ direction: 'save', encoded: request.headers.get('content-type'), rawBytes: Buffer.byteLength(JSON.stringify(body)) });
      if (unavailable) response = Response.json({ error: 'Synthetic outage' }, { status: 503 });
      else { stored = body.data; response = Response.json({ ok: true }); }
    } else if (incoming.url === '/') {
      const bootstrap = bootstrapHtml(stored).match(/<script>([\s\S]*?)<\/script>/)[1];
      response = await calculatorTransferResponse(request,
        '<!doctype html><html><head><title>Save transport fixture</title></head><body><h1>Save transport fixture</h1><script>' + bootstrap + '</script></body></html>',
        { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    } else if (incoming.url === '/api/calculator-data') {
      response = await calculatorJsonResponse(request, { data: stored }, { headers: { 'Cache-Control': 'no-store' } });
    } else response = new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    const wire = Buffer.from(await response.arrayBuffer());
    if (incoming.method === 'GET' && (incoming.url === '/' || incoming.url === '/api/calculator-data')) {
      transfers.push({ direction: 'load', encoded: response.headers.get('content-encoding'), wireBytes: wire.length });
      assert.ok(wire.length < 4_400_000);
    }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(wire);
  } catch (error) { outgoing.writeHead(500); outgoing.end(error.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
try {
  for (const width of [1280, 390]) {
    stored = { draft: 'cloud baseline', installerSavedQuoteSetsV1: history };
    unavailable = false;
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on('pageerror', error => browserErrors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.addInitScript(() => {
      const original = window.setTimeout;
      window.setTimeout = (fn, delay, ...args) => original(fn,
        (delay >= 3000 && delay < 3500) || (delay >= 10000 && delay < 10500) ? 30 : delay, ...args);
    });
    await page.goto(origin, { waitUntil: 'load' });
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('installerSavedQuoteSetsV1'))[0].quotes[0].notes.length), 1400000);
    await page.evaluate(async () => {
      localStorage.setItem('draft', 'confirmed large save');
      await window.__calculatorFlushCloudSave(20000);
    });
    assert.equal(stored.draft, 'confirmed large save');
    assert.equal(stored.installerSavedQuoteSetsV1, history);
    await page.reload({ waitUntil: 'load' });
    assert.equal(await page.evaluate(() => localStorage.getItem('draft')), 'confirmed large save');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('installerSavedQuoteSetsV1'))[0].quotes[0].unitPriceInc), 1000);
    const apiData = await page.evaluate(async () => (await (await fetch('/api/calculator-data')).json()).data);
    assert.equal(apiData.installerSavedQuoteSetsV1, history);
    unavailable = true;
    await page.evaluate(() => {
      localStorage.setItem('draft', 'unsaved during outage');
      window.__calculatorFlushCloudSave(20000).catch(() => {});
    });
    await page.waitForFunction(() => window.__calculatorCloudSaveState?.tone === 'error');
    assert.equal(stored.draft, 'confirmed large save');
    await page.evaluate(() => localStorage.setItem('draft', 'newest edit after outage'));
    unavailable = false;
    await page.getByRole('button', { name: 'Retry save', exact: true }).click();
    await page.waitForFunction(() => window.__calculatorCloudSaveState?.tone === 'saved');
    assert.equal(stored.draft, 'newest edit after outage');
    assert.equal(stored.installerSavedQuoteSetsV1, history);
    await page.close();
  }
  assert.deepEqual(browserErrors, []);
  assert.ok(transfers.some(item => item.direction === 'save' && item.rawBytes > 5_200_000));
  assert.ok(transfers.filter(item => item.direction === 'save').every(item => item.encoded === 'application/vnd.rebate-portal.calculator-save+gzip'));
  assert.ok(transfers.filter(item => item.direction === 'load').every(item => item.encoded === 'gzip'));
  console.log(JSON.stringify({ passed: true, widths: [1280, 390], transfers,
    scope: 'Loopback-only native HTTP gzip upload, compressed HTML/JSON reload, outage recovery and exact quote values' }));
} finally {
  await browser.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
