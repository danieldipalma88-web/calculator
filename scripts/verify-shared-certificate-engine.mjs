// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const service = new URL('../services/nsw-rebate-backup/', import.meta.url);
const modules = new Set([
  'shared-engine/index.mjs', 'shared-engine/coverage.mjs', 'engine/nsw-calculation-fallback.mjs',
  'engine/nsw-calculation-fallback-model.mjs', 'engine/nsw-calculation-fallback-data.mjs',
].map((path) => new URL(path, service).href));
let blockedAttempts = 0;
function block() {
  blockedAttempts++;
  throw new Error('I/O forbidden during shared certificate verification');
}
globalThis.fetch = block;
globalThis.WebSocket = block;
// Load only the audited, local engine graph: no HTTP, Node builtins or other dependencies.
registerHooks({ resolve(specifier, context, next) {
  if (modules.has(context.parentURL) && (!specifier.startsWith('.') || !modules.has(new URL(specifier, context.parentURL).href))) block();
  return next(specifier, context);
} });
const { calculateSharedCertificates, compareCertificateShadow } = await import(new URL('shared-engine/index.mjs', service));
const { coversPostcode, coverageRelease } = await import(new URL('shared-engine/coverage.mjs', service));
const { calculateNswFallback } = await import(new URL('engine/nsw-calculation-fallback.mjs', service));

const lab = resolve(process.env.CERTIFICATE_ENGINE_LAB ?? fileURLToPath(new URL('../../rebate-engine-lab/', import.meta.url)));
const digest = (value) => createHash('sha256').update(value).digest('hex');
function readPinned(path, hash) {
  const bytes = readFileSync(resolve(lab, path));
  assert.equal(digest(bytes), hash, `Unexpected pinned lab artifact: ${path}`);
  return JSON.parse(bytes);
}
const manifest = readPinned('data/manifest.json', 'ae6869fdf8d1bfeed23fa038dd0eb636a787b946be25795f049b2882ef26bb94');
const atlas = readPinned('data/atlas.json', manifest.dataSha256);
const gems = readPinned('data/inputs/gems-gap-regressions-20261106.json', manifest.provenance.gemsSha256);
const legacy = readPinned('outputs/existing-calculator-parity.json', '78dca186256fff59295e711a6d159c1313a9459ed64c5ca8913ac05f5b4cf590');
const PERIOD = manifest.sourcePeriod;
const PREFIX = 'HVAC1_PDRSAug24_';
const zones = new Map();

function environmentFor(postcode) {
  if (!zones.has(postcode)) {
    const building = calculateNswFallback({ buildings: { building_1: {
      [PREFIX + 'PDRS__postcode']: { [PERIOD]: postcode },
      [PREFIX + 'get_climate_zone_by_postcode']: { [PERIOD]: null },
      [PREFIX + 'BCA_climate_zone_by_postcode']: { [PERIOD]: null },
    } }, persons: { person1: {} } }).buildings.building_1;
    zones.set(postcode, {
      essClimateZone: building[PREFIX + 'get_climate_zone_by_postcode'][PERIOD],
      bcaClimateZone: Number(building[PREFIX + 'BCA_climate_zone_by_postcode'][PERIOD]),
    });
  }
  return { postcode, jurisdiction: 'NSW', ...zones.get(postcode), coverageRelease,
    observedAt: manifest.generatedAt, validUntil: manifest.validUntil };
}

