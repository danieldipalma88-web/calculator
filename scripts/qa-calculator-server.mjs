import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@supabase/supabase-js";
import ts from "typescript";
import nsw from "../services/nsw-rebate-backup/api/calculate.mjs";
import { referenceRequest } from "./nsw-backup-probe.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const businessId = "11111111-1111-4111-8111-111111111111";
const dataKey = "installerMasterQuoteLogV1";
const optionKey = "installerQuoteOptionDefsV1";
const backupKey = "installerSavedQuoteSetsV1";
const databaseUrl = "http://qa-database.invalid";
const clone = structuredClone;
const actors = {
  admin: { id: "qa-admin", email: "admin@example.test", role: "admin" },
  sales: { id: "qa-sales", email: "sales@example.test", role: "user" },
};
const controlledRates = { esc: 23, prc: 2.6 };
const rating = (field) => referenceRequest.buildings.building_1["HVAC1_PDRSAug24_" + field]["2021-01-01"];
const split = {
  Brand: "FUJITSU GENERAL", Model_No: "AOTG09KMTC/ASTG09KMTC", "Registration Number": "AAC8714",
  SubmitStatus: "Approved", "Availability Status": "Available", Sold_in: "Australia",
  Configuration1: "Non Ducted", Configuration2: "Single Split System", "Product Class": "Class 8",
  "C-Total Cool Rated": rating("cooling_capacity_input"), "H-Total Heat Rated": rating("heating_capacity_input"),
  "C-Power_Inp_Rated": rating("input_power"), "Rated AEER": rating("rated_AEER_input"), "Rated ACOP": rating("rated_ACOP_input"),
  "Residential TCSPF_mixed": rating("TCSPF_mixed"), "Residential HSPF_mixed": rating("HSPF_mixed"), "Residential HSPF_cold": rating("HSPF_cold"),
  "Residential tcec_hot": 452, "Residential tcec_mixed": 155, "Residential tcec_cold": 97,
  "Residential thec_hot": 51, "Residential thec_mixed": 351, "Residential thec_cold": 920,
};
const { models } = JSON.parse(readFileSync(resolve(root, "scripts/fixtures/gems-gap-regressions-20261106.json"), "utf8"));
const ducted = models.find(({ model }) => model === "AOTH24KBTA/ARTH24KHTA").record;
// Synthetic energy ratings exercise the multi-head flow, not real-world eligibility.
const multi = {
  ...split, Brand: "Rinnai", Model_No: "MON2H05B1LA", "Registration Number": "QA-MULTI",
  Configuration2: "Fixed", ApplStandard: "SEER Multi Split", "Product Class": "Class 19",
  "C-Total Cool Rated": 5.4, "H-Total Heat Rated": 6.5, "C-Power_Inp_Rated": 1.12,
};

export const qaModels = { split: split.Model_No, ducted: ducted.Model_No, multi: multi.Model_No };
export const qaRates = controlledRates;

