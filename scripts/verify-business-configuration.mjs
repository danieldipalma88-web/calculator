import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
export const rawSource = fs.readFileSync(path.join(root, "app/calculator/raw/route.ts"), "utf8");
const apiSource = fs.readFileSync(path.join(root, "app/api/calculator-data/route.ts"), "utf8");
const require = createRequire(import.meta.url);
const moduleCache = new Map();
export function loadTsModule(relative) {
  const filename = path.resolve(root, relative);
  if (moduleCache.has(filename)) return moduleCache.get(filename);
  const module = { exports: {} };
  moduleCache.set(filename, module.exports);
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 },
  }).outputText;
  const localRequire = name => name.startsWith(".") ? loadTsModule(path.resolve(path.dirname(filename), name)) : require(name);
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename })(localRequire, module, module.exports);
  return module.exports;
}
export const configurationModule = loadTsModule("lib/business-calculator-configuration.ts");
export const { BUSINESS_CONFIGURATION_STORAGE_KEY: key, validateBusinessCalculatorConfiguration: validate } = configurationModule;
export const businessA = "11111111-1111-4111-8111-111111111111";
export const businessB = "22222222-2222-4222-8222-222222222222";
const mainScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).join("\n");
const astCache = new Map();
export function declaration(name, source = mainScript) {
  if (!astCache.has(source)) astCache.set(source, ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true));
  const ast = astCache.get(source);
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement.getText(ast);
    if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(node => node.name.getText(ast) === name)) return statement.getText(ast);
  }
  throw new Error(`Missing declaration ${name}`);
}
const legacyRules = vm.runInNewContext(`${declaration("DEFAULT_COST_RULES")}\nJSON.parse(JSON.stringify(DEFAULT_COST_RULES))`);
export function fixtureConfiguration() {
  const rules = [];
  for (const install of ["new", "replacement"]) {
    for (const [name, range, labour] of [
      ["small", { max: 3.5 }, 101],
      ["medium", { min: 3.5, minExclusive: true, max: 8, maxExclusive: true }, 202],
      ["large", { min: 8 }, 303],
    ]) rules.push({ id: `custom_split_${install}_${name}`, system: "split", install, range, rangeLabel: `Test ${name} split`, labour, materials: labour + 10, power: 250 });
  }
  rules.push(...JSON.parse(JSON.stringify(legacyRules.filter(rule => rule.system === "ducted" && rule.install === "new"))));
  rules.push(JSON.parse(JSON.stringify(legacyRules.find(rule => rule.id === "ducted_replacement_lt10"))));
  for (const [name, range, labour] of [
    ["middle", { min: 10, max: 16 }, 404],
    ["gap", { min: 16, minExclusive: true, max: 18, maxExclusive: true }, 1500],
    ["large", { min: 18 }, 606],
  ]) rules.push({ id: `custom_ducted_replacement_${name}`, system: "ducted", install: "replacement", range, rangeLabel: `Test ${name} ducted`, labour, materials: 2000, power: 0 });
  const products = Array.from({ length: 17 }, (_, index) => ({
    type: index < 9 ? "split" : "ducted", brand: index % 2 ? "Fixture Brand B" : "Fixture Brand A", series: "Fixture Series",
    model: `PRIVATE-OUT-${index}/PRIVATE-IN-${index}`, capacityNum: index < 9 ? 7.1 : 17, phase: index % 2 ? "Three" : "Single",
    ...(index === 16 ? { defaultCostCapacityNum: 18, capacityLabel: "18.0kW nominal (17.0kW rated)" } : {}),
  }));
  return { schemaVersion: 1, businessId: businessA, revision: "fixture-r2", products, defaultCostRules: rules };
}
export function bootstrapHtml(data, businessId = businessA, financialsVisible = true, legacyBridge = false) {
  const context = {
    ...configurationModule,
    visibleCalculatorData: loadTsModule("lib/quote-data-visibility.ts").visibleCalculatorData,
    DCCEEW_CONTRACT_RATE: 30, DCCEEW_ELIGIBLE_POSTCODES: [], DCCEEW_ELIGIBLE_PRODUCT_KEYS: [],
  };
  const js = ts.transpileModule([
    declaration("safeScriptJson", rawSource), declaration("sanitizeCalculatorData", rawSource),
    declaration("injectCloudStorageSync", rawSource), "globalThis.inject = injectCloudStorageSync;",
  ].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2017 } }).outputText;
  vm.runInNewContext(js, context);
  let result = context.inject(html, data, {
    email: "fixture@example.test", viewingEmail: "fixture@example.test", role: "admin", businessId,
    businessName: "Fixture Business", businessOperatingState: "NSW", canSeeCommissionDetails: financialsVisible,
    canSeeProfitDetails: financialsVisible, canSeeOwnerDetails: true, canSeeSalespersonCommission: true,
  });
  if (legacyBridge) {
    // Reproduce the bridge before request provenance existed: storage-only snapshots.
    result = result.replace(/, businessConfigurationRevision: businessConfigurationRevision/g, "")
      .replace(/, businessConfigurationRevision:businessConfigurationRevision/g, "")
      .replace(/    if \(loadedBusinessConfiguration !== null\) output\[businessConfigurationKey\] = loadedBusinessConfiguration;\r?\n    else delete output\[businessConfigurationKey\];/, "")
      .replace(/    if \(loadedBusinessConfiguration !== null && typeof window.calculatorBusinessSnapshotData === 'function'\) \{[\s\S]*?\r?\n    \}/, "")
      .replace(/  Object.defineProperty\(window, '__calculatorLoadedBusinessConfiguration', \{value:loadedBusinessConfiguration\}\);/, "");
  }
  return result;
}

