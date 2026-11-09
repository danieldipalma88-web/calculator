import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createBrotliCompress, constants } from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { bootstrapHtml, loadTsModule } from './verify-business-configuration.mjs';

const require = createRequire(import.meta.url);
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const engine = process.env.QA_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(engine), 'QA_BROWSER must be chromium or webkit');
const { calculatorTransferResponse, calculatorJsonResponse } = loadTsModule('lib/calculator-transfer-response.ts');
const { readCalculatorSavePayload } = loadTsModule('lib/calculator-save-payload.ts');
const history = JSON.stringify([{ id: 'synthetic-backup', name: 'Large fixture', quotes: [
  { id: 'synthetic-row', model: 'TEST-OUT/TEST-IN', unitPriceInc: 1000, rebate: 500, notes: '"'.repeat(1400000) },
] }]);
let stored, unavailable = false;
const transfers = [], browserErrors = [], serverErrors = [];
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
      const largeHtml = '<!doctype html><html><head><title>Save transport fixture</title></head><body><h1>Save transport fixture</h1><script>' + bootstrap + '</script></body></html>';
      response = await calculatorTransferResponse(request,
        largeHtml,
        { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    } else if (incoming.url === '/api/calculator-data') {
      response = await calculatorJsonResponse(request, { data: stored }, { status: 206, headers: {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Cookie',
      } });
    } else response = new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    if (incoming.method === 'GET' && (incoming.url === '/' || incoming.url === '/api/calculator-data')) {
      const transfer = { direction: 'load', originEncoding: response.headers.get('content-encoding'), edgeEncoding: 'br' };
      transfers.push(transfer);
      assert.equal(response.headers.get('content-encoding'), null, 'Hosting, not the route, owns response encoding');
      const headers = Object.fromEntries(response.headers);
      delete headers['content-encoding'];
      delete headers['content-length'];
      headers['content-encoding'] = 'br';
      headers.vary = [headers.vary, 'Accept-Encoding'].filter(Boolean).join(', ');
      outgoing.writeHead(response.status, headers);
      let bodyBytes = 0;
      const counter = new Transform({ transform(chunk, encoding, callback) {
        bodyBytes += chunk.length;
        callback(null, chunk);
      } });
      // Model the host replacing any route encoding with Brotli, preserving streaming backpressure.
      await pipeline(Readable.fromWeb(response.body), counter,
        createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }), outgoing);
      transfer.bodyBytes = bodyBytes;
      assert.ok(bodyBytes > 4_500_000, 'Large HTML and JSON stay above 4.5 MB before edge encoding');
      return;
    }
    const wire = Buffer.from(await response.arrayBuffer());
    outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(wire);
  } catch (error) {
    serverErrors.push(error.message);
    if (outgoing.headersSent) outgoing.destroy();
    else { outgoing.writeHead(500); outgoing.end(error.message); }
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await (engine === 'webkit' ? webkit : chromium).launch({
  executablePath: engine === 'chromium' ? (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined) : undefined,
});
try {
  for (const width of [1280, 390]) {
    stored = { draft: 'cloud baseline', installerSavedQuoteSetsV1: history };
    unavailable = false;
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const onPageError = error => browserErrors.push(error.message);
    page.on('pageerror', onPageError);
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.addInitScript(() => {
      const original = window.setTimeout;
      window.setTimeout = (fn, delay, ...args) => original(fn,
        (delay >= 3000 && delay < 3500) || (delay >= 10000 && delay < 10500) ? 30 : delay, ...args);
    });
    await page.goto(origin, { waitUntil: 'load' });
    await page.getByRole('heading', { name: 'Save transport fixture' }).waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('installerSavedQuoteSetsV1'))[0].quotes[0].notes.length), 1400000);
    assert.deepEqual(await page.evaluate(async () => {
      const response = await fetch('/api/calculator-data');
      const body = await response.json();
      return { status: response.status, cache: response.headers.get('cache-control'), vary: response.headers.get('vary'),
        noteLength: JSON.parse(body.data.installerSavedQuoteSetsV1)[0].quotes[0].notes.length };
    }), { status: 206, cache: 'no-store', vary: 'Cookie, Accept-Encoding', noteLength: 1400000 });
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
    await page.waitForLoadState('networkidle');
    // WebKit reports cancelled background fetches as errors during deliberate page teardown.
    page.removeListener('pageerror', onPageError);
    await page.close();
  }
  assert.deepEqual(browserErrors, []);
  assert.deepEqual(serverErrors, []);
  assert.ok(transfers.some(item => item.direction === 'save' && item.rawBytes > 5_200_000));
  assert.ok(transfers.filter(item => item.direction === 'save').every(item => item.encoded === 'application/vnd.rebate-portal.calculator-save+gzip'));
  assert.ok(transfers.filter(item => item.direction === 'load').every(item => item.originEncoding === null && item.edgeEncoding === 'br' && item.bodyBytes > 4_500_000));
  console.log(JSON.stringify({ passed: true, browser: engine, widths: [1280, 390], transfers,
    scope: 'Loopback HTTP edge simulation: strip origin encoding, Brotli streamed body, gzip upload, outage recovery and exact quote values' }));
} finally {
  await browser.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
