const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');

const root = path.resolve(__dirname, '..');
const baseline = process.env.ADMIN_SEARCH_BASELINE;
const output = path.join(root, 'outputs', 'admin-search');
fs.mkdirSync(output, { recursive: true });
const modules = [];
const ids = new Map();
const productionModules = {
  react: 'react/cjs/react.production.js',
  'react/jsx-runtime': 'react/cjs/react-jsx-runtime.production.js',
  'react-dom/client': 'react-dom/cjs/react-dom-client.production.js',
  'react-dom': 'react-dom/cjs/react-dom.production.js',
  scheduler: 'scheduler/cjs/scheduler.production.js',
};
function resolve(specifier, parent) {
  if (productionModules[specifier]) {
    const [pkg, ...rest] = productionModules[specifier].split('/');
    return path.join(path.dirname(require.resolve(`${pkg}/package.json`, { paths: [path.dirname(parent)] })), ...rest);
  }
  if (!specifier.startsWith('.')) return require.resolve(specifier, { paths: [path.dirname(parent)] });
  const file = path.resolve(path.dirname(parent), specifier);
  return ['', '.ts', '.tsx', '.js'].map(suffix => file + suffix).find(candidate => fs.existsSync(candidate));
}
function bundle(file) {
  if (ids.has(file)) return ids.get(file);
  const id = modules.length;
  ids.set(file, id);
  modules.push('');
  const relative = path.relative(root, file).replaceAll('\\', '/');
  let source = baseline && /^(app|lib)\//.test(relative)
    ? execFileSync('git', ['show', `${baseline}:${relative}`], { cwd: root, encoding: 'utf8' })
    : fs.readFileSync(file, 'utf8');
  if (file.endsWith('.css')) {
    source = `module.exports = ${JSON.stringify(Object.fromEntries([...source.matchAll(/\.([A-Za-z][\w-]*)/g)].map(match => [match[1], match[1]])))};`;
  } else if (/\.tsx?$/.test(file)) {
    source = source.replace(/(export default function (UserActivity|RemoveUserButton)\([^]*?\) \{)/, '$1 window.cardRenders++;');
    source = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  }
  source = source.replace(/require\(["']([^"']+)["']\)/g, (_, specifier) => `require(${bundle(resolve(specifier, file))})`);
  modules[id] = `function(module,exports,require){${source}\n}`;
  return id;
}
const react = bundle(resolve('react', __filename));
const client = bundle(resolve('react-dom/client', __filename));
const directory = bundle(path.join(root, 'app/admin/users/directory-list.tsx'));
const activity = bundle(path.join(root, 'app/admin/users/user-activity.tsx'));
const assignment = bundle(path.join(root, 'app/admin/users/business-multi-select.tsx'));
const removal = bundle(path.join(root, 'app/admin/users/remove-user-button.tsx'));
const css = ['app/globals.css', 'app/admin/users/directory-list.module.css', 'app/admin/users/user-activity.module.css'].map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n').replaceAll(':global(', ':is(');
const assignmentSource = ts.transpileModule(fs.readFileSync(path.join(root, 'app/admin/users/business-multi-select.tsx'), 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const assignmentExports = {};
vm.runInThisContext(`(function(exports,require){${assignmentSource}\n})`)(assignmentExports, require);
const React = require('react');
const hydrationBusinesses = [{ id: 'a', name: 'Business A' }, { id: 'b', name: 'Business B' }];
const hydrationMarkup = require('react-dom/server').renderToString(React.createElement('form', null,
  React.createElement(assignmentExports.default, { businesses: hydrationBusinesses, selectedIds: ['b', 'a'] }),
  React.createElement('button', { type: 'submit' }, 'Save fixture')));
const script = `const process={env:{NODE_ENV:'production'}};const modules=[${modules.join(',')}],cache={};function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}
window.cardRenders=0;window.writes=0;window.activityPayload=[];window.activityReads=0;
window.fetch=async(url,init={})=>{if(url!=='/api/admin/user-activity'||init.method!=='GET'){window.writes++;throw Error('Unexpected request');}window.activityReads++;return {ok:true,json:async()=>({activity:window.activityPayload})}};
const React=require(${react}),h=React.createElement,Directory=require(${directory}).default,Activity=require(${activity}).default,Assignment=require(${assignment}).default,Removal=require(${removal}).default;
const businesses=Array.from({length:156},(_,i)=>({id:'b'+i,name:'Business '+String(i).padStart(3,'0')}));
const items=Array.from({length:169},(_,i)=>{const email='user'+i+'@example.invalid',name=i===0?'Daniel Fixture':'Person '+String(i).padStart(3,'0'),lastActiveAt=i%9===0?null:new Date(Date.now()-i*86400000).toISOString();return {id:email,name,searchText:email+' Business '+String(i%156).padStart(3,'0'),createdAt:'2026-01-01',lastActiveAt,content:h('details',{className:'user-card user-card-collapsible','data-user':i,'data-admin-record':'user:'+email},h('summary',{className:'user-card-summary'},h('div',{className:'user-summary-identity'},h('strong',null,name),h('span',null,email),h(Activity,{email,initialLastActiveAt:lastActiveAt}))),h('form',{onSubmit:e=>{e.preventDefault();window.formResult=Array.from(new FormData(e.currentTarget).entries());}},h('label',null,'Name',h('input',{name:'displayName',defaultValue:name})),h(Assignment,{businesses,selectedIds:['b'+i%156]}),h('button',{type:'submit'},'Save fixture')),h(Removal,{email}))}});
if(location.pathname==='/hydrate'){
  window.beginHydration=()=>require(${client}).hydrateRoot(document.getElementById('root'),h('form',{onSubmit:e=>{e.preventDefault();window.formResult=Array.from(new FormData(e.currentTarget).entries());}},h(Assignment,{businesses:${JSON.stringify(hydrationBusinesses)},selectedIds:['b','a']}),h('button',{type:'submit'},'Save fixture')));
}else{
  const app=require(${client}).createRoot(document.getElementById('root'));
  window.renderFixture=(scope='fixture',kind='users')=>app.render(h(Directory,{items,kind,className:'user-card-grid',defaultSort:'active-newest',activitySort:true,storageScope:scope}));window.renderFixture();
}`;
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><main class="admin-shell"><section class="admin-card"><h1>Users test fixture</h1><section data-admin-panel="users"><div id="root"></div></section><button id="outside">Outside directory</button></section></main><script>${script}</script></body></html>`;

(async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(req.url === '/hydrate' ? html.replace('<div id="root"></div>', `<div id="root">${hydrationMarkup}</div>`) : html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    || (process.platform === 'win32' && fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined);
  const browser = await engine.launch({ headless: true, ...(engine === chromium && executablePath ? { executablePath } : {}) });
  const results = [];
  try {
    for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
      const errors = [];
      page.on('pageerror', error => { errors.push(error.message); console.error('Fixture page error:', error.message); });
      await page.clock.install({ time: new Date('2026-11-17T01:00:00Z') });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.getByRole('status').filter({ hasText: '169 of 169 users' }).waitFor();
      await page.waitForFunction(() => window.activityReads === 1);
      await page.waitForTimeout(100);
      if (engine === chromium && width === 390) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      }
      const search = page.getByRole('searchbox', { name: 'Search users', exact: true });
      const before = await page.evaluate(() => ({ renders: window.cardRenders, nodes: document.getElementsByTagName('*').length, checkboxes: document.querySelectorAll('input[name="businessIds"][type="checkbox"]').length }));
      const start = performance.now();
      await search.click();
      const focused = await page.evaluate(() => window.cardRenders);
      await search.pressSequentially('Daniel');
      await page.getByRole('status').filter({ hasText: '1 of 169 users' }).waitFor();
      const typed = await page.evaluate(() => window.cardRenders);
      const timingMs = Math.round(performance.now() - start);
      const measurement = { width, before, focusCardRenders: focused - before.renders, typingCardRenders: typed - focused, focusAndSearchMs: timingMs };
      console.log('Search measurement:', JSON.stringify(measurement));
      if (baseline) { results.push(measurement); await page.close(); continue; }
      if (!baseline) {
        assert.equal(focused, before.renders, 'Focusing search must not rerender account cards');
        assert.equal(typed, before.renders, 'Typing must not rerender activity/removal controls');
        assert.equal(before.checkboxes, 0, 'Closed assignment menus must not mount the full business catalogue');
        assert.ok(before.nodes < 12000, 'Collapsed directory DOM must stay bounded');
      }
      const card = page.locator('[data-user="0"]');
      await card.locator('summary').first().click();
      await card.getByLabel('Name', { exact: true }).fill('Unsaved fixture edit');
      await card.getByRole('button', { name: 'Save fixture' }).click();
      assert.deepEqual(await page.evaluate(() => window.formResult), [['displayName', 'Unsaved fixture edit'], ['businessIds', 'b0']], 'Closed assignment menu must submit original selections');
      await card.locator('.business-multiselect > summary').click();
      await card.getByText('Business 001', { exact: true }).click();
      await card.getByPlaceholder('Business name').fill('155');
      await card.locator('.business-multiselect > summary').click();
      await card.getByRole('button', { name: 'Save fixture' }).click();
      assert.deepEqual(await page.evaluate(() => window.formResult.filter(([key]) => key === 'businessIds')), [['businessIds', 'b0'], ['businessIds', 'b1']], 'Filtering business choices must not drop checked assignments');
      await search.fill('no-such-person');
      await page.getByText('No users match the current filters.').waitFor();
      await page.getByRole('button', { name: 'Clear users search' }).click();
      assert.equal(await card.getByLabel('Name', { exact: true }).inputValue(), 'Unsaved fixture edit');
      assert.equal(await card.getByPlaceholder('Business name').inputValue(), '155');
      await page.getByRole('combobox', { name: 'Sort users by' }).selectOption('name-asc');
      assert.equal(await card.getByLabel('Name', { exact: true }).inputValue(), 'Unsaved fixture edit');
      await page.getByRole('combobox', { name: 'Sort users by' }).selectOption('active-newest');
      await page.waitForTimeout(100);
      const orderBefore = await page.locator('.user-card-collapsible').evaluateAll(rows => rows.map(row => row.dataset.user));
      await page.evaluate(() => { window.activityPayload = [{ email:'user0@example.invalid',last_active_at:'2026-11-17T00:59:50Z' }]; });
      await page.clock.fastForward(60000);
      await page.waitForFunction(() => window.activityReads >= 2);
      assert.deepEqual(await page.locator('.user-card-collapsible').evaluateAll(rows => rows.map(row => row.dataset.user)), orderBefore, 'Polling must not move expanded records');
      await card.getByRole('button', { name: /Active .* ago|Active just now/ }).waitFor();
      await card.locator('summary').first().click();
      await page.locator('#outside').click();
      await page.waitForFunction(() => document.querySelector('.user-card-collapsible').dataset.user === '0');
      await page.locator('[data-user="1"] > summary').focus();
      if (width === 390) await card.getByRole('button', { name: /Active .* ago|Active just now/ }).tap();
      else await card.getByRole('button', { name: /Active .* ago|Active just now/ }).click();
      assert.equal(await card.getAttribute('open'), null, 'Activity button must not expand the user form');
      await page.evaluate(() => { window.activityPayload = [{ email:'user9@example.invalid',last_active_at:'2026-11-17T01:01:00Z' }]; });
      await page.clock.fastForward(60000);
      await page.waitForFunction(() => window.activityReads >= 3);
      await page.waitForFunction(() => document.querySelector('.user-card-collapsible').dataset.user === '9');
      await card.locator('summary').first().press('Enter');
      assert.equal(await card.getAttribute('open'), '', 'Keyboard activation must still expand the user card');
      if (width === 390) {
        await card.locator('[data-directory-activity] button').tap();
        assert.equal(await card.getAttribute('open'), '', 'Touching activity must not close the expanded user card');
      }
      await page.getByRole('combobox', { name: 'Sort users by' }).selectOption('name-asc');
      await page.getByRole('button', { name: 'No activity recorded', exact: true }).first().click();
      await search.fill('Person 018');
      await page.getByRole('status').filter({ hasText: '1 of 169 users' }).waitFor().catch(async error => {
        console.error('Filter state:', await page.evaluate(() => ({ query:document.querySelector('input[type="search"]').value,
          status:Array.from(document.querySelectorAll('[role="status"]')).map(node => node.textContent),
          pressed:Array.from(document.querySelectorAll('[aria-pressed="true"]')).map(node => node.textContent),
          visible:Array.from(document.querySelectorAll('.user-card-collapsible')).filter(node => !node.parentElement.hidden).map(node => node.dataset.user),
          open:Array.from(document.querySelectorAll('.user-card-collapsible[open]')).map(node => node.dataset.user),focused:document.activeElement?.outerHTML.slice(0,300) })));
        throw error;
      });
      for (let i = 0; i < 3; i++) {
        await search.fill('');
        await page.getByRole('button', { name: 'All', exact: true }).click();
        await page.getByRole('button', { name: 'No activity recorded', exact: true }).first().click();
        await search.fill('Person 018');
        await page.getByRole('status').filter({ hasText: '1 of 169 users' }).waitFor();
      }
      await page.reload();
      await page.waitForFunction(() => document.querySelector('input[type="search"]').value === 'Person 018');
      assert.equal(await page.getByRole('combobox', { name: 'Sort users by' }).inputValue(), 'name-asc');
      assert.equal(await page.getByRole('button', { name: 'No activity recorded', exact: true }).first().getAttribute('aria-pressed'), 'true');
      assert.equal(await page.evaluate(() => window.writes), 0, 'No account or calculator mutation requests');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'No horizontal overflow');
      assert.deepEqual(errors, []);
      await page.screenshot({ path: path.join(output, `${baseline ? 'before' : 'after'}-${engine.name()}-${width}.png`) });
      results.push(measurement);
      await page.goto(`http://127.0.0.1:${server.address().port}/hydrate`);
      const initialValues = await page.locator('form').evaluate(form => Array.from(new FormData(form).entries()));
      assert.deepEqual(initialValues, [['businessIds', 'a'], ['businessIds', 'b']], 'SSR closed picker must preserve catalogue order, not membership order');
      await page.locator('.business-multiselect > summary').click();
      await page.waitForTimeout(50);
      assert.equal(await page.locator('input[type="checkbox"]').count(), 0);
      await page.evaluate(() => window.beginHydration());
      await page.getByRole('checkbox', { name: 'Business A' }).waitFor();
      assert.deepEqual(await page.locator('form').evaluate(form => Array.from(new FormData(form).entries())), initialValues, 'Hydration and opening cannot change the primary business');
      await page.getByRole('checkbox', { name: 'Business A' }).uncheck();
      await page.getByRole('checkbox', { name: 'Business B' }).uncheck();
      assert.deepEqual(await page.locator('form').evaluate(form => Array.from(new FormData(form).entries())), [], 'Explicitly clearing all business assignments still works');
      assert.deepEqual(errors, []);
      await page.close();
    }
    fs.writeFileSync(path.join(output, `${baseline ? 'before' : 'after'}-${engine.name()}.json`), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
    console.log(baseline ? 'Original search baseline measured.' : 'Admin search, hydration, assignment values, unsaved drafts, filters, activity polling and read-only request checks passed.');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