export async function startCalculatorQa({ port = 0, largeHistory = false } = {}) {
  const requestContext = new AsyncLocalStorage();
  const modules = new Map();
  const env = Object.create(process, { env: { value: Object.freeze({}) }, cwd: { value: () => root } });
  const tables = {
    approved_users: Object.values(actors).map(({ email, role }) => ({ email, role, business_id: businessId, is_locked: false, salesperson_gst_registered: false })),
    approved_user_businesses: [],
    businesses: [{ id: businessId, name: "Fictional QA Air", operating_state: "NSW", commission_type: "salesperson", agency_commission_rate: 25, salesperson_commission_rate: 12.5 }],
    // Fixture spot prices minus the default $5 ESC / $0.30 PERC deductions.
    platform_certificate_values: [{ id: "global", esc_spot_price: 28, prc_spot_price: 2.9, source: "QA fixture", locked: true }],
    business_calculator_data: [],
    user_calculator_data: largeHistory ? [{ user_id: actors.admin.id, email: actors.admin.email, updated_at: "2026-01-01T00:00:00.000Z",
      data: { [backupKey]: JSON.stringify([{ id: "qa-backup", name: "Synthetic history",
        quotes: [{ id: "qa-history", notes: '"'.repeat(1400000) }] }]) } }] : [],
  };
  const events = [];
  const faults = { delaySaveMs: 0, saveUnavailable: false, dropNextArrangeAck: false, primaryDown: true, backupDown: false, delayRebateMs: 0, zeroCertificates: false, signedOut: false };
  const databaseFetch = async (input, init) => {
    const url = new URL(input);
    assert.equal(url.origin, databaseUrl, "QA must never contact a live database");
    init.signal?.throwIfAborted();
    const table = url.pathname.split("/").at(-1);
    assert.ok(Object.hasOwn(tables, table), `Unexpected QA data table: ${table}`);
    const rows = tables[table];
    const filters = [...url.searchParams].filter(([key]) => key !== "select");
    const matches = (row) => filters.every(([field, predicate]) => {
      if (predicate === "is.null") return row[field] == null;
      assert.ok(predicate.startsWith("eq."), `Unsupported QA filter: ${predicate}`);
      return String(row[field]) === predicate.slice(3);
    });
    const selection = url.searchParams.get("select");
    const project = (row) => selection && selection !== "*" ? Object.fromEntries(selection.split(",").map((column) => {
      const json = column.match(/^([^:]+):data->(.+)$/);
      return json ? [json[1], row.data?.[json[2]] ?? null] : [column, row[column]];
    })) : row;
    const method = init.method || "GET";
    if (method === "GET") return Response.json(rows.filter(matches).map(project));
    assert.ok(["user_calculator_data", "business_calculator_data"].includes(table), "QA only permits calculator snapshot writes");
    const payload = JSON.parse(init.body);
    if (method === "POST") {
      const key = table === "user_calculator_data" ? "user_id" : "business_id";
      if (rows.some((row) => row[key] === payload[key])) return Response.json({ code: "23505", message: "Duplicate fixture row" }, { status: 409 });
      rows.push(payload);
      requestContext.getStore().writes++;
      events.push({ type: "write", table, method });
      return new Response(null, { status: 201 });
    }
    assert.equal(method, "PATCH");
    const updated = rows.filter(matches);
    updated.forEach((row) => Object.assign(row, payload));
    requestContext.getStore().writes += updated.length;
    if (updated.length) events.push({ type: "write", table, method });
    return Response.json(updated.map(project));
  };
  function load(filename) {
    filename = resolve(root, extname(filename) ? filename : filename + ".ts");
    if (filename.endsWith(".json")) return require(filename);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const source = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const localRequire = (name) => {
      if (name === "next/headers") return { cookies: async () => ({ getAll: () => [], set() {} }) };
      if (name === "@supabase/ssr") return { createServerClient(url, key, options) {
        assert.equal(url, databaseUrl);
        const transport = options.global?.fetch || databaseFetch;
        const client = createClient(url, key, {
          global: { fetch: transport }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, db: { retry: false },
        });
        client.auth.getUser = async () => ({ data: { user: faults.signedOut ? null : requestContext.getStore().actor }, error: null });
        return client;
      } };
      if (name === "node:fs/promises" && filename === resolve(root, "app/calculator/raw/route.ts")) {
        return { readFile: async (path, encoding) => {
          assert.equal(resolve(path), resolve(root, "index.html"));
          return (await readFile(path, encoding))
            .replace("https://of-sfg-rac-prd.energy.nsw.gov.au/calculate", "/qa/nsw-primary")
            .replace("https://rebate-portal-nsw-backup.vercel.app/api/calculate", "/qa/nsw-backup")
            .replace("https://data.gov.au/data/api/3/action/datastore_search", "/qa/gems")
            .replace(/<link[^>]*https:\/\/fonts\.[^>]*>/g, "")
            .replace("<body>", '<body><div style="text-align:center;padding:6px;background:#fff3be;color:#301c00">LOCAL QA | Fictional data only</div>');
        } };
      }
      if (!name.startsWith(".")) return require(name);
      const dependency = resolve(dirname(filename), name);
      if (dependency === resolve(root, "lib/supabase/config")) return { supabaseUrl: databaseUrl, supabasePublishableKey: "qa-only" };
      if (dependency === resolve(root, "lib/model-catalogue")) return { readAddedModels: async () => [], calculatorAddedProducts: () => [] };
      return load(dependency);
    };
    new Function("require", "module", "exports", "process", "fetch", source)(localRequire, module, module.exports, env, databaseFetch);
    return module.exports;
  }
  const raw = load("app/calculator/raw/route");
  const save = load("app/api/calculator-data/route");
  const { readCalculatorSavePayload } = load("lib/calculator-save-payload");
  const { createGemsCalculationMetadata } = load("lib/gems-calculation-metadata");
  const lookup = createGemsCalculationMetadata({ fetchInventory: async (brands) => [split, ducted, multi].filter((item) =>
    brands.some((brand) => String(brand).toUpperCase() === item.Brand.toUpperCase())) });
  let origin;
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (incoming.headers.host !== new URL(origin).host || (incoming.headers.origin && incoming.headers.origin !== origin)) {
        outgoing.writeHead(403).end(); return;
      }
      const url = new URL(incoming.url, origin);
      const method = incoming.method;
      const write = method !== "GET" && method !== "HEAD";
      const actor = /(?:^|;\s*)qa-role=sales(?:;|$)/.test(incoming.headers.cookie || "") ? actors.sales : actors.admin;
      const context = { actor, writes: 0 };
      const controller = new AbortController();
      outgoing.on("close", () => { if (!outgoing.writableFinished) controller.abort(); });
      const chunks = [];
      let wireSize = 0;
      if (write) {
        for await (const chunk of incoming) {
          wireSize += chunk.length;
          if (wireSize > 4_400_000) { outgoing.writeHead(413).end(); return; }
          chunks.push(chunk);
        }
      }
      const wire = write ? Buffer.concat(chunks) : undefined;
      const request = new Request(url, {
        method, headers: incoming.headers, signal: controller.signal,
        ...(write ? { body: wire } : {}),
      });
      const response = await requestContext.run(context, async () => {
        if (!write && ["/", "/calculator/raw"].includes(url.pathname)) return raw.GET(request);
        if (url.pathname === "/api/calculator-data" && ["GET", "PUT", "POST"].includes(method)) {
          if (!write) return save.GET(request);
          const body = await readCalculatorSavePayload(new Request(url, {
            method, headers: request.headers, signal: controller.signal, body: wire,
          }));
          const operation = body.quoteArrange?.action || (body.quoteArrange ? "arrange" : "snapshot");
          if (faults.delaySaveMs) await delay(faults.delaySaveMs, undefined, { signal: controller.signal });
          const result = faults.saveUnavailable
            ? Response.json({ error: "Synthetic save outage", code: "CALCULATOR_SAVE_UNAVAILABLE" }, { status: 503 })
            : await save[method](request);
          const drop = faults.dropNextArrangeAck && body.quoteArrange && result.ok;
          if (drop) {
            assert.ok(context.writes > 0, "The lost acknowledgement must follow a real fixture write");
            faults.dropNextArrangeAck = false;
          }
          events.push({ type: "save", operation, status: drop ? 503 : result.status, committed: Boolean(drop),
            writes: context.writes, saveId: body.quoteArrange?.saveId, encoding: request.headers.get("content-type") });
          return drop ? Response.json({ error: "Synthetic lost save acknowledgement" }, { status: 503 }) : result;
        }
        if (url.pathname === "/api/gems-model-metadata" && !write) {
          try { return Response.json(await lookup(url.searchParams.get("brand"), url.searchParams.get("model"))); }
          catch (error) { return Response.json({ error: error.message, code: error.code }, { status: error.status || 503 }); }
        }
        if (url.pathname === "/api/gems-model-search" && !write) {
          if (url.searchParams.get("mode") === "multi-brands") return Response.json({ brands: ["Rinnai"] });
          if (url.searchParams.get("mode") === "multi-outdoors" && url.searchParams.get("brand") === "Rinnai") {
            return Response.json({ models: [{ model: multi.Model_No, brand: multi.Brand, capacityKw: 5.4, productType: "Multi Split" }] });
          }
          return Response.json({ brands: [], models: [] });
        }
        if (url.pathname === "/qa/gems" && !write) return Response.json({ success: true, result: { records: [split, ducted, multi] } });
        if (method === "POST" && ["/qa/nsw-primary", "/qa/nsw-backup"].includes(url.pathname)) {
          const primary = url.pathname.endsWith("primary");
          const unavailable = primary ? faults.primaryDown : faults.backupDown;
          events.push({ type: "rebate", service: primary ? "primary" : "backup", unavailable });
          if (unavailable) return Response.json({ error: "Synthetic rebate service outage" }, { status: 503 });
          if (faults.delayRebateMs) await delay(faults.delayRebateMs, undefined, { signal: controller.signal });
          const headers = new Headers(request.headers);
          headers.delete("origin");
          const result = await nsw.fetch(new Request(request, { headers }));
          if (!faults.zeroCertificates || !result.ok) return result;
          const body = await result.json();
          // A verified zero response tests readiness, not physical-model eligibility.
          for (const [field, periods] of Object.entries(body.buildings.building_1)) {
            if (/_(electricity_savings|peak_demand_reduction_capacity|ESC_calculation|PRC_calculation)$/.test(field)) {
              for (const period of Object.keys(periods)) periods[period] = 0;
            }
          }
          return Response.json(body, { status: result.status, headers: result.headers });
        }
        if (!write && url.pathname === "/vendor/sortable-1.15.6.min.js") {
          return new Response(await readFile(resolve(root, "public/vendor/sortable-1.15.6.min.js")), { headers: { "Content-Type": "text/javascript" } });
        }
        if (url.pathname === "/api/user-activity" || url.pathname === "/api/calculator-guidance") {
          return Response.json({ ok: true });
        }
        return Response.json({ error: "Not available in local QA" }, { status: 404 });
      });
      if (controller.signal.aborted) return;
      const headers = Object.fromEntries(response.headers);
      headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'";
      outgoing.writeHead(response.status, headers);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      if (outgoing.destroyed) return;
      console.error("QA server:", error.message);
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end("Local QA server error");
    }
  });
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", done);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, faults, events,
    snapshot(role = "admin") {
      const data = tables.user_calculator_data.find(({ user_id }) => user_id === actors[role].id)?.data || {};
      return { rows: JSON.parse(data[dataKey] || "[]"), options: JSON.parse(data[optionKey] || "[]"), raw: clone(data) };
    },
    close() {
      return new Promise((done, reject) => {
        server.close((error) => error ? reject(error) : done());
        server.closeAllConnections();
      });
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const qa = await startCalculatorQa({ port: Number(process.env.QA_PORT || "0") });
  console.log("Local QA calculator (fictional data): " + qa.origin);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void qa.close());
}
