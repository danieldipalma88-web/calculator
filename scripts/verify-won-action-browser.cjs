const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || "playwright");
const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const source = read("app/admin/users/page.tsx");
const ast = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const fromPage = name => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast);
const runtime = new Function(fromPage("wonExportScript") + "; return wonExportScript()")();
const compile = code => ts.transpileModule(code, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX
} }).outputText;
const modules = {};
for (const [key, pkg, file] of [
  ["react","react","react.production.js"], ["react/jsx-runtime","react","react-jsx-runtime.production.js"],
  ["react-dom","react-dom","react-dom.production.js"], ["react-dom/client","react-dom","react-dom-client.production.js"],
  ["scheduler","scheduler","scheduler.production.js"]
]) {
  const dir = path.dirname(require.resolve(pkg + "/package.json", { paths: [path.dirname(require.resolve("react-dom"))] }));
  modules[key] = fs.readFileSync(path.join(dir, "cjs", file), "utf8");
}
modules["next/navigation"] = "const router = {}; exports.useRouter = () => router; exports.useSearchParams = () => new URLSearchParams(location.search); exports.unstable_rethrow = () => {};";
modules.workspace = compile(read("app/admin/users/admin-workspace.tsx"));
modules.controls = compile('const randomUUID=()=> "fixture-token", WON_BATCH_MAX_JOBS=50, bulkUpdateWonOptions=()=>{ throw Error("Native submit also ran") };\n' +
  fromPage("WonBatchFormFields") + "\n" + fromPage("WonBulkActionControls") + "\nexport { WonBulkActionControls };");
const fixture = `
const cache={};
function require(name) {
  if(!cache[name]) { const m=cache[name]={exports:{}}; new Function('module','exports','require',modules[name])(m,m.exports,require) }
  return cache[name].exports;
}
const h=require('react').createElement, app=require('react-dom/client').createRoot(document.querySelector('#app'));
const {default:Workspace,AdminPanel}=require('workspace'), {WonBulkActionControls}=require('controls');
window.calls=[];
const bulk=async data=>{ calls.push(Object.fromEntries(data)); await new Promise((ok,fail)=>{window.resolveSave=ok;window.rejectSave=fail}) };
const render=window.renderFixture=(result)=>app.render(h(Workspace,{storageScope:'fixture',initialView:'jobs',wonActions:{bulk},wonResult:result},
 h(AdminPanel,{id:'won-options',view:'jobs',className:'won-options-section'},
 h('dialog',{className:'won-loading-overlay won-loading-panel','data-won-loading-overlay':''},
   h('strong',{'data-won-loading-label':''}),h('span',{'data-won-loading-slow':'',hidden:true},'Still waiting')),
 h('div',{className:'won-grid'},[1,2].map(n=>h('article',{key:n,className:'won-card','data-won-batch-job':'job'+n,
 'data-won-batch-review':'review'+n,'data-payment-not-requested':'true'},h('input',{type:'checkbox',className:'won-sale-select'})))),
 h('div',{style:{height:2400}}),h('div',{'data-won-mobile-selection-dock':''},h(WonBulkActionControls))
 )));
render();
`;
(async()=>{
  const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
    (fs.existsSync("C:/Program Files/Google/Chrome/Application/chrome.exe") ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined);
  const browser=await chromium.launch({headless:true, executablePath});
  try {
    for (const width of [390,1440]) {
      const page=await browser.newPage({viewport:{width,height:800}});
      const errors=[]; page.on("pageerror", error=>errors.push(error.message));
      await page.route("**/*", route=>route.fulfill({contentType:"text/html", body:'<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="app"></div>'}));
      await page.goto("http://fixture.test/admin/users?view=jobs#won-options");
      await page.addStyleTag({content:read("app/globals.css")});
      await page.addScriptTag({content:"const modules="+JSON.stringify(modules)+";"+fixture});
      const boxes=page.locator(".won-sale-select"), button=page.getByRole("button",{name:"Record payment request",exact:true});
      await boxes.first().waitFor();
      await page.addScriptTag({content:runtime});
      await boxes.nth(0).check(); await boxes.nth(1).check();
      await page.getByText("More actions",{exact:true}).click();
      assert.equal(await button.evaluate(b=>b.form.method),"get","React client-mounted server-action form defaults to GET");
      page.once("dialog", d=>d.dismiss()); await button.click(); assert.equal(await page.evaluate(()=>calls.length),0);
      page.once("dialog", d=>d.accept()); await button.click(); await page.waitForSelector("dialog:modal");
      const rect=await page.locator("dialog:modal").boundingBox();
      assert.ok(rect.y>=0 && rect.y+rect.height<=800,"Loader is visible when scrolled far down");
      await page.evaluate(()=>{document.querySelector(".won-grid").append("unrelated"); window.__adminWonOptionsRuntime.refresh();
        const btn=document.querySelector('[value=payment_requested]'); btn.form.requestSubmit(btn);});
      await page.keyboard.press("Escape"); assert.ok(await page.locator("dialog:modal").isVisible());
      const calls=await page.evaluate(()=>window.calls); assert.equal(calls.length,1); assert.equal(calls[0].bulkMode,"payment_requested");
      assert.deepEqual(JSON.parse(calls[0].wonBatchIds),["job1","job2"]); assert.deepEqual(JSON.parse(calls[0].wonBatchReviews),["review1","review2"]);
      await page.evaluate(()=>window.rejectSave(Error("Connection interrupted")));
      await page.getByRole("alert").filter({hasText:"could not be confirmed"}).waitFor();
      assert.equal(await page.locator("dialog:modal").count(),0); assert.equal(await boxes.evaluateAll(bs=>bs.filter(b=>b.checked).length),2);
      await page.getByRole("button",{name:"Dismiss result"}).click();
      if (!await button.isVisible()) await page.getByText("More actions",{exact:true}).click();
      page.once("dialog", d=>d.accept()); await button.click(); await page.waitForSelector("dialog:modal");
      await page.evaluate(()=>{window.renderFixture("2 updated, 0 already recorded, 0 failed.");window.resolveSave()});
      await page.getByRole("status").filter({hasText:"2 updated"}).waitFor();
      assert.equal(await page.locator("dialog:modal").count(),0); assert.deepEqual(errors,[]);
      await page.close();
    }
    console.log("Won Jobs: desktop and mobile bulk request, cancellation, exact payload, loading, double-submit, failure and confirmed result passed.");
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
