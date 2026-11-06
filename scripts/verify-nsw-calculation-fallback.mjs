import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { calculateNswFallback, toOpenFiscaDecimal } from '../services/nsw-rebate-backup/engine/nsw-calculation-fallback.mjs';
import { evaluateNswModel } from '../services/nsw-rebate-backup/engine/nsw-calculation-fallback-model.mjs';

const DATE = '2021-01-01';
const PREFIX = 'HVAC1_PDRSAug24_';
const POSTCODE = 'PDRS__postcode';
const CLIMATE = 'get_climate_zone_by_postcode';
const BCA = 'BCA_climate_zone_by_postcode';
const REGIONAL = 'PDRS__regional_network_factor';
const NETWORK = 'get_network_loss_factor_by_postcode';
const ESC_PROXY = ['electricity_savings', 'annual_energy_savings'];
const PRC_ACTUAL = [REGIONAL, 'peak_demand_reduction_capacity', NETWORK, 'PRC_calculation', 'peak_demand_annual_savings'];
const CERTIFICATES = [...ESC_PROXY, ...PRC_ACTUAL, 'ESC_calculation'];
const LOOKUPS = [CLIMATE, BCA, REGIONAL, NETWORK];
const CLASSES = [5, 6, 7, 8, 9, 10, 11, 12, 18, 19, 20, 21];
const TYPES = ['non_ducted_single_split_system', 'ducted_single_split_system', 'non_ducted_multi_split_system'];
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const json = (path) => JSON.parse(read(path));