function equipmentFor({ model, record }, expected) {
  assert.equal(record.Model_No, model);
  assert.equal(record.Brand, expected.brand);
  assert.equal(record['Registration Number'], expected.registrationNumber);
  assert.equal(record.SubmitStatus, 'Approved');
  assert.equal(record['Availability Status'], 'Available');
  assert.ok(record.Sold_in.split(',').includes('Australia'));
  assert.equal(record.Phase, 'Single');
  assert.equal(record.Configuration2, 'Single Split System');
  assert.match(record['Product Class'], /^Class (8|10)$/);
  assert.equal(record.Configuration1, record['Product Class'] === 'Class 8' ? 'Non Ducted' : 'Ducted');
  const numeric = (field) => {
    assert.match(record[field], /^\d+(\.\d+)?$/);
    return Number(record[field]);
  };
  const annualEnergy = Object.fromEntries(['hot', 'mixed', 'cold'].map((zone) => [zone, {
    coolingKwh: numeric(`Residential tcec_${zone}`), heatingKwh: numeric(`Residential thec_${zone}`),
  }]));
  return {
    brand: record.Brand, model, phase: 'single', cycle: 'reverse-cycle', indoorHeadCount: 1,
    productClass: Number(record['Product Class'].slice(6)), systemType: record.Configuration1 === 'Ducted' ? 'ducted' : 'split',
    registration: {
      number: record['Registration Number'], market: 'AU', status: 'active', resourceId: gems.sourceResourceId,
      snapshotSha256: manifest.provenance.gemsSha256, observedAt: manifest.provenance.gemsFetchedAt,
      validUntil: manifest.validUntil, registrationValidUntil: new Date(record.ExpDate).toISOString(),
    },
    ratings: {
      coolingCapacityKw: numeric('C-Total Cool Rated'), heatingCapacityKw: numeric('H-Total Heat Rated'),
      coolingInputKw: numeric('C-Power_Inp_Rated'), ratedAeer: numeric('Rated AEER'), ratedAcop: numeric('Rated ACOP'),
      tcspfMixed: numeric('Residential TCSPF_mixed'), hspfMixed: numeric('Residential HSPF_mixed'),
      hspfCold: numeric('Residential HSPF_cold'), annualEnergy,
    },
  };
}

const equipment = new Map(gems.models.map((seed) => {
  const expected = manifest.models.find(({ model }) => model === seed.model);
  return [seed.model, equipmentFor(seed, expected)];
}));
function fixture(postcode = '2000', installation = 'new', model = gems.models[0].model) {
  return { schemaVersion: 1, asOf: manifest.generatedAt, installation, equipment: structuredClone(equipment.get(model)), environment: environmentFor(postcode) };
}
function rejects(input, code, field) {
  const result = calculateSharedCertificates(input);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.code, code);
  if (field !== undefined) assert.equal(result.field, field);
  assert.ok(!Object.hasOwn(result, 'counts'));
}

test('coverage is exactly the pinned audited inventory, with all 70 exclusions rejected', () => {
  assert.equal(coverageRelease, manifest.releaseId);
  const supported = Array.from({ length: 10000 }, (_, n) => String(n).padStart(4, '0')).filter(coversPostcode);
  assert.equal(supported.length, 552);
  assert.deepEqual(supported, manifest.postcodes);
  assert.equal(manifest.excludedPostcodes.length, 70);
  for (const { postcode } of manifest.excludedPostcodes) {
    const input = fixture();
    input.environment.postcode = postcode;
    rejects(input, 'unsupported-postcode', 'environment.postcode');
  }
  assert.ok(manifest.excludedPostcodes.some(({ postcode, reason }) => postcode === '2163' && reason === 'ambiguous-rule-input'));
});

test('all 5,520 supported rows match both the pinned Python atlas and recorded calculator decimals', (t) => {
  const count = 552 * 5 * 2;
  assert.equal(manifest.rowCount, count);
  assert.equal(atlas.length, count);
  assert.equal(legacy.cases.length, count);
  assert.equal(legacy.discrepancies.length, 0);
  const key = (model, postcode, installation) => `${model}|${postcode}|${installation}`;
  const expected = new Map(legacy.cases.map(({ model, postcode, installation, expected }) => [key(model, postcode, installation), expected]));
  assert.equal(expected.size, count);
  const max = { atlasEsc: 0, atlasPrc: 0, quoteEsc: 0, quotePrc: 0 };
  for (const [brand, model, postcode, installation, esc, prc] of atlas) {
    const label = key(model, postcode, installation);
    const authoritative = expected.get(label);
    assert.ok(expected.delete(label), `Missing or duplicate baseline: ${label}`);
    assert.ok(manifest.installations.includes(installation));
    const input = fixture(postcode, installation, model);
    assert.equal(input.equipment.brand, brand);
    const comparison = compareCertificateShadow(input, { esc: authoritative.esc, prc: authoritative.prc });
    assert.equal(comparison.status, 'match', `${label}: ${JSON.stringify(comparison)}`);
    const actual = comparison.candidate.counts;
    const atlasEsc = Math.abs(actual.esc - esc);
    const atlasPrc = Math.abs(actual.prc - prc);
    assert.ok(atlasEsc <= 0.0002 && atlasPrc <= 0.0002, `${label}: atlas differences ${atlasEsc}, ${atlasPrc}`);
    max.atlasEsc = Math.max(max.atlasEsc, atlasEsc);
    max.atlasPrc = Math.max(max.atlasPrc, atlasPrc);
    max.quoteEsc = Math.max(max.quoteEsc, Math.abs(comparison.delta.esc));
    max.quotePrc = Math.max(max.quotePrc, Math.abs(comparison.delta.prc));
  }
  assert.equal(expected.size, 0);
  t.diagnostic(`Maximum absolute certificate differences: ${JSON.stringify(max)}`);
});

