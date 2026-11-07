import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { loadTsModule } from './verify-business-configuration.mjs';

const { readCalculatorSavePayload: read, CALCULATOR_GZIP_CONTENT_TYPE: gzipType } = loadTsModule('lib/calculator-save-payload.ts');
const { calculatorTransferResponse, calculatorJsonResponse } = loadTsModule('lib/calculator-transfer-response.ts');
const request = (body, type = 'application/json', extra = {}) => new Request('https://calculator.test/api/calculator-data', {
  method: 'PUT', headers: { 'Content-Type': type, ...extra }, body,
});
const payload = { data: { installerSavedQuoteSetsV1: JSON.stringify([{ name: 'Synthetic large history',
  quotes: [{ id: 'row-1', unitPriceInc: 962.98, rebate: 755.68, notes: 'quote "note" '.repeat(450000) }] }]) },
  expectedWorkspace: { accountEmail: 'fixture@example.test', viewingEmail: 'fixture@example.test', businessId: null } };
const json = JSON.stringify(payload), compressed = gzipSync(json);
assert.ok(Buffer.byteLength(json) > 5_200_000);
assert.ok(compressed.length < 4_400_000);
assert.deepEqual(await read(request(compressed, gzipType)), payload, 'Large save transport preserves every value exactly');
assert.deepEqual(await read(request('{"data":{"note":"small legacy save"}}')), { data: { note: 'small legacy save' } });
assert.deepEqual(await read(request(gzipSync('{"data":{"note":"\u00e9 \ud83d\ude80"}}'), gzipType)), { data: { note: '\u00e9 \ud83d\ude80' } });

async function rejected(body, type, code, extra) {
  await assert.rejects(read(request(body, type, extra)), error => error.code === code && error.status >= 400);
}
await rejected('broken gzip', gzipType, 'CALCULATOR_SAVE_INVALID');
await rejected(compressed.subarray(0, compressed.length - 5), gzipType, 'CALCULATOR_SAVE_INVALID');
await rejected('{broken json', 'application/json', 'CALCULATOR_SAVE_INVALID');
for (const invalid of ['null', '[]', 'true', '"text"', '']) await rejected(invalid, 'application/json', 'CALCULATOR_SAVE_INVALID');
await rejected(Buffer.from([0xff, 0xff]), 'application/json', 'CALCULATOR_SAVE_INVALID');
await rejected('x', 'application/json', 'CALCULATOR_SAVE_TOO_LARGE', { 'content-length': '4400001' });
await rejected('x'.repeat(4_400_001), 'application/json', 'CALCULATOR_SAVE_TOO_LARGE');
for (const cancellation of ['rejected', 'stalled']) {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4_400_001)); },
    cancel() {
      cancelled = true;
      return cancellation === 'rejected' ? Promise.reject(new Error('Cancellation failed')) : new Promise(() => {});
    },
  });
  let timer;
  try {
    await assert.rejects(Promise.race([
      read(new Request('https://calculator.test/api/calculator-data', { method: 'PUT', body: stream, duplex: 'half' })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Oversize response stalled')), 500); }),
    ]), error => error.code === 'CALCULATOR_SAVE_TOO_LARGE' && error.status === 413,
    `Oversized input must return 413 immediately when cancellation is ${cancellation}`);
    assert.equal(cancelled, true, 'Oversized input still attempts to stop reading');
  } finally { clearTimeout(timer); }
}
await rejected(gzipSync('x'.repeat(32_000_001)), gzipType, 'CALCULATOR_SAVE_TOO_LARGE');
const abort = new AbortController(); abort.abort();
await assert.rejects(read(new Request('https://calculator.test/api/calculator-data', {
  method: 'PUT', body: compressed, headers: { 'Content-Type': gzipType }, signal: abort.signal,
})), error => error.name === 'AbortError');
for (const acceptEncoding of ['gzip', 'br, gzip, deflate', '*;q=0.5']) {
  const response = await calculatorJsonResponse(new Request('https://calculator.test', { headers: { 'Accept-Encoding': acceptEncoding } }), payload,
    { headers: { 'Cache-Control': 'no-store', Vary: 'Cookie' } });
  assert.equal(response.headers.get('Content-Encoding'), 'gzip');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Vary'), 'Cookie, Accept-Encoding');
  const wire = Buffer.from(await response.arrayBuffer());
  assert.ok(wire.length < 4_400_000);
  assert.deepEqual(JSON.parse(gunzipSync(wire)), payload, 'Reopening a large history is also lossless');
}
for (const acceptEncoding of ['', 'br', 'gzip;q=0', '*;q=1, gzip;q=0']) {
  const response = await calculatorTransferResponse(new Request('https://calculator.test', { headers: { 'Accept-Encoding': acceptEncoding } }), json);
  assert.equal(response.headers.get('Content-Encoding'), null, 'Respect clients that cannot accept gzip');
  assert.equal(await response.text(), json);
}
const smallResponse = await calculatorJsonResponse(new Request('https://calculator.test', { headers: { 'Accept-Encoding': 'gzip' } }), { ok: true });
assert.deepEqual(await smallResponse.json(), { ok: true });
assert.equal(smallResponse.headers.get('Content-Encoding'), null);
console.log(JSON.stringify({ result: 'passed', originalBytes: Buffer.byteLength(json), wireBytes: compressed.length,
  coverage: 'lossless large payload, legacy JSON, Unicode, invalid/truncated gzip, malformed JSON, bounded wire/decompression sizes and cancellation' }));
