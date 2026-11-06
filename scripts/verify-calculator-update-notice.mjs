import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { loadTsModule, bootstrapHtml, root } from './verify-business-configuration.mjs';

const { calculatorUpdateNoticeScript, injectCalculatorUpdateNotice } = loadTsModule('lib/calculator-update-notice.ts');
const { calculatorReleaseVersion } = loadTsModule('lib/calculator-release.ts');
const oldVersion = 'a'.repeat(40), nextVersion = 'b'.repeat(40);
const priorVersion = process.env.VERCEL_GIT_COMMIT_SHA;
try {
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  assert.equal(calculatorReleaseVersion(), null);
  process.env.VERCEL_GIT_COMMIT_SHA = 'invalid';
  assert.equal(calculatorReleaseVersion(), null);
  process.env.VERCEL_GIT_COMMIT_SHA = nextVersion.toUpperCase();
  assert.equal(calculatorReleaseVersion(), nextVersion);
} finally {
  if (priorVersion === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
  else process.env.VERCEL_GIT_COMMIT_SHA = priorVersion;
}
assert.equal(calculatorUpdateNoticeScript(null), '');
assert.equal(calculatorUpdateNoticeScript('</script>'), '');
let script = calculatorUpdateNoticeScript(oldVersion).match(/<script>([\s\S]*)<\/script>/)[1];
if (process.argv.includes('--production')) {
  const built = fs.readFileSync(path.join(root, '.next/server/app/calculator/raw/route.js'), 'utf8');
  const ast = ts.createSourceFile('production.js', built, ts.ScriptTarget.Latest, true);
  let emitted;
  function visit(node) {
    if (!emitted && ts.isFunctionDeclaration(node) && node.getText(ast).includes('Calculator update available')) emitted = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(emitted, 'production build contains the self-contained notice function');
  script = `(${emitted})(${JSON.stringify(oldVersion)});`;
}
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

function fixture() {
  let now = 100000, timerId = 0, reloads = 0, allowed = true, answer = true;
  const timers = new Map(), events = new Map(), requests = [], confirmations = [];
  const on = (name, fn) => { const list = events.get(name) || []; list.push(fn); events.set(name, list); };
  class Element {
    children = []; handlers = {}; disabled = false; parent = null; textContent = '';
    constructor(tag) { this.tagName = tag; }
    setAttribute() {}
    append(...nodes) { nodes.forEach(node => { node.parent = this; this.children.push(node); }); }
    prepend(node) { node.parent = this; this.children.unshift(node); }
    remove() { this.parent.children = this.parent.children.filter(node => node !== this); }
    addEventListener(name, fn) { this.handlers[name] = fn; }
  }
  const body = new Element('body');
  const document = { body, visibilityState: 'visible', readyState: 'complete', createElement: tag => new Element(tag), addEventListener: on };
  let respond = async () => ({ ok: true, json: async () => ({ version: oldVersion }) });
  const window = { addEventListener: on, __calculatorCanRefresh: () => allowed,
    confirm(text) { confirmations.push(text); return typeof answer === 'function' ? answer() : answer; },
    location: { reload() { reloads++; } } };
  const sandbox = { window, document, AbortController, Date: { now: () => now }, Math,
    fetch(url, options) { requests.push({ url, options }); return respond(url, options); },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms, repeat: false }); return id; },
    setInterval(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms, repeat: true }); return id; },
    clearTimeout(id) { timers.delete(id); }, clearInterval(id) { timers.delete(id); } };
  vm.runInNewContext(script, sandbox);
  const dispatch = name => { for (const fn of events.get(name) || []) fn(); };
  return { window, document, timers, requests, confirmations,
    get reloads() { return reloads; }, get notice() { return body.children[0]; },
    get button() { return body.children[0]?.children[1]; },
    respond(fn) { respond = fn; }, allow(value) { allowed = value; }, answer(value) { answer = value; },
    dispatch,
    async check() { now += 60001; dispatch('visibilitychange'); await tick(); },
    async timer(ms) { const found = [...timers].find(([, t]) => t.ms === ms); assert.ok(found, `timer ${ms}`);
      if (!found[1].repeat) timers.delete(found[0]); found[1].fn(); await tick(); },
  };
}