test('new and replacement produce decimal counts and audit metadata without money', () => {
  const input = fixture();
  const result = calculateSharedCertificates(input);
  const replacement = calculateSharedCertificates(fixture('2000', 'replacement'));
  assert.equal(result.status, 'calculated');
  assert.equal(replacement.status, 'calculated');
  assert.ok(!Number.isInteger(result.counts.esc) && !Number.isInteger(result.counts.prc));
  assert.notDeepEqual(result.counts, replacement.counts);
  assert.deepEqual(Object.keys(result).sort(), ['context', 'counts', 'eligibility', 'provenance', 'schemaVersion', 'status']);
  assert.deepEqual(Object.keys(result.counts).sort(), ['esc', 'prc']);
  assert.equal(result.provenance.rule.revision, manifest.ruleSha);
  assert.equal(result.provenance.rule.source, manifest.provenance.ruleSource);
  assert.equal(result.provenance.rule.sourcePeriod, PERIOD);
  assert.equal(result.provenance.publisherAuthenticated, false);
  assert.equal(result.provenance.validUntil, manifest.validUntil);
  assert.equal(result.provenance.gems.snapshotSha256, manifest.provenance.gemsSha256);
  assert.equal(result.context.asOf, input.asOf);
});

test('freshness is exclusive and independent for GEMS, registration and environment', () => {
  const input = fixture();
  input.asOf = new Date(Date.parse(manifest.validUntil) - 1).toISOString();
  assert.equal(calculateSharedCertificates(input).status, 'calculated');
  input.asOf = manifest.validUntil;
  rejects(input, 'expired-data', 'equipment.registration');
  for (const [field, expire] of [
    ['equipment.registration.registrationValidUntil', (x) => { x.equipment.registration.registrationValidUntil = x.asOf; }],
    ['environment', (x) => { x.environment.observedAt = x.equipment.registration.observedAt; x.environment.validUntil = x.asOf; }],
  ]) {
    const request = fixture();
    expire(request);
    rejects(request, 'expired-data', field);
  }
  const narrowed = fixture();
  narrowed.environment.validUntil = new Date(Date.parse(narrowed.asOf) + 1).toISOString();
  assert.equal(calculateSharedCertificates(narrowed).provenance.validUntil, narrowed.environment.validUntil);
  for (const mutate of [
    (x) => { x.equipment.registration.validUntil = '2026-11-14T00:00:00.000Z'; },
    (x) => { x.environment.observedAt = '2026-11-07T00:00:00.000Z'; },
    (x) => { x.environment.coverageRelease = 'unknown'; },
    (x) => { x.equipment.registration.snapshotSha256 = 'unchecked'; },
    (x) => { x.equipment.registration.resourceId = 'other'; },
  ]) {
    const request = fixture();
    mutate(request);
    rejects(request, 'invalid-provenance');
  }
});