export function createSnapshotEndpoint(options = {}) {
  const clone = value => value === undefined ? undefined : structuredClone(value);
  const state = { business: clone(options.initialBusiness ?? null), user: null, reads: 0, updates: [], inserts: 0 };
  const supabase = {
    auth: { getUser: async () => ({ data: { user: { id: "fixture-user", email: "fixture@example.test" } } }) },
    from(table) {
      assert.ok(["business_calculator_data", "user_calculator_data"].includes(table));
      const business = table === "business_calculator_data", filters = [];
      let payload;
      const query = {
        eq(field, value) { filters.push([field, value]); return query; },
        is(field, value) { filters.push([field, value]); return query; },
        update(value) { payload = clone(value); return query; },
        select() {
          if (!payload) return query;
          return (async () => {
            if (business) {
              state.updates.push({ payload: clone(payload), filters: clone(filters) });
              await options.beforeBusinessUpdate?.(state);
            }
            const row = business ? state.business : state.user;
            const matches = row && filters.every(([field, value]) => row[field] === value);
            if (!matches) return { data: [], error: null };
            if (business) state.business = { ...row, ...payload };
            else state.user = { ...row, ...payload };
            return { data: [business ? { business_id: businessA } : { user_id: "fixture-user" }], error: null };
          })();
        },
        async maybeSingle() {
          const row = clone(business ? state.business : state.user);
          if (business) { state.reads++; await options.afterBusinessRead?.(state); }
          return { data: row, error: null };
        },
        async insert(value) {
          if (business) {
            state.inserts++;
            await options.beforeBusinessInsert?.(state);
            if (state.business) return { error: { code: "23505", message: "Duplicate business" } };
            state.business = clone(value);
          } else state.user = clone(value);
          return { error: null };
        },
      };
      return query;
    },
  };
  const context = {
    ...configurationModule, ...loadTsModule("lib/quote-sync.ts"), ...loadTsModule("lib/quote-family.ts"),
    ...loadTsModule("lib/quote-library-edit.ts"), ...loadTsModule("lib/won-job-validation.ts"),
    exports: {},
    createSupabaseServerClient: async () => supabase,
    currentApprovedUser: async () => ({ data: { role: "user", business_id: businessA }, error: null }),
    canManageUsers: () => false, isOwnerEmail: () => false,
    targetEmailFromRequest: () => "fixture@example.test", resolveBusinessId: async () => businessA,
    mutationFinancialsVisible: async () => ({ visible: true, canSeeSalespersonCommission: true, canUnlockWon: false }),
    NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200 }) },
    CERTIFICATE_VALUES_STORAGE_KEYS: ["installerCertificateValuesV1"],
    Date: options.clock === undefined ? Date : class extends Date {
      constructor(value) { super(value === undefined ? options.clock : value); }
      static now() { return options.clock; }
    },
  };
  const names = ["MANAGED_PRICE_STORAGE_KEYS", "WON_OPTION_ADMIN_STATE_STORAGE_KEYS", "BUSINESS_SHARED_STORAGE_KEYS",
    "storedValueHasData", "calculatorDataHasData", "splitCalculatorDataByScope", "stripCertificateValueKeys",
    "sanitizeIncomingCalculatorData", "stripManagedRebateOverrides", "parseManagedPriceMap", "serializeManagedPriceMap",
    "normalizeManagedLookup", "managedEntryHasTrustedRebate", "managedEntryModelKey", "managedRebateSource",
    "preserveManagedRebateFields", "preserveBusinessManagedRebates", "saveMergedBusinessData", "saveMergedUserData",
    "saveCalculatorData", "PUT", "POST"];
  vm.runInNewContext(ts.transpileModule([
    ...names.map(name => declaration(name, apiSource)), "globalThis.routes={PUT,POST};",
  ].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.CommonJS } }).outputText, context);
  return {
    state,
    request: (body, method = "PUT") => context.routes[method]({ json: async () => clone(body) }),
  };
}