const f = fixture();
assert.equal(f.requests.length, 0, 'no blocking startup request');
await f.check();
assert.equal(f.notice, undefined, 'same release stays quiet');
assert.equal(f.requests[0].url, '/api/calculator-version');
assert.equal(f.requests[0].options.cache, 'no-store');
assert.equal(f.requests[0].options.credentials, 'omit');
assert.equal(f.requests[0].options.redirect, 'error');
f.dispatch('visibilitychange'); await tick();
assert.equal(f.requests.length, 1, 'focus checks are throttled');
for (const response of [
  async () => { throw new Error('offline'); },
  async () => ({ ok: false }),
  async () => ({ ok: true, json: async () => ({ version: '<script>' }) }),
  async () => ({ ok: true, json: async () => { throw new Error('bad JSON'); } }),
]) { f.respond(response); await f.check(); assert.equal(f.notice, undefined); }
f.respond(async () => ({ ok: true, json: async () => ({ version: nextVersion }) }));
f.allow(false); await f.check();
assert.equal(f.button.disabled, true, 'pending saves block update action');
assert.equal(f.reloads, 0, 'a new release never refreshes automatically');
f.button.handlers.click(); assert.equal(f.confirmations.length, 0);
f.allow(true); f.dispatch('calculator-cloud-save-status'); await f.timer(0);
assert.equal(f.button.disabled, false);
f.answer(false); f.button.handlers.click(); assert.equal(f.reloads, 0, 'cancel preserves current page');
assert.match(f.confirmations[0], /system not added to a quote/);
f.answer(() => { f.allow(false); return true; }); f.button.handlers.click();
assert.equal(f.reloads, 0, 'workspace change during confirmation prevents refresh');
f.allow(true); f.answer(true); f.button.handlers.click(); assert.equal(f.reloads, 1);
await f.check(); assert.equal(f.document.body.children.length, 1, 'notice is not duplicated');
f.document.visibilityState = 'hidden'; const beforeHidden = f.requests.length;
await f.check(); assert.equal(f.requests.length, beforeHidden, 'hidden tabs do not poll');
f.document.visibilityState = 'visible';
f.respond(async () => ({ ok: true, json: async () => ({ version: oldVersion }) })); await f.check();
assert.equal(f.notice, undefined, 'a rollback to the loaded release clears the notice');
f.respond((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('timeout')))));
await f.check(); const hungCount = f.requests.length; await f.check(); assert.equal(f.requests.length, hungCount, 'one check in flight');
await f.timer(4000); assert.equal(f.requests.at(-1).options.signal.aborted, true);
f.dispatch('pagehide'); assert.equal(f.timers.size, 0, 'pagehide cleans up polling');
f.dispatch('pageshow'); assert.equal([...f.timers.values()].some(t => t.ms === 300000), true, 'bfcache restore resumes checks');
const missingGuard = fixture(); delete missingGuard.window.__calculatorCanRefresh;
missingGuard.respond(async () => ({ ok: true, json: async () => ({ version: nextVersion }) })); await missingGuard.check();
assert.equal(missingGuard.button.disabled, true);
console.log('Update notice unit checks passed: versions, quiet failures, throttling, lifecycle, explicit confirmation and fail-closed refresh.');

if (process.argv.includes('--browser')) {
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const out = path.join(root, 'outputs/update-notice'); fs.mkdirSync(out, { recursive: true });
  try {
    for (const [name, viewport] of [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
      const page = await browser.newPage({ viewport });
      const errors = [], versionRequests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (request.url().includes('calculator-version')) versionRequests.push(request.url()); });
      const originalNotice = calculatorUpdateNoticeScript(oldVersion);
      const compiledNotice = originalNotice.replace(/<script>[\s\S]*<\/script>/, () => `<script>${script}</script>`);
      const html = injectCalculatorUpdateNotice(bootstrapHtml({ draft: 'saved' }), oldVersion).replace(originalNotice, () => compiledNotice);
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/calculator/raw') return route.fulfill({ contentType: 'text/html', body: html });
        if (url.pathname === '/api/calculator-version') return route.fulfill({ json: { version: nextVersion } });
        if (url.pathname === '/api/calculator-data') return route.fulfill({ json: { ok: true } });
        return route.abort();
      });
      await page.goto('https://calculator.example.test/calculator/raw');
      assert.deepEqual(errors, [], 'injection preserves the calculator script and printable template');
      await page.evaluate(() => { window.__calculatorCanRefresh = () => true; document.dispatchEvent(new Event('visibilitychange')); });
      const notice = page.locator('#calculatorUpdateNotice');
      try { await notice.waitFor({ timeout: 5000 }); }
      catch (error) { console.error({ errors, versionRequests, state: await page.evaluate(() => ({ visibility: document.visibilityState, ready: document.readyState, scripts: [...document.scripts].map(s => s.textContent.includes('Calculator update available')) })) }); throw error; }
      assert.equal(await notice.getByRole('button', { name: 'Refresh calculator' }).isEnabled(), true);
      const box = await notice.boundingBox(); assert.ok(box.x >= 0 && box.width <= viewport.width);
      const buttonBox = await notice.locator('button').boundingBox(); assert.ok(buttonBox.height >= 44 && buttonBox.x + buttonBox.width <= viewport.width);
      assert.equal(await notice.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'notice never clips horizontally');
      await page.screenshot({ path: path.join(out, `${name}.png`) });
      await page.evaluate(() => { window.__calculatorCanRefresh = () => false; window.dispatchEvent(new Event('calculator-cloud-save-status')); });
      await page.waitForFunction(() => document.querySelector('#calculatorUpdateNotice button').disabled);
      await page.close();
    }
  } finally { await browser.close(); }
  console.log('Update notice browser checks passed at desktop 1280px and mobile 390px.');
}