function python(action, input) {
  const path = fileURLToPath(new URL('./nsw-fallback-reference.py', import.meta.url));
  const result = spawnSync(process.env.NSW_REFERENCE_PYTHON || 'python', ['-B', path, action], {
    input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', maxBuffer: 16_000_000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr || `Oracle failed: ${action}`);
  return result.stdout;
}

function payload(values, outputs, date = DATE) {
  const entries = [...Object.entries(values), ...outputs.map((field) => [field, null])];
  const building_1 = Object.fromEntries(entries.map(([field, value]) => [PREFIX + field, { [date]: value }]));
  return { buildings: { building_1 }, persons: { person1: {} } };
}

function field(response, name, date = DATE) {
  return response.buildings.building_1[PREFIX + name][date];
}

function oracle(payloads) {
  return JSON.parse(python('oracle', payloads));
}

function compare(requests, label) {
  const references = oracle(requests);
  for (const [i, request] of requests.entries()) {
    const reference = references[i];
    assert.ok(reference.response, `${label} ${i}: ${reference.error}`);
    assert.deepEqual(calculateNswFallback(request), reference.response, `${label} ${i}`);
  }
  console.log(`${label}: ${requests.length} exact OpenFisca response matches`);
}

// Only the test harness uses upstream variable defaults and overrides. The
// production-shaped interface refuses both missing fields and overrides.
const upstreamDefaults = {
  Activity: 'replacement_activity', Air_Conditioner_type: TYPES[0], BCA_Climate_Zone: 'BCA_Climate_Zone_5',
  PDRS__postcode: 0, product_class_input: '', cooling_capacity_input: 0, heating_capacity_input: 0,
  rated_ACOP_input: 0, rated_AEER_input: 0, HSPF_cold: 0, HSPF_mixed: 0, TCSPF_mixed: 0,
  residential_TCEC: 0, residential_THEC: 0, input_power: 0,
};

function verifyOfficial() {
  const rows = [];
  let groups = 0;
  for (const test of JSON.parse(python('cases'))) {
    const [entry, ...rest] = Object.entries(test.output);
    assert.equal(rest.length, 0);
    const [name, expected] = entry;
    if (name === 'WH1_get_network_loss_factor_by_postcode') {
      // The official PRC suite also exercises the same scale via WH1. No WH1
      // variable is exposed by this engine; test the shared scale directly.
      assert.equal(expected.length, test.input.WH1_PDRS__postcode.length);
      for (const [i, postcode] of test.input.WH1_PDRS__postcode.entries()) {
        assert.equal(toOpenFiscaDecimal(evaluateNswModel({ [POSTCODE]: postcode })(NETWORK)), expected[i]);
      }
      console.log(`Official WH1 shared-scale assertions: ${expected.length} passed`);
      continue;
    }
    assert.ok(name.startsWith(PREFIX));
    assert.ok(Array.isArray(expected));
    groups++;
    for (const [i, target] of expected.entries()) {
      const values = Object.fromEntries(Object.entries(test.input).map(([key, values]) => {
        assert.ok(key.startsWith(PREFIX));
        assert.equal(values.length, expected.length);
        return [key.slice(PREFIX.length), values[i]];
      }));
      rows.push({ test, name: name.slice(PREFIX.length), i, target, values });
    }
  }
  const references = oracle(rows.map(({ values, name, test }) => payload(values, [name], test.period)));
  for (const [i, { test, name, i: row, target, values }] of rows.entries()) {
    const label = `${test.file} #${test.index} (${test.name}), row ${row + 1}`;
    assert.ok(references[i].response, `${label}: ${references[i].error}`);
    const reference = field(references[i].response, name, test.period);
    const raw = evaluateNswModel({ ...upstreamDefaults, ...values })(name);
    const result = typeof raw === 'number' && name !== 'certificate_climate_zone' ? toOpenFiscaDecimal(raw) : raw;
    assert.equal(result, reference, label);
    if (typeof target === 'number') {
      const margin = (test.absolute_error_margin ?? 1e-6) + Math.abs(target) * (test.relative_error_margin ?? 0);
      assert.ok(Math.abs(Number(result) - target) <= margin, `${label}: ${result} != ${target}`);
    } else {
      assert.equal(result, target, label);
    }
  }
  console.log(`Official HVAC1 YAML: ${rows.length} assertions across ${groups} groups; all exact vs Python`);
}

function metadataFields(record, climate) {
  const names = {
    cooling_capacity_input: 'Cooling Capacity', heating_capacity_input: 'Heating Capacity',
    input_power: 'Input Power', rated_AEER_input: 'Rated AEER', rated_ACOP_input: 'Rated ACOP',
    TCSPF_mixed: 'Residential TCSPF_mixed', HSPF_mixed: 'Residential HSPF_mixed', HSPF_cold: 'Residential HSPF_cold',
    residential_TCEC: `Residential tcec_${climate}`, residential_THEC: `Residential thec_${climate}`,
  };
  return {
    product_class_input: record['Product Class'],
    ...Object.fromEntries(Object.entries(names).map(([key, column]) => {
      assert.ok(record[column] !== undefined && record[column] !== null && record[column] !== '');
      return [key, Number(record[column])];
    })),
  };
}

// Exact GEMS registration inputs provided by the coordinator (not screenshot outputs).
const splitEvidence = {
  'fujitsu-2170-new': {
    'Product Class': 'Class 8', 'Cooling Capacity': 2.5, 'Heating Capacity': 3.2, 'Input Power': 0.53,
    'Rated AEER': 4.701, 'Rated ACOP': 4.8352, 'Residential TCSPF_mixed': 6.755,
    'Residential HSPF_mixed': 4.975, 'Residential HSPF_cold': 4.548,
    'Residential tcec_mixed': 155, 'Residential thec_mixed': 351,
  },
  'rinnai-2549-replacement': {
    'Product Class': 'Class 9', 'Cooling Capacity': 5, 'Heating Capacity': 6, 'Input Power': 1.149,
    'Rated AEER': 4.3436, 'Rated ACOP': 4.1149, 'Residential TCSPF_mixed': 6.698,
    'Residential HSPF_mixed': 4.78, 'Residential HSPF_cold': 4.164,
    'Residential tcec_cold': 197, 'Residential thec_cold': 1883,
  },
};

function decimalCounts(actual, esc = actual) {
  return {
    esc: field(esc, 'electricity_savings') * field(actual, REGIONAL) * 1.06,
    prc: field(actual, 'peak_demand_reduction_capacity') * field(actual, NETWORK) * 10,
  };
}

function equipment(record, test, recoveryClimate) {
  const lookup = calculateNswFallback(payload({ [POSTCODE]: test.postcode }, LOOKUPS));
  const climate = field(lookup, CLIMATE);
  assert.notEqual(recoveryClimate ?? climate, '0');
  return {
    [POSTCODE]: test.postcode,
    ...metadataFields(record, climate === '0' ? recoveryClimate : climate),
    Activity: test.installType === 'new' ? 'new_installation_activity' : 'replacement_activity',
    Air_Conditioner_type: test.systemType === 'ducted' ? TYPES[1] : TYPES[0],
    BCA_Climate_Zone: `BCA_Climate_Zone_${field(lookup, BCA)}`,
  };
}

function verifyHistory() {
  const records = json('./fixtures/temperzone-templite-gems.json').models;
  const captures = json('./fixtures/nsw-certificate-reference-20261028.json').results;
  const screenshots = json('./fixtures/rebate-reference-cases.json').historicalElectricFutureEvidence;
  const requests = [];
  for (const capture of captures) {
    const meta = records.find((item) => item.model === capture.model);
    assert.ok(meta, capture.model);
    const input = equipment(meta, { ...capture, systemType: 'ducted' });
    const request = payload(input, CERTIFICATES);
    requests.push(request);
    const actual = decimalCounts(calculateNswFallback(request));
    // Reconstruct only the caller gate needed by these Class 10/11 records.
    assert.ok(['Class 10', 'Class 11'].includes(input.product_class_input) && input.TCSPF_mixed >= 4);
    const heatingPass = capture.postcode === '2620' ? input.HSPF_cold >= 3 : input.HSPF_mixed >= 3.5;
    assert.deepEqual({ ...actual, esc: heatingPass ? actual.esc : 0 }, { esc: capture.esc, prc: capture.prc },
      `${capture.model} ${capture.postcode} ${capture.installType}`);
  }
  console.log(`Temperzone historical decimal captures: ${captures.length} exact matches`);

  for (const test of screenshots) {
    const input = equipment(splitEvidence[test.id], test, 'cold');
    let actual;
    if (test.postcode === '2549') {
      const direct = payload(input, CERTIFICATES);
      assert.throws(() => calculateNswFallback(direct), { code: 'NSW_UNSUPPORTED_ESS_CLIMATE' });
      assert.match(oracle([direct])[0].error, /no field of name 0/);
      const proxy = payload({ ...input, [POSTCODE]: '2620' }, ESC_PROXY);
      const actualPostcode = payload(input, PRC_ACTUAL);
      requests.push(proxy, actualPostcode);
      actual = decimalCounts(calculateNswFallback(actualPostcode), calculateNswFallback(proxy));
    } else {
      const direct = payload(input, CERTIFICATES);
      requests.push(direct);
      actual = decimalCounts(calculateNswFallback(direct));
    }
    const expected = test.expectedRoundedCertificates;
    for (const key of ['esc', 'prc']) assert.ok(Math.abs(actual[key] - expected[key]) <= expected.tolerance, test.id);
    console.log(`Historical ${test.id}: ESC ${actual.esc}, PRC ${actual.prc}`);
  }
  compare(requests, 'Historical fixture requests');
}

function verifyPostcodes() {
  const { postcodes, crossBorderPostcodes } = json('./fixtures/nsw-postcodes.abs-2021.json');
  const codes = [...new Set([...postcodes, ...crossBorderPostcodes])];
  const requests = codes.map((code) => payload({ [POSTCODE]: code }, LOOKUPS));
  const references = oracle(requests);
  const rejected = [];
  const sentinel = [];
  for (const [i, code] of codes.entries()) {
    const upstream = references[i].response;
    assert.ok(upstream, references[i].error);
    if (field(upstream, NETWORK) <= 0 || field(upstream, REGIONAL) <= 0 || !/^[1-8]$/.test(field(upstream, BCA))) {
      assert.throws(() => calculateNswFallback(requests[i]), RangeError, code);
      rejected.push(code);
    } else {
      assert.deepEqual(calculateNswFallback(requests[i]), upstream, code);
      if (field(upstream, CLIMATE) === '0') sentinel.push(code);
    }
  }
  assert.ok(sentinel.includes('2549') && sentinel.includes('2550'));
  assert.equal(field(calculateNswFallback(payload({ [POSTCODE]: '2163' }, LOOKUPS)), BCA), '6');
  console.log(`ABS inventory: ${codes.length - rejected.length}/${codes.length} matched; ${rejected.length} fail closed (${rejected.join(', ')})`);
  console.log(`Official ESS sentinel among supported lookups: ${sentinel.length} (${sentinel.join(', ')})`);
}

function verifyDifferentialAndGuards() {
  let seed = 360418;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const requests = Array.from({ length: 450 }, (_, i) => payload({
    Activity: i % 2 ? 'new_installation_activity' : 'replacement_activity',
    Air_Conditioner_type: TYPES[i % 3], product_class_input: `Class ${CLASSES[i % CLASSES.length]}`,
    HSPF_cold: i % 9 ? random() * 7 : 0, HSPF_mixed: i % 4 ? random() * 7 : 0,
    [POSTCODE]: ['2481', '2000', '2620', '2311', '2170', '3707'][Math.floor(i / 3) % 6],
    TCSPF_mixed: i % 5 ? random() * 8 : 0, cooling_capacity_input: random() * 65,
    heating_capacity_input: i % 7 ? random() * 75 : 0, rated_ACOP_input: 1 + random() * 7,
    rated_AEER_input: 1 + random() * 7, residential_TCEC: i % 2 ? random() * 4000 : 0,
    residential_THEC: i % 3 ? random() * 5000 : 0, input_power: random() * 10,
    BCA_Climate_Zone: `BCA_Climate_Zone_${1 + i % 8}`,
  }, CERTIFICATES));

  const cold = equipment(splitEvidence['rinnai-2549-replacement'], { postcode: '2550', installType: 'replacement' }, 'cold');
  const invalidClimate = payload(cold, CERTIFICATES);
  assert.throws(() => calculateNswFallback(invalidClimate), { code: 'NSW_UNSUPPORTED_ESS_CLIMATE' });
  assert.match(oracle([invalidClimate])[0].error, /no field of name 0/);
  const actual = payload(cold, PRC_ACTUAL);
  assert.equal(field(calculateNswFallback(actual), NETWORK), 1);
  requests.push(actual, payload({ ...cold, [POSTCODE]: '2620' }, ESC_PROXY));
  compare(requests, 'Differential and 2550 recovery');

  const good = requests[1];
  const before = structuredClone(good);
  const a = calculateNswFallback(good);
  const b = calculateNswFallback(good);
  assert.deepEqual(good, before);
  assert.deepEqual(a, b);
  assert.notEqual(a.buildings.building_1, b.buildings.building_1);
  assert.equal(toOpenFiscaDecimal(1234567.25), 1234567.2);
  assert.equal(toOpenFiscaDecimal(-162385.625), -162385.62);

  const setField = (key, value) => (draft) => { draft.buildings.building_1[PREFIX + key] = { [DATE]: value }; };
  const invalid = [
    (draft) => { draft.url = 'https://example.invalid'; },
    (draft) => { draft.persons.person1.foo = 'bar'; },
    (draft) => { draft.buildings.building_2 = {}; },
    (draft) => { draft.buildings.building_1[PREFIX + POSTCODE]['2026-09-07'] = '2000'; },
    (draft) => { delete draft.buildings.building_1[PREFIX + 'input_power']; },
    setField(POSTCODE, '0000'), setField(POSTCODE, '3000'), setField(POSTCODE, '2001'), setField(POSTCODE, '2000 '),
    setField('ESC_calculation', 0), setField('not_a_variable', null), setField('product_class_input', 'Class 13'),
    setField('BCA_Climate_Zone', 'BCA_Climate_Zone_9'), setField('Activity', 'repair'),
    setField('input_power', Infinity), setField('input_power', NaN), setField('input_power', '2.5'),
    setField('input_power', -1), setField('input_power', 1e300), setField('input_power', 3e38),
  ];
  for (const mutate of invalid) {
    const draft = structuredClone(good);
    mutate(draft);
    assert.throws(() => calculateNswFallback(draft), RangeError);
  }
  for (const invalidPayload of [null, [], 'bad', { buildings: [], persons: {} }]) {
    assert.throws(() => calculateNswFallback(invalidPayload), TypeError);
  }
  assert.throws(() => calculateNswFallback(payload({ [POSTCODE]: '2000' }, LOOKUPS, '2024')), RangeError);
  console.log(`Fail-closed checks: ${invalid.length + 5} invalid requests rejected; input unchanged`);
}

assert.equal(python('data').replaceAll('\r\n', '\n'), read('../services/nsw-rebate-backup/engine/nsw-calculation-fallback-data.mjs').replaceAll('\r\n', '\n'));
verifyOfficial();
verifyHistory();
verifyPostcodes();
verifyDifferentialAndGuards();
