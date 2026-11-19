const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const ts = require('typescript');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app/admin/users/page.tsx'), 'utf8');
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const extract = name => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast);
const fixture = fs.mkdtempSync(path.join(__dirname, '.admin-lazy-next-'));
const write = (file, contents) => {
  const target = path.join(fixture, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
};

// This temporary app uses real Next RSC navigation and the actual owned client/runtime.
// Its only data source is the synthetic counter below; it has no Supabase configuration.
write('package.json', JSON.stringify({ name: 'admin-lazy-fixture', private: true }));
write('next.config.js', 'module.exports={devIndicators:false};');
write('app/layout.tsx', `import './globals.css'; export default function Layout({children}) {return <html lang="en"><body>{children}</body></html>}`);
write('app/globals.css', fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8'));
write('app/admin/users/admin-workspace.tsx', fs.readFileSync(path.join(root, 'app/admin/users/admin-workspace.tsx'), 'utf8'));
write('app/admin/users/fixture-state.ts', `
export function state(){return (globalThis as any).__adminLazyFixture ||= {reads:0,fail:0,delay:0};}
`);
write('app/admin/users/fixture-input.tsx', `"use client"; import {useState} from 'react';
export default function FixtureInput(){const [value,setValue]=useState('Saved selection');return <label>Controlled selection<input name="controlled" value={value} onChange={event=>setValue(event.target.value)}/></label>}
`);
write('app/api/fixture/route.ts', `import {state} from '../../admin/users/fixture-state';
export async function GET(request:Request){const query=new URL(request.url).searchParams,s=state();
if(query.has('fail'))s.fail=Number(query.get('fail'));if(query.has('delay'))s.delay=Number(query.get('delay'));
return Response.json(s);}
`);
const runtimeSource = extract('wonExportScript').replace('refresh: function(){', 'refresh: function(){ window.__fixtureRuntimeRefreshes=(window.__fixtureRuntimeRefreshes||0)+1;');
write('app/admin/users/page.tsx', `
import Script from 'next/script';import {redirect} from 'next/navigation';
import AdminWorkspace,{AdminPanel} from './admin-workspace';import FixtureInput from './fixture-input';import {state} from './fixture-state';
${extract('wonJobsRequested')}
${runtimeSource}
async function fixtureAction(){'use server';redirect('/admin/users?view=jobs&message=Fixture+action+confirmed#won-options');}
export default async function Page({searchParams}){
const params=await searchParams,load=wonJobsRequested(params),s=state();let unavailable=false;
if(load){s.reads++;if(s.delay)await new Promise(resolve=>setTimeout(resolve,s.delay));if(s.fail){s.fail--;unavailable=true;}}
const initialView=['businesses','users','prices','jobs'].includes(params.view)?params.view:load?'jobs':undefined;
return <main className="admin-shell"><section className="admin-card"><h1>Admin lazy fixture</h1>
<a id="review-jobs" href="#won-options">Review Won Jobs</a>
<AdminWorkspace storageScope="synthetic-admin" initialView={initialView} jobsLoaded={load} jobsUnavailable={unavailable}>
<AdminPanel view="businesses" id="businesses"><details data-admin-record="business:fixture"><summary>Fixture business</summary><form><label>Business name<input name="businessName" defaultValue="Saved business"/></label><label><input name="membership" type="checkbox" defaultChecked/>Business membership</label></form></details></AdminPanel>
<AdminPanel view="users" id="approved-users"><details data-admin-record="user:fixture"><summary>Fixture user</summary><form><label>User name<input name="userName" defaultValue="Saved user"/></label><FixtureInput/></form></details></AdminPanel>
<AdminPanel view="prices" id="certificate-values"><form><label>Spot price<input name="spotPrice" defaultValue="29"/></label></form></AdminPanel>
<AdminPanel view="jobs" id="won-options" className="won-options-section"><h2>Won Quotes</h2>
{load&&!unavailable?<div data-fixture-jobs><button type="button" data-won-payment-filter="all" className="is-active">All payments</button><input data-won-search placeholder="Search fixture jobs"/><div className="won-grid"/><aside data-won-mobile-selection-dock hidden/><form action={fixtureAction}><button type="submit">Fixture job action</button></form></div>:null}</AdminPanel>
</AdminWorkspace></section><Script id="admin-users-page-actions" strategy="afterInteractive">{wonExportScript()}</Script></main>}
`);

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

(async () => {
  let child, browser;
  let output = '';
  try {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: fixture, windowsHide: true, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NEXT_PUBLIC_SUPABASE_URL: '', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error(output);
      try { if ((await fetch(origin + '/api/fixture')).ok) { ready = true; break; } } catch {}
      await pause(400);
    }
    assert.ok(ready, output);
    const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
      (process.platform === 'win32' && fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined);
    browser = await engine.launch({ headless: true, ...(engine === chromium && executablePath ? { executablePath } : {}) });
    const stats = async query => (await fetch(origin + '/api/fixture' + (query || ''))).json();
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, ...(width === 390 && engine === chromium ? { isMobile: true, hasTouch: true } : {}) });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      const tab = name => page.getByRole('tab', { name, exact: true });
      await page.goto(origin + '/admin/users?fixtureParam=preserved');
      await tab('Businesses').waitFor();
      await page.waitForFunction(() => window.__adminWonOptionsHandlersBound);
      const before = (await stats()).reads;
      await page.locator('#businesses summary').click();
      await page.getByLabel('Business name', { exact: true }).fill('Unsaved business');
      await page.getByLabel('Business membership').uncheck();
      await tab('Users').click();
      await page.locator('#approved-users summary').click();
      await page.getByLabel('User name', { exact: true }).fill('Unsaved user');
      await page.getByLabel('Controlled selection').fill('Unsaved controlled selection');
      await tab('Spot Prices').click();
      await page.getByLabel('Spot price', { exact: true }).fill('41.25');
      assert.equal((await stats()).reads, before, 'Other tabs perform no Jobs reads');
      const identity = await page.evaluate(() => { window.__fixtureDocument = 'same-document'; return performance.timeOrigin; });
      await stats('?fail=1&delay=700');
      await tab('Won Jobs').click();
      await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
      assert.equal((await stats()).reads, before + 1, 'First click must fetch a real RSC Jobs payload');
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await page.locator('[data-fixture-jobs]').waitFor();
      await page.waitForFunction(() => window.__fixtureRuntimeRefreshes >= 3);
      assert.equal((await stats()).reads, before + 2, 'Same-URL retry must fetch fresh server data');
      assert.equal(new URL(page.url()).searchParams.get('fixtureParam'), 'preserved');
      assert.equal(await page.evaluate(() => window.__fixtureDocument), 'same-document');
      assert.equal(await page.evaluate(() => performance.timeOrigin), identity);
      for (const [name, selector, value] of [['Businesses', 'Business name', 'Unsaved business'], ['Users', 'User name', 'Unsaved user'], ['Spot Prices', 'Spot price', '41.25']]) {
        await tab(name).click();
        assert.equal(await page.getByLabel(selector, { exact: true }).inputValue(), value);
      }
      await tab('Users').click();
      assert.equal(await page.getByLabel('Controlled selection').inputValue(), 'Unsaved controlled selection');
      await tab('Businesses').click();
      assert.equal(await page.getByLabel('Business membership').isChecked(), false);
      await tab('Won Jobs').click();
      assert.equal((await stats()).reads, before + 2, 'Returning to an already loaded panel does not refetch');
      const refreshes = await page.evaluate(() => window.__fixtureRuntimeRefreshes);
      await page.getByRole('button', { name: 'Fixture job action' }).click();
      await page.waitForURL(url => url.searchParams.get('message') === 'Fixture action confirmed');
      await page.waitForFunction(previous => window.__fixtureRuntimeRefreshes > previous, refreshes);
      assert.equal(await tab('Won Jobs').getAttribute('aria-selected'), 'true');

      await page.goto(origin + '/admin/users?view=users&fixtureParam=preserved#approved-users');
      await tab('Users').waitFor();
      await stats('?delay=1400');
      await tab('Won Jobs').click();
      await tab('Users').click();
      await page.locator('[data-fixture-jobs]').waitFor({ state: 'attached' });
      await page.waitForFunction(() => document.getElementById('admin-tab-users')?.getAttribute('aria-selected') === 'true');
      assert.equal(new URL(page.url()).hash, '#approved-users', 'Late payload must not jump back to Jobs');
      await stats('?delay=0');

      await page.goto(origin + '/admin/users?fixtureParam=preserved#won-options');
      await page.locator('[data-fixture-jobs]').waitFor();
      assert.equal(await tab('Won Jobs').getAttribute('aria-selected'), 'true', 'Hash deep links lazy load Jobs');
      await page.evaluate(() => {
        sessionStorage.setItem('calculator-admin-workspace-v1:synthetic-admin', JSON.stringify({ view: 'jobs' }));
        history.replaceState(history.state, '', '/admin/users?fixtureParam=preserved');
      });
      await page.reload();
      await page.locator('[data-fixture-jobs]').waitFor();
      assert.equal(await tab('Won Jobs').getAttribute('aria-selected'), 'true', 'Session-restored Jobs lazy loads');
      assert.deepEqual(errors, []);
      console.log(`PASS admin lazy real Next browser ${engine.name()} ${width}px: RSC load/retry, forms, runtime, action redirect, deep link, restored session and in-flight tab switch.`);
      await context.close();
    }
  } catch (error) {
    console.error(output.slice(-12000));
    throw error;
  } finally {
    if (browser) await browser.close();
    if (child && child.exitCode === null) {
      const closed = new Promise(resolve => child.once('exit', resolve));
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        await new Promise(resolve => killer.once('exit', resolve));
      } else child.kill('SIGTERM');
      await closed;
    }
    const resolved = path.resolve(fixture);
    assert.equal(path.dirname(resolved), path.resolve(__dirname));
    assert.ok(path.basename(resolved).startsWith('.admin-lazy-next-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
