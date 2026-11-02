import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInThisContext } from "node:vm";
import ts from "typescript";
import { buildModelRequestEmail, sendModelRequestConfirmation } from "../lib/model-request-email.ts";

// Load the Next.js modules with their extensionless imports and JSON intact.
const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name);
  const source = readFileSync(new URL(`../lib/${name}${name.endsWith(".json") ? "" : ".ts"}`, import.meta.url), "utf8");
  const exports = name.endsWith(".json") ? JSON.parse(source) : {};
  if (!name.endsWith(".json")) {
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    });
    runInThisContext(`(function(exports, require) { ${outputText}\n})`)(exports, (path) => {
      assert.match(path, /^\.\/[\w.-]+$/);
      return load(path.slice(2));
    });
  }
  modules.set(name, exports);
  return exports;
}

const { verifyRequestedModel } = load("model-request-verification");
const { calculateVerifiedGemsCertificates } = load("nsw-hvac-rebate");
const request = {
  system_type: "split", brand: "Example Air", model: "in-7 / out-7",
  capacity: "7.1kW", phase: "single", postcode: "2145", install_type: "replacement",
};
const record = {
  _id: 9, "Registration Number": "AAC99999",
  Brand: "EXAMPLE AIR", Model_No: "OUT-7 / IN-7", "Family Name": "Example Series",
  SubmitStatus: "Approved", "Availability Status": "Available", Sold_in: "Australia,New Zealand",
  Configuration1: "Non Ducted", Configuration2: "Single Split System",
  ApplStandard: "[SEER Non Multi-Split <=65kW]",
  "Outdoor unit only": "No", Phase: "Single", "Product Class": "Class 9",
  "C-Total Cool Rated": "7.10", "H-Total Heat Rated": "8.0", "C-Power_Inp_Rated": "1.5",
  "Rated AEER": "4.8", "Rated ACOP": "4.6", "Residential TCSPF_mixed": "5.2",
  "Residential HSPF_mixed": "4.4", "Residential HSPF_cold": "4.1",
  ...Object.fromEntries(["tcec", "thec"].flatMap((kind) =>
    ["hot", "mixed", "cold"].map((zone) => [`Residential ${kind}_${zone}`, zone === "hot" ? "0" : "500"]))),
};
const certificates = { esc: 2.34, prc: 4.56, rebate: 999, lookupSource: "GEMS registry + NSW formula" };
const unavailable = new Error("Unexpected external fetch in offline tests");
const originalFetch = globalThis.fetch;
const savedEnv = { from: process.env.MODEL_REQUEST_FROM_EMAIL, key: process.env.RESEND_API_KEY };
globalThis.fetch = async () => { throw unavailable; };

