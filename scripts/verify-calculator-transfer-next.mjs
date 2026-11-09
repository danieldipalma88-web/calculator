import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await mkdtemp(join(tmpdir(), 'calculator-transfer-next-'));
const nextBin = require.resolve('next/dist/bin/next');
let server;
let serverLog = '';
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1' };
// Never load the calculator's production configuration or connect to real services.
for (const key of Object.keys(env)) {
  if (/SUPABASE|VERCEL|RESEND|OPENAI|DATABASE|MODEL_RESEARCH|CRON_SECRET/i.test(key)) delete env[key];
}
const sample = 'Synthetic quote: \u00e9 \u65e5\u672c \ud83d\ude80 ';
const payload = sample.repeat(180000);
const value = { fixture: true, unitPriceInc: 1000, rebate: 500, payload };
const json = JSON.stringify(value);
const html = '<!doctype html><html><head><title>Transport test</title></head><body><h1>Calculator ready</h1><!--' + payload + '--></body></html>';

try {
  await mkdir(join(fixture, 'app'));
  await symlink(join(root, 'node_modules'), join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ name: 'calculator-transport-fixture', private: true, type: 'module' }));
  await writeFile(join(fixture, 'next.config.mjs'), 'export default { poweredByHeader: false, experimental: { cpus: 1 } };');
  await writeFile(join(fixture, 'middleware.js'), "import { NextResponse } from 'next/server'; export function middleware() { return NextResponse.next(); }");
  const source = await readFile(join(root, 'lib/calculator-transfer-response.ts'), 'utf8');
  await writeFile(join(fixture, 'transfer.js'), ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText);
  await writeFile(join(fixture, 'app/route.js'), `
    import { calculatorTransferResponse, calculatorJsonResponse } from '../transfer.js';
    export const dynamic = 'force-dynamic';
    export const runtime = 'nodejs';
    const value = ${JSON.stringify(value)};
    const html = ${JSON.stringify(html)};
    export function GET(request) {
      const init = { headers: { 'Cache-Control': 'no-store' } };
      if (new URL(request.url).searchParams.get('format') === 'json') return calculatorJsonResponse(request, value, init);
      init.headers['Content-Type'] = 'text/html; charset=utf-8';
      return calculatorTransferResponse(request, html, init);
    }
  `);
  console.log('Building isolated production Next.js transport fixture (synthetic data only).');
  const build = spawn(process.execPath, [nextBin, 'build', fixture], { cwd: fixture, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let buildLog = '';
  build.stdout.on('data', chunk => { buildLog += chunk; });
  build.stderr.on('data', chunk => { buildLog += chunk; });
  const buildTimer = setTimeout(() => build.kill(), 180000);
  const [code] = await once(build, 'exit');
  clearTimeout(buildTimer);
  assert.equal(code, 0, buildLog);
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  server = spawn(process.execPath, [nextBin, 'start', fixture, '--hostname', '127.0.0.1', '--port', String(port)],
    { cwd: fixture, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  server.stdout.on('data', chunk => { serverLog += chunk; });
  server.stderr.on('data', chunk => { serverLog += chunk; });
  const origin = 'http://127.0.0.1:' + port;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(serverLog);
    try { await fetch(origin, { method: 'HEAD', signal: AbortSignal.timeout(2000) }); ready = true; break; } catch { await delay(100); }
  }
  assert.ok(ready, 'Next production server failed to start: ' + serverLog);
  for (const encoding of ['gzip, deflate, br', 'gzip', 'identity', 'gzip;q=0, br;q=1']) {
    for (const format of ['html', 'json']) {
      const response = await fetch(origin + '/?format=' + format, {
        headers: { 'Accept-Encoding': encoding }, signal: AbortSignal.timeout(20000),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.ok(response.headers.get('content-type').includes(format === 'json' ? 'application/json' : 'text/html'));
      const actual = Buffer.from(await response.arrayBuffer());
      assert.ok(actual.length > 4_500_000, 'Fixture must exercise responses above the buffered hosting limit');
      assert.notEqual(actual.subarray(0, 2).toString('hex'), '1f8b', `${format}/${encoding}: gzip bytes leaked into the browser-decoded response`);
      assert.equal(actual.toString('utf8'), format === 'json' ? json : html, `${format}/${encoding}: response changed in the framework transport`);
    }
  }
  const head = await fetch(origin, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  console.log(JSON.stringify({ passed: true, framework: require('next/package.json').version,
    checks: 9, htmlBytes: Buffer.byteLength(html), jsonBytes: Buffer.byteLength(json),
    scope: 'Actual next build/start, middleware, negotiated compression, HTML and JSON, synthetic data only' }));
} finally {
  if (server && server.exitCode === null) {
    const closed = once(server, 'exit');
    server.kill();
    await closed;
  }
  assert.ok(fixture.startsWith(join(tmpdir(), 'calculator-transfer-next-')));
  await rm(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