test('rejects unsupported scope, wrong environment, malformed fields and rule overrides', () => {
  const cases = [
    ['unsupported-schema', (x) => { x.schemaVersion = 2; }],
    ['unsupported-installation', (x) => { x.installation = 'other'; }],
    ...Object.entries({ productClass: 9, phase: 'three', systemType: 'multi_split', indoorHeadCount: 2, cycle: 'cooling-only' })
      .map(([key, value]) => ['unsupported-equipment', (x) => { x.equipment[key] = value; }]),
    ['unsupported-equipment', (x) => { x.equipment.systemType = 'ducted'; }],
    ['unsupported-equipment', (x) => { x.equipment.ratings.coolingCapacityKw = 4; }],
    ['unsupported-registration', (x) => { x.equipment.registration.market = 'NZ'; }],
    ['unsupported-registration', (x) => { x.equipment.registration.status = 'cancelled'; }],
    ['unsupported-postcode', (x) => { x.environment.jurisdiction = 'QLD'; }],
    ['environment-mismatch', (x) => { x.environment.essClimateZone = 'cold'; }],
    ['environment-mismatch', (x) => { x.environment.bcaClimateZone = 6; }],
    ['invalid-input', (x) => { x.environment.postcode = 2000; }],
    ['invalid-input', (x) => { x.environment.postcode = '0000'; }],
    ['invalid-input', (x) => { x.asOf = '2026-02-30T00:00:00.000Z'; }],
    ['invalid-input', (x) => { x.asOf = '2026-11-06T11:39:10Z'; }],
    ['invalid-input', (x) => { x.equipment.model = ' '; }],
    ['invalid-input', (x) => { x.ruleRevision = manifest.ruleSha; }],
    ['invalid-input', (x) => { x.environment.networkFactor = 10; }],
    ['invalid-input', (x) => { x.equipment.indoorHeads = []; }],
    ['invalid-input', (x) => { delete x.equipment.ratings.annualEnergy.hot; }],
    ...[NaN, Infinity, 1e39, -1, '0.87', null, 0, Number.MIN_VALUE].map((value) =>
      ['invalid-rating', (x) => { x.equipment.ratings.coolingInputKw = value; }]),
    ['invalid-rating', (x) => { x.equipment.ratings.hspfMixed = -0.1; }],
    ['invalid-rating', (x) => { x.equipment.ratings.annualEnergy.mixed.coolingKwh = -1; }],
  ];
  for (const [code, mutate] of cases) {
    const input = fixture();
    mutate(input);
    rejects(input, code);
  }
  rejects(null, 'invalid-input');
  rejects([], 'invalid-input');
  rejects(Object.create(fixture()), 'invalid-input');
  const input = fixture();
  Object.defineProperty(input, 'asOf', { get: () => assert.fail('Getter called') });
  rejects(input, 'invalid-input');
  const hidden = fixture();
  Object.defineProperty(hidden, 'asOf', { enumerable: false });
  rejects(hidden, 'invalid-input');
});

test('gates cooling and climate-dependent heating, uses zero-only fallbacks, and preserves true zero', () => {
  const below = fixture();
  Object.assign(below.equipment.ratings, { tcspfMixed: 5.49999999, ratedAeer: 4.5 });
  const ineligible = calculateSharedCertificates(below);
  assert.deepEqual(ineligible.eligibility, { esc: false, prc: false });
  assert.deepEqual(ineligible.counts, { esc: 0, prc: 0 });

  const fallback = fixture();
  Object.assign(fallback.equipment.ratings, { tcspfMixed: 0, hspfMixed: 0, ratedAeer: 4.3, ratedAcop: 4.4 });
  fallback.equipment.ratings.annualEnergy.mixed = { coolingKwh: 0, heatingKwh: 0 };
  const eligible = calculateSharedCertificates(fallback);
  assert.deepEqual(eligible.eligibility, { esc: true, prc: true });
  assert.ok(eligible.counts.esc > 0 && eligible.counts.prc > 0);

  const ducted = fixture('2000', 'new', gems.models[1].model);
  Object.assign(ducted.equipment.ratings, { tcspfMixed: 0, hspfMixed: 0, ratedAeer: 3.5, ratedAcop: 3.8 });
  assert.ok(Math.fround(3.8) < 3.8, 'The official float32 input differs from the registered threshold');
  assert.deepEqual(calculateSharedCertificates(ducted).eligibility, { esc: true, prc: true });
  ducted.equipment.ratings.ratedAcop = 3.79999999;
  assert.deepEqual(calculateSharedCertificates(ducted).eligibility, { esc: false, prc: true });

  for (const postcode of ['2000', '2328']) {
    const input = fixture(postcode);
    Object.assign(input.equipment.ratings, { tcspfMixed: 5.5, hspfMixed: 4.5, hspfCold: 3.99, ratedAcop: 5 });
    const result = calculateSharedCertificates(input);
    assert.deepEqual(result.eligibility, { esc: postcode === '2000', prc: true });
    assert.equal(result.counts.esc > 0, postcode === '2000');
  }

  const zero = fixture();
  zero.equipment.ratings.coolingInputKw = Math.fround(Math.fround(zero.equipment.ratings.coolingCapacityKw) / Math.fround(3.66));
  const result = calculateSharedCertificates(zero);
  assert.equal(result.eligibility.prc, true);
  assert.equal(result.counts.prc, 0);
});