async function verifySnapshotRaces(config) {
  const priceKey = "installerManagedPricesV1", costKey = "installerDefaultCostRulesV1";
  const prices = value => JSON.stringify({ "split|0": { model: "Fixture model", unitPriceInc: value, locked: true } });
  const previous = { business_id: businessA, data: { [priceKey]: prices(880), [costKey]: '[{"id":"old","labour":100}]' }, updated_at: "2030-01-01T00:00:00.123456+00:00" };
  const imported = { business_id: businessA, data: { [key]: JSON.stringify(config), [priceKey]: prices(968), [costKey]: '[{"id":"imported","labour":570}]' }, updated_at: "2030-01-01T00:00:00.124789+00:00" };
  const quoteData = { installerMasterQuoteLogV1: '[{"id":"race-quote","type":"Split","model":"Fixture model","unitInc":880,"syncUpdatedAt":1}]' };
  for (const configuredBefore of [false, true]) {
    let pause, release;
    const reached = new Promise(resolve => { pause = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const initial = structuredClone(previous);
    if (configuredBefore) initial.data[key] = JSON.stringify({ ...config, revision: "fixture-r1" });
    const endpoint = createSnapshotEndpoint({ initialBusiness: initial, afterBusinessRead: async state => { if (state.reads === 1) { pause(); await held; } } });
    const saving = endpoint.request({ data: { ...initial.data, ...quoteData }, businessConfigurationRevision: configuredBefore ? "fixture-r1" : null });
    await reached; endpoint.state.business = structuredClone(imported); release();
    const response = await saving;
    assert.equal(response.status, 200); assert.equal(endpoint.state.reads, 2);
    assert.equal(endpoint.state.updates.length, 1, "Rejected old revision must not issue a second update after reread");
    assert.deepEqual(endpoint.state.updates[0].filters, [["business_id", businessA], ["updated_at", initial.updated_at]], "CAS predicate keeps exact microsecond timestamp");
    assert.deepEqual(endpoint.state.business, imported, "Paused old read cannot roll back first import or a revision cutover");
    assert.equal(endpoint.state.user.data.installerMasterQuoteLogV1, quoteData.installerMasterQuoteLogV1, "Real user save still receives the quote");
  }
  const missing = createSnapshotEndpoint({ beforeBusinessInsert: state => { state.business = structuredClone(imported); } });
  assert.equal((await missing.request({ data: { ...previous.data, ...quoteData } }, "POST")).status, 200);
  assert.equal(missing.state.inserts, 1); assert.equal(missing.state.reads, 2);
  assert.deepEqual(missing.state.business, imported, "Missing-row insert conflict cannot overwrite concurrent import");
  assert.equal(missing.state.user.data.installerMasterQuoteLogV1, quoteData.installerMasterQuoteLogV1);
  for (const clock of [Date.parse(previous.updated_at), Date.parse(previous.updated_at) - 1000]) {
    const endpoint = createSnapshotEndpoint({ initialBusiness: previous, clock });
    for (const value of [901, 902]) assert.equal((await endpoint.request({ data: { [priceKey]: prices(value) } })).status, 200);
    assert.equal(endpoint.state.business.data[priceKey], prices(902), "Legacy business pricing remains editable");
    assert.ok(Date.parse(endpoint.state.updates[0].payload.updated_at) > Date.parse(previous.updated_at));
    assert.ok(Date.parse(endpoint.state.updates[1].payload.updated_at) > Date.parse(endpoint.state.updates[0].payload.updated_at));
    assert.equal(endpoint.state.updates[1].filters[1][1], endpoint.state.updates[0].payload.updated_at);
  }
  for (const method of ["PUT", "POST"]) {
    const endpoint = createSnapshotEndpoint({ initialBusiness: imported });
    assert.equal((await endpoint.request({ data: { ...previous.data, [key]: JSON.stringify(config), ...quoteData } }, method)).status, 200);
    assert.deepEqual(endpoint.state.business, imported, "A legacy bridge echoing NEW localStorage config has no request provenance");
    assert.equal(endpoint.state.updates.length, 0);
    assert.equal((await endpoint.request({ data: { [priceKey]: prices(990) }, businessConfigurationRevision: config.revision }, method)).status, 200);
    assert.equal(endpoint.state.business.data[priceKey], prices(990), "Current-provenance Price Manager edits still save");
  }
  const missingFresh = createSnapshotEndpoint();
  assert.equal((await missingFresh.request({ data: previous.data })).status, 200);
  assert.deepEqual(missingFresh.state.business.data, previous.data);
  const conflict = createSnapshotEndpoint({ initialBusiness: previous, beforeBusinessUpdate: state => { state.business.updated_at = new Date(Date.parse(state.business.updated_at) + 1).toISOString(); } });
  assert.equal((await conflict.request({ data: previous.data })).status, 409);
  assert.equal(conflict.state.reads, 5, "CAS contention is bounded and never silently succeeds");
  const nullVersion = createSnapshotEndpoint({ initialBusiness: { ...previous, updated_at: null } });
  assert.equal((await nullVersion.request({ data: previous.data })).status, 200);
  assert.deepEqual(nullVersion.state.updates[0].filters[1], ["updated_at", null]);
  let releaseConcurrent;
  const concurrentGate = new Promise(resolve => { releaseConcurrent = resolve; });
  const concurrent = createSnapshotEndpoint({ initialBusiness: imported, clock: Date.parse(imported.updated_at), afterBusinessRead: async state => {
    if (state.reads <= 2) { if (state.reads === 2) releaseConcurrent(); await concurrentGate; }
  } });
  const concurrentResults = await Promise.all([
    concurrent.request({ data: { [priceKey]: prices(901) }, businessConfigurationRevision: config.revision }),
    concurrent.request({ data: { [costKey]: '[{"id":"concurrent","labour":777}]' }, businessConfigurationRevision: config.revision }),
  ]);
  assert.ok(concurrentResults.every(response => response.status === 200));
  assert.equal(concurrent.state.reads, 3); assert.equal(concurrent.state.updates.length, 3);
  assert.equal(concurrent.state.business.data[priceKey], prices(901));
  assert.equal(concurrent.state.business.data[costKey], '[{"id":"concurrent","labour":777}]', "CAS retry merges current-revision concurrent fields without losing either write");
  assert.equal(concurrent.state.business.data[key], JSON.stringify(config));
  for (const businessConfigurationRevision of [undefined, config.revision]) {
    const quoteOnly = createSnapshotEndpoint({ initialBusiness: imported });
    assert.equal((await quoteOnly.request({ quoteCopy: {}, businessConfigurationRevision })).status, 409, "Quote-only requests reach the existing missing-quote validation, with or without provenance");
    assert.equal(quoteOnly.state.reads, 0);
  }
  console.log("Snapshot races: paused read/import, revision cutover, insert-23505 retry, exact microsecond CAS, equal/backward clock, bounded contention, legacy bridges, PUT/POST and quote durability passed.");
}
function calculatorHarness(config) {
  const storage = new Map(config ? [[key, JSON.stringify(config)]] : []);
  const context = {
    window: { CALCULATOR_USER: { businessId: businessA, businessName: "Fixture", businessOperatingState: "NSW" }, validateBusinessCalculatorConfiguration: validate },
    localStorage: { getItem: name => storage.get(name) ?? null, setItem: (name, value) => storage.set(name, value), removeItem: name => storage.delete(name) },
  };
  const names = ["activeProducts", "calculatorUserContext", "activeBusinessState", "businessCatalogSlug", "activeBusinessName", "activeCatalogKey", "businessConfigurationCache", "activeBusinessConfiguration", "mergeBusinessProducts", "baseProductListFor", "productListFor", "DEFAULT_COST_RULES", "cloneDefaultCostRules", "activeDefaultCostRules", "normalizeDefaultCostRule", "loadDefaultCostRules", "persistDefaultCostRules", "legacyStorageKey", "storageGet", "capacityInDefaultRange", "defaultCostRuleFor", "defaultCostCapacity", "cap"];
  vm.runInNewContext([
    mainScript.slice(mainScript.indexOf("const SPLIT_PRODUCTS ="), mainScript.indexOf("let systemType='split'")),
    `const BUSINESS_CONFIGURATION_STORAGE_KEY=${JSON.stringify(key)}; const DEFAULT_COST_STORAGE_KEY='installerDefaultCostRulesV1'; let defaultCostRules=[];`,
    ...names.map(name => declaration(name)),
    "globalThis.api={productListFor,loadDefaultCostRules,defaultCostRuleFor,cloneDefaultCostRules,activeBusinessConfiguration,defaultCostCapacity,cap,shared:()=>JSON.stringify([SPLIT_PRODUCTS,DUCTED_PRODUCTS,ANDOS_SPLIT_PRODUCTS,ANDOS_DUCTED_PRODUCTS])};",
  ].join("\n"), context);
  return { ...context.api, context, storage };
}
export async function verify() {
  const config = fixtureConfiguration(), json = JSON.stringify(config);
  assert.equal(config.defaultCostRules.length, 14);
  assert.ok(validate(json, businessA));
  assert.equal(validate(json, businessB), null);
  assert.equal(validate(json, null), null);
  assert.equal(validate("{bad", businessA), null);
  assert.equal(validate(config, businessA), null, "Storage format must be a JSON string");
  for (const mutate of [
    c => delete c.revision, c => c.products[0].model = "<img src=x>", c => c.products[0].capacityNum = 0,
    c => c.products[0].capacityNum = "7", c => c.products[0].capacityNum = 66, c => c.products[0].phase = "Unknown",
    c => c.products[0].rebate = 123, c => c.products[0].unitPriceInc = 123,
    c => c.products[0].defaultCostCapacityNum = 0, c => c.defaultCostRules.pop(),
    c => c.defaultCostRules[1].range.min = 3.4, c => c.defaultCostRules[1].range.min = 3.6,
    c => c.defaultCostRules[0].range.maxExclusive = true, c => c.defaultCostRules[0].labour = -1,
    c => c.defaultCostRules[1].id = c.defaultCostRules[0].id,
  ]) {
    const malformed = structuredClone(config); mutate(malformed);
    assert.equal(validate(JSON.stringify(malformed), businessA), null, mutate.toString());
  }
  assert.ok(validate(JSON.stringify({ ...config, products: [], defaultCostRules: legacyRules }), businessA), "All legacy ranges remain valid");
  const harness = calculatorHarness(config), sharedBefore = harness.shared();
  const split = harness.productListFor("split"), ducted = harness.productListFor("ducted");
  assert.equal([...split, ...ducted].filter(p => p.model.startsWith("PRIVATE-")).length, 17);
  const privateProduct = ducted.find(p => p.defaultCostCapacityNum);
  assert.equal(privateProduct.unitPriceInc, 0); assert.equal(privateProduct.rebate, 0);
  privateProduct.unitPriceInc = 987;
  assert.equal(harness.productListFor("ducted").find(p => p.model === privateProduct.model), privateProduct, "Private object references remain stable");
  assert.equal(harness.shared(), sharedBefore, "Merging must not mutate static catalogues");
  assert.equal(harness.cap(privateProduct), 17); assert.equal(harness.defaultCostCapacity(privateProduct), 18);
  harness.loadDefaultCostRules();
  for (const install of ["new", "replacement"]) for (const [capacity, expected] of [[7, 202], [7.1, 202], [8, 303]]) {
    assert.equal(harness.defaultCostRuleFor("split", install, capacity).labour, expected);
    assert.equal(harness.defaultCostRuleFor("split", install, capacity).power, 250, "No legacy migration on configured costs");
  }
  for (const [capacity, expected] of [[16, 404], [17, 1500], [18, 606]]) assert.equal(harness.defaultCostRuleFor("ducted", "replacement", capacity).labour, expected);
  const legacy = calculatorHarness(); legacy.loadDefaultCostRules();
  for (const capacity of [7, 10, 12, 16, 17, 18]) assert.deepEqual(JSON.parse(JSON.stringify(harness.defaultCostRuleFor("ducted", "new", capacity))), JSON.parse(JSON.stringify(legacy.defaultCostRuleFor("ducted", "new", capacity))));
  harness.storage.set("installerDefaultCostRulesV1", JSON.stringify([{ id: config.defaultCostRules[0].id, labour: 765 }]));
  harness.loadDefaultCostRules(); harness.loadDefaultCostRules();
  assert.equal(harness.defaultCostRuleFor("split", "new", 3.5).labour, 765);
  assert.equal(harness.defaultCostRuleFor("split", "new", 8).labour, 303);
  assert.equal(JSON.parse(harness.storage.get("installerDefaultCostRulesV1")).length, 14, "Custom IDs survive numeric persistence");
  harness.context.window.CALCULATOR_USER.businessId = businessB;
  harness.loadDefaultCostRules();
  assert.equal(harness.activeBusinessConfiguration(), null);
  assert.equal(harness.productListFor("split").filter(p => p.model.startsWith("PRIVATE-")).length, 0);
  assert.equal(harness.defaultCostRuleFor("split", "new", 7.1).labour, legacy.defaultCostRuleFor("split", "new", 7.1).labour);
  const duplicates = structuredClone(config);
  duplicates.products.push(duplicates.products[0], { ...split[0], type: "split", phase: split[0].phase || "Single" });
  duplicates.products[18] = Object.fromEntries(Object.entries(duplicates.products[18]).filter(([name]) => ["type", "brand", "series", "model", "capacityNum", "phase"].includes(name)));
  const duplicateHarness = calculatorHarness(duplicates);
  assert.equal(duplicateHarness.productListFor("split").length, split.length, "Private duplicates and shared duplicates are not appended");
  const filtered = structuredClone(config); filtered.products[0].nswOnly = true;
  const filteredHarness = calculatorHarness(filtered);
  filteredHarness.context.window.CALCULATOR_USER.businessOperatingState = "QLD";
  for (const businessName of ["Fixture", "Andos Air"]) {
    filteredHarness.context.window.CALCULATOR_USER.businessName = businessName;
    assert.equal(filteredHarness.productListFor("split").filter(p => p.model.startsWith("PRIVATE-")).some(p => p.nswOnly === true), false, businessName);
    assert.equal(filteredHarness.productListFor("split").filter(p => p.model.startsWith("PRIVATE-")).length, 8);
  }
  assert.match(declaration("baseProductListFor"), /if\(activeCatalogKey\(\)==='andos'\) return type==='ducted'\?ANDOS_DUCTED_PRODUCTS:ANDOS_SPLIT_PRODUCTS;/);
  const { revisionGuardedBusinessSnapshot: guard, withoutBusinessConfiguration, validatedBusinessConfigurationData } = configurationModule;
  const fields = ["installerManagedPricesV1", "greenEnergyManagedPricesV1", "ManagedPricesV1", "installerDefaultCostRulesV1", "greenEnergyDefaultCostRulesV1", "DefaultCostRulesV1"];
  const incoming = Object.fromEntries(fields.map(field => [field, '[{"old":true}]'])); incoming[key] = json;
  const existing = { [key]: json, installerManagedPricesV1: '{"split|0":{"unitPriceInc":999}}' };
  for (const supplied of [undefined, null, {}, "fixture-r1", json]) assert.deepEqual(guard(existing, incoming, supplied, businessA), {});
  assert.deepEqual(guard(existing, incoming, config.revision, businessA), withoutBusinessConfiguration(incoming));
  assert.deepEqual(guard({}, incoming, undefined, businessB), withoutBusinessConfiguration(incoming), "Unconfigured businesses retain existing writes, but cannot create configuration");
  assert.equal(validatedBusinessConfigurationData(existing, businessB)[key], undefined);
  assert.equal(validatedBusinessConfigurationData(existing, businessA)[key], json);
  const { mergeCalculatorData } = loadTsModule("lib/quote-sync.ts");
  const quotes = { installerMasterQuoteLogV1: '[{"id":"quote-1","model":"Saved model","unitInc":321,"updatedAt":1}]' };
  const scopeContext = { ...configurationModule, MANAGED_PRICE_STORAGE_KEYS: fields.slice(0, 3), BUSINESS_SHARED_STORAGE_KEYS: new Set([key, ...fields]) };
  vm.runInNewContext(ts.transpileModule([
    declaration("stripManagedRebateOverrides", apiSource), declaration("sanitizeIncomingCalculatorData", apiSource),
    declaration("splitCalculatorDataByScope", apiSource),
    "globalThis.scope=(data)=>splitCalculatorDataByScope(sanitizeIncomingCalculatorData(data,false));",
  ].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2017 } }).outputText, scopeContext);
  const scoped = scopeContext.scope({ ...incoming, ...quotes });
  assert.deepEqual({ ...scoped.userData }, quotes);
  assert.equal(scoped.businessData[key], undefined);
  const protectedBusiness = mergeCalculatorData(existing, guard(existing, scoped.businessData, undefined, businessA));
  assert.equal(protectedBusiness[key], json); assert.equal(protectedBusiness.installerManagedPricesV1, existing.installerManagedPricesV1);
  assert.equal(mergeCalculatorData({}, scoped.userData).installerMasterQuoteLogV1, quotes.installerMasterQuoteLogV1, "Quote payload survives the revision guard unchanged");
  const visibleCalculatorData = loadTsModule("lib/quote-data-visibility.ts").visibleCalculatorData;
  assert.equal(visibleCalculatorData({ [key]: json }, false, true)[key], json, "Visibility projection retains configuration");
  for (const source of [rawSource, apiSource]) assert.match(declaration("BUSINESS_SHARED_STORAGE_KEYS", source), /installerBusinessConfigurationV1/);
  assert.match(apiSource, /saveMergedBusinessData\(\s*supabase, businessId, businessData, body\?\.businessConfigurationRevision/);
  assert.doesNotMatch(declaration("saveCalculatorData", apiSource), /rawCalculatorData\[BUSINESS_CONFIGURATION_STORAGE_KEY\]/);
  assert.doesNotMatch(declaration("saveMergedBusinessData", apiSource), /\.upsert\(|\.eq\("data"/);
  assert.match(rawSource, /withoutBusinessConfiguration\(stripCertificateValueKeys\(unlockedUserData\)\)/);
  assert.match(apiSource, /withoutBusinessConfiguration\(stripCertificateValueKeys\(applyStoredQuoteAdminUnlocks\(userData\)\)\)/);
  const publicSource = fs.readFileSync(path.join(root, "lib/public-rebate-catalogue.ts"), "utf8");
  assert.doesNotMatch(publicSource, /installerBusinessConfigurationV1|activeBusinessConfiguration|mergeBusinessProducts/);
  for (const script of [...bootstrapHtml({ [key]: json }).matchAll(/<script>([\s\S]*?)<\/script>/g)]) assert.doesNotThrow(() => new Function(script[1]));
  await verifySnapshotRaces(config);
  console.log("Business configuration: validation, 17 private products, isolation, dedupe, NSW/Andos filtering, boundaries, nominal cost capacity, persistence, legacy defaults, revision guard, quote storage, visibility and bootstrap checks passed.");
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await verify();