try {
  const verify = (overrides = {}, rows = [record], result = {}, calculate = undefined) => verifyRequestedModel(
    { ...request, ...overrides },
    {
      fetchRecords: async (options) => {
        assert.equal(options.revalidateSeconds, 0);
        assert.equal(options.brand, overrides.brand ?? request.brand);
        assert.equal(options.query, undefined);
        return rows;
      },
      calculateRebate: calculate ?? (async () => ({ ...certificates, registryRecord: rows[0], ...result })),
    },
  );
  const verified = await verify({}, [record], {}, async (input, usedRecord) => {
    assert.equal(usedRecord, record);
    assert.deepEqual(input, {
      brand: record.Brand, model: record.Model_No, systemType: "split",
      postcode: "2145", installType: "replacement", escRate: 1, prcRate: 1,
    });
    return { ...certificates, registryRecord: record };
  });
  assert.equal(verified.kind, "verified");
  assert.deepEqual(verified.product, {
    brand: record.Brand, model: record.Model_No, series: "Example Series",
    systemType: "split", capacityKw: 7.1, phase: "Single",
  });
  assert.deepEqual(verified.evidence.certificates, { esc: 2.34, prc: 4.56, lookupSource: certificates.lookupSource });
  assert.equal(verified.evidence.registry.registrationNumber, "AAC99999");
  assert.equal(verified.evidence.sourceUrl, "https://data.gov.au/data/api/3/action/datastore_search_sql");
  assert.equal(new Date(verified.evidence.verifiedAt).toISOString(), verified.evidence.verifiedAt);
  assert.equal((await verify({ system_type: "ducted", phase: "unknown", capacity: "", install_type: "new" },
    [{ ...record, Configuration1: "Ducted", Phase: "Three-phase" }], { esc: 0 })).product.phase, "Three");

  for (const [overrides, rows] of [
    [{ postcode: "" }], [{ install_type: "" }], [{ system_type: "multi_split" }],
    [{ postcode: "0000" }], [{ model: "OUT-7" }], [{ model: "OUT-7 / IN-7 / IN-8" }],
    [{ model: "OUT7 / IN-7" }], [{ model: "OUT-7 / IN-7A" }], [{ brand: "ExampleAir" }],
    [{ phase: "Three" }], [{ phase: "bogus" }], [{ capacity: "7" }], [{ capacity: "7.1 or 8" }],
    [{ system_type: "ducted" }], [{}, [{ ...record, Configuration1: "Something non ducted" }]],
    [{}, [{ ...record, Configuration1: "", "Product Type": "Non Ducted" }]],
    [{}, [{ ...record, Configuration2: "Unitary" }]],
    [{}, [{ ...record, ApplStandard: "GEMS Multi-Split" }]],
    [{}, [{ ...record, "Outdoor unit only": "Yes" }]],
    [{}, [{ ...record, Sold_in: "Not Australia" }]],
    [{}, [{ ...record, Sold_in: "New Zealand" }]],
    [{}, [{ ...record, ExpDate: "2000-01-01" }]],
    [{}, [{ ...record, SubmitStatus: "Pending" }]],
    [{}, [{ ...record, "Availability Status": "Unavailable" }]],
    [{}, [record, { ...record, Phase: "Three" }]],
    [{}, [record, { ...record, Model_No: "IN-7 / OUT-7", "Rated AEER": "" }]],
    [{}, Array(10_000).fill(record)],
    [{}, [{ ...record, "Rated AEER": 0 }]],
    [{}, [{ ...record, "Residential tcec_hot": " " }]],
    [{}, [{ ...record, "Residential thec_hot": -1 }]],
    [{}, [{ ...record, "C-Total Cool Rated": "" }]],
  ]) {
    const result = await verify(overrides, rows, {}, async () => assert.fail("Invalid registration reached certificate calculation"));
    assert.equal(result.kind, "review", JSON.stringify(overrides));
  }
  for (const result of [
    { esc: 0, prc: 0 }, { esc: null }, { prc: -1 },
    { registryRecord: undefined }, { registryRecord: { ...record, Brand: "Other" } },
    { registryRecord: { ...record, "Rated AEER": "4.9" } },
  ]) {
    assert.equal((await verify({}, [record], result)).kind, "review");
  }
  assert.equal((await verify({}, [record], {}, async () => { throw new Error("Unable to calculate certificates"); })).kind, "review");
  const timeout = new Error("Live rebate service timed out");
  await assert.rejects(verify({}, [record], {}, async () => { throw timeout; }), (error) => error === timeout);
  await assert.rejects(verifyRequestedModel(request, { fetchRecords: async () => { throw timeout; } }), (error) => error === timeout);

  const daikin = {
    ...record, Brand: "DAIKIN", Model_No: "RXV25AVMA / FTXV25AVMA",
    "Registration Number": "AAC10273", "Family Name": null, ExpDate: "2099-07-02",
    "C-Total Cool Rated": "2.5", "C-Power_Inp_Rated": "0.485", "Product Class": "Class 8",
    "Residential TCSPF_mixed": "7.276", "Residential HSPF_mixed": "5.2",
  };
  const daikinRequest = { ...request, brand: "Daikin", model: "FTXV25AVMA / RXV25AVMA", capacity: "2.5kW" };
  const calculationInput = {
    brand: daikin.Brand, model: daikin.Model_No, systemType: "split",
    postcode: request.postcode, installType: request.install_type, escRate: 55, prcRate: 35,
  };
  for (const mismatched of [
    { ...daikin, Brand: "OTHER" }, { ...daikin, Model_No: "RXV25AVMA" },
    { ...daikin, Sold_in: "Not Australia" }, { ...daikin, ExpDate: "2000-01-01" },
    { ...daikin, "Availability Status": "Unavailable" },
  ]) {
    await assert.rejects(calculateVerifiedGemsCertificates(calculationInput, mismatched), /exact active Australian/);
  }
  let inventoryCalls = 0;
  globalThis.fetch = async (url, options) => {
    const target = new URL(url);
    if (target.hostname === "data.gov.au") {
      assert.ok(target.pathname.endsWith("_sql"), "Certificate verification must not search for other registrations");
      assert.match(target.searchParams.get("sql"), /LOWER\('Daikin'\)/);
      inventoryCalls += 1;
      return Response.json({ success: true, result: { records: [daikin, { ...daikin, Brand: "OTHER" }] } });
    }
    assert.equal(target.origin, "https://of-sfg-rac-prd.energy.nsw.gov.au");
    const building = JSON.parse(options.body).buildings.building_1;
    const date = Object.keys(building.HVAC1_PDRSAug24_PDRS__postcode)[0];
    assert.equal(building.HVAC1_PDRSAug24_PDRS__postcode[date], request.postcode);
    const fields = building.HVAC1_PDRSAug24_Activity
      ? { HVAC1_PDRSAug24_ESC_calculation: 2.34, HVAC1_PDRSAug24_PRC_calculation: 4.56 }
      : { HVAC1_PDRSAug24_get_climate_zone_by_postcode: "mixed", HVAC1_PDRSAug24_BCA_climate_zone_by_postcode: 5 };
    if (building.HVAC1_PDRSAug24_Activity) {
      assert.equal(building.HVAC1_PDRSAug24_Activity[date], "replacement_activity");
      assert.equal(building.HVAC1_PDRSAug24_cooling_capacity_input[date], 2.5);
      assert.equal(building.HVAC1_PDRSAug24_input_power[date], 0.485);
    }
    return Response.json({ buildings: { building_1: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { [date]: value }])) } });
  };
  const defaultResult = await verifyRequestedModel(daikinRequest);
  assert.equal(defaultResult.kind, "verified");
  assert.equal(inventoryCalls, 1);
  assert.equal(defaultResult.product.brand, "Daikin");
  assert.equal(defaultResult.evidence.registry.brand, "DAIKIN");
  assert.equal(defaultResult.product.model, daikin.Model_No);
  assert.equal(defaultResult.product.series, "Split system");
  assert.equal(defaultResult.evidence.certificates.esc, 2.34);
  assert.deepEqual(await calculateVerifiedGemsCertificates(calculationInput, daikin), {
    rebate: 6.9, esc: 2.34, prc: 4.56, escRate: 1, prcRate: 1, contractApplied: false,
    lookupSource: "Exact GEMS registration + NSW formula", registryRecord: daikin,
  });

  const emailInput = {
    requestId: "7ca74bda-f3ad-4aaf-ada9-9aa387df07a1",
    brand: "Brand <img>", model: "M&'\"", systemType: "<ducted>", existing: false,
    recipient: "fixture@example.com",
  };
  const email = buildModelRequestEmail(emailInput);
  assert.match(email.html, /Brand &lt;img&gt; M&amp;&#39;&quot; \(&lt;ducted&gt;\)/);
  assert.match(buildModelRequestEmail({ ...emailInput, requestId: "<request>" }).html, /&lt;request&gt;/);
  assert.match(email.html, /href="https:\/\/calculator\.rebateportal\.com\.au\/calculator"/);
  const addedEmail = buildModelRequestEmail({ ...emailInput, systemType: "split" });
  const existingEmail = buildModelRequestEmail({ ...emailInput, systemType: "ducted", existing: true });
  for (const format of ["html", "text"]) {
    assert.match(addedEmail[format], /\$0 equipment price.*business admin.*catalogue price.*appear for salespeople/);
    assert.match(existingEmail[format], /already in[\s\S]*If the equipment price is still \$0.*business admin.*appear for salespeople/);
    assert.match(addedEmail[format], /Warranty and WiFi details have not been confirmed/);
    assert.doesNotMatch(existingEmail[format], /warranty|wifi/i);
    for (const [message, section] of [[addedEmail, "Split System"], [existingEmail, "Ducted System"]]) {
      assert.match(message[format], /enter the equipment price directly in the calculator before quoting without saving it to the catalogue/);
      assert.match(message[format], new RegExp(`Refresh the calculator page, then select the ${section} section and choose Brand .*You do not need to sign out`));
    }
  }

  globalThis.fetch = async () => { throw unavailable; };
  process.env.RESEND_API_KEY = "fixture-key";
  delete process.env.MODEL_REQUEST_FROM_EMAIL;
  await assert.rejects(sendModelRequestConfirmation(emailInput), /MODEL_REQUEST_FROM_EMAIL/);
  process.env.MODEL_REQUEST_FROM_EMAIL = "Rebate Portal <personal@example.com>";
  await assert.rejects(sendModelRequestConfirmation(emailInput), /MODEL_REQUEST_FROM_EMAIL/);
  process.env.MODEL_REQUEST_FROM_EMAIL = "notifications@mail.rebateportal.com.au";
  delete process.env.RESEND_API_KEY;
  await assert.rejects(sendModelRequestConfirmation(emailInput), /RESEND_API_KEY/);
  process.env.RESEND_API_KEY = "fixture-key";
  await assert.rejects(sendModelRequestConfirmation({ ...emailInput, requestId: "not-a-uuid" }), /UUID/);
  await assert.rejects(sendModelRequestConfirmation({ ...emailInput, recipient: "a@example.com,b@example.com" }), /single recipient/);

  const sends = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://api.resend.com/emails");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer fixture-key");
    assert.equal(options.headers["Idempotency-Key"], `model-request-completion/${emailInput.requestId}`);
    assert.ok(options.signal instanceof AbortSignal);
    sends.push(JSON.parse(options.body));
    return Response.json({ id: "test-message-id" });
  };
  assert.equal(await sendModelRequestConfirmation(emailInput), "test-message-id");
  assert.equal(await sendModelRequestConfirmation({ ...emailInput, requestId: emailInput.requestId.toUpperCase() }), "test-message-id");
  assert.deepEqual(sends, [sends[0], sends[0]]);
  assert.deepEqual(sends[0], {
    ...email, from: "Rebate Portal <notifications@mail.rebateportal.com.au>",
    to: [emailInput.recipient], reply_to: "danieldipalma88@gmail.com",
  });
  globalThis.fetch = async () => Response.json({}, { status: 503 });
  await assert.rejects(sendModelRequestConfirmation(emailInput), /HTTP 503/);
  globalThis.fetch = async () => Response.json({});
  await assert.rejects(sendModelRequestConfirmation(emailInput), /message ID/);
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of [["MODEL_REQUEST_FROM_EMAIL", savedEnv.from], ["RESEND_API_KEY", savedEnv.key]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

console.log("Offline GEMS verification, certificate provenance and Resend confirmation checks passed.");

if (process.argv.includes("--live")) {
  const result = await verifyRequestedModel({
    system_type: "split", brand: "Daikin", model: "RXV25AVMA / FTXV25AVMA",
    capacity: "2.5kW", phase: "single", postcode: "2000", install_type: "replacement",
  });
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.kind, "verified");
}