test('eligible negative raw savings are unsupported, not clamped or sent to shadow consumers', () => {
  const esc = fixture();
  esc.equipment.ratings.annualEnergy.mixed.heatingKwh = 100_000;
  rejects(esc, 'negative-savings', 'esc');
  const prc = fixture();
  prc.equipment.ratings.coolingInputKw = 1.5;
  rejects(prc, 'negative-savings', 'prc');
  assert.equal(compareCertificateShadow(prc, { esc: 0, prc: 0 }).code, 'negative-savings');
});

test('deterministic and mutation-isolated; shadow only reports, never alters the authoritative counts', () => {
  function freeze(value) {
    Object.values(value).filter((item) => item && typeof item === 'object').forEach(freeze);
    return Object.freeze(value);
  }
  const input = freeze(fixture());
  const first = calculateSharedCertificates(input);
  assert.equal(first.status, 'calculated');
  const authoritative = Object.freeze({ ...first.counts });
  const shadow = compareCertificateShadow(input, authoritative);
  assert.equal(shadow.status, 'match');
  assert.deepEqual(shadow.delta, { esc: 0, prc: 0 });
  shadow.candidate.counts.esc = 0;
  shadow.candidate.provenance.gems.number = 'not the original';
  assert.deepEqual(calculateSharedCertificates(input), first);
  assert.deepEqual(authoritative, first.counts);
  assert.deepEqual(input, fixture());
  assert.equal(compareCertificateShadow(input, { ...authoritative, esc: authoritative.esc + 0.00019 }).status, 'match');
  const mismatch = compareCertificateShadow(input, { ...authoritative, prc: authoritative.prc + 0.00021 });
  assert.equal(mismatch.status, 'mismatch');
  assert.ok(mismatch.delta.prc < 0 && mismatch.delta.esc === 0);
});

test('shadow contains hostile values and internal calculation errors without exposing them', () => {
  const error = new Proxy({}, { getPrototypeOf: () => { throw new Error('Do not inspect exception'); } });
  const hostile = new Proxy({}, { ownKeys: () => { throw error; } });
  const noLeak = { status: 'unsupported', code: 'calculation-error' };
  assert.deepEqual(compareCertificateShadow(hostile, { esc: 0, prc: 0 }), noLeak);
  assert.deepEqual(compareCertificateShadow(fixture(), hostile), noLeak);
  for (const bad of [null, { esc: -1, prc: 0 }, { esc: NaN, prc: 0 }, { esc: 0, prc: '0' }, { esc: 0, prc: 0, rebate: 0 }]) {
    assert.equal(compareCertificateShadow(fixture(), bad).code, 'invalid-authoritative');
  }
  const overflow = fixture();
  overflow.equipment.ratings.heatingCapacityKw = 1e38;
  overflow.equipment.ratings.annualEnergy.mixed.heatingKwh = 0;
  assert.deepEqual(compareCertificateShadow(overflow, { esc: 0, prc: 0 }), noLeak);
  assert.equal(blockedAttempts, 0, 'An engine I/O attempt was blocked');
});
