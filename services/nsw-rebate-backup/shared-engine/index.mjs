// SPDX-License-Identifier: AGPL-3.0-only
// Standalone AGPL service only. See ../LICENSE and ./README.md.
import { calculateNswFallback } from '../engine/nsw-calculation-fallback.mjs';
import parameterSnapshot from '../engine/nsw-calculation-fallback-data.mjs';
import { coverageRelease, coversPostcode } from './coverage.mjs';

const RULE = Object.freeze({
  scheme: 'NSW-residential-HVAC1_PDRSAug24',
  revision: 'ae8d778f18e0612bd38c69a2527ff9d7e12d3747',
  source: 'https://github.com/energy-savings-scheme/openfisca_nsw_safeguard',
  sourcePeriod: '2021-01-01',
});
const GEMS_RESOURCE_ID = 'd4e17a35-9002-4a0c-ac1c-003ece0de135';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TOLERANCE = 0.0002;
const PREFIX = 'HVAC1_PDRSAug24_';
const { coolingBenchmark, heatingBenchmark } = parameterSnapshot();

class Rejection {
  #rejection = true;

  constructor(code, field) {
    this.result = { status: 'unsupported', code, field };
  }

  static is(error) {
    return typeof error === 'object' && error !== null && #rejection in error;
  }
}

function reject(code, field) {
  throw new Rejection(code, field);
}

// Read only plain data properties and copy the accepted fields. No getters,
// coercion, implicit defaults or caller-supplied calculation overrides.
function record(value, keys, field, code = 'invalid-input') {
  if (typeof value !== 'object' || value === null || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    reject(code, field);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length) reject(code, field);
  const copy = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!ownKeys.includes(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) reject(code, field);
    copy[key] = descriptor.value;
  }
  return copy;
}

function instant(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    reject('invalid-input', field);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) reject('invalid-input', field);
  return ms;
}

function freshness(source, asOf, field) {
  const observed = instant(source.observedAt, `${field}.observedAt`);
  const validUntil = instant(source.validUntil, `${field}.validUntil`);
  if (observed > asOf || validUntil <= observed || validUntil - observed > MAX_AGE_MS) reject('invalid-provenance', field);
  if (asOf >= validUntil) reject('expired-data', field);
  return validUntil;
}

function identifier(value, field) {
  if (typeof value !== 'string' || !value || value.length > 160 || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    reject('invalid-input', field);
  }
}

function rating(value, field, allowZero) {
  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(Math.fround(value))
    || (Math.fround(value) === 0 && (!allowZero || value !== 0))) reject('invalid-rating', field);
}

function engineFields(inputs, outputs) {
  const building = Object.fromEntries([
    ...Object.entries(inputs), ...outputs.map((name) => [name, null]),
  ].map(([name, value]) => [PREFIX + name, { [RULE.sourcePeriod]: value }]));
  const result = calculateNswFallback({ buildings: { building_1: building }, persons: { person1: {} } }).buildings.building_1;
  return Object.fromEntries(outputs.map((name) => [name, result[PREFIX + name][RULE.sourcePeriod]]));
}

function evaluate(input) {
  const request = record(input, ['schemaVersion', 'asOf', 'installation', 'equipment', 'environment'], 'input');
  if (request.schemaVersion !== 1) reject('unsupported-schema', 'schemaVersion');
  if (request.installation !== 'new' && request.installation !== 'replacement') reject('unsupported-installation', 'installation');
  const asOf = instant(request.asOf, 'asOf');

  const equipment = record(request.equipment, [
    'brand', 'model', 'productClass', 'systemType', 'phase', 'cycle', 'indoorHeadCount', 'registration', 'ratings',
  ], 'equipment');
  const { productClass, systemType } = equipment;
  if (equipment.phase !== 'single' || equipment.cycle !== 'reverse-cycle' || equipment.indoorHeadCount !== 1
    || !((productClass === 8 && systemType === 'split') || (productClass === 10 && systemType === 'ducted'))) {
    reject('unsupported-equipment', 'equipment');
  }
  identifier(equipment.brand, 'equipment.brand');
  identifier(equipment.model, 'equipment.model');
  const registration = record(equipment.registration, [
    'number', 'market', 'status', 'resourceId', 'snapshotSha256', 'observedAt', 'validUntil', 'registrationValidUntil',
  ], 'equipment.registration');
  identifier(registration.number, 'equipment.registration.number');
  if (registration.market !== 'AU' || registration.status !== 'active') reject('unsupported-registration', 'equipment.registration');
  if (registration.resourceId !== GEMS_RESOURCE_ID || typeof registration.snapshotSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(registration.snapshotSha256)) reject('invalid-provenance', 'equipment.registration');
  const gemsValidUntil = freshness(registration, asOf, 'equipment.registration');
  const registrationValidUntil = instant(registration.registrationValidUntil, 'equipment.registration.registrationValidUntil');
  if (asOf >= registrationValidUntil) reject('expired-data', 'equipment.registration.registrationValidUntil');

  const environment = record(request.environment, [
    'jurisdiction', 'postcode', 'essClimateZone', 'bcaClimateZone', 'coverageRelease', 'observedAt', 'validUntil',
  ], 'environment');
  const { postcode, essClimateZone, bcaClimateZone } = environment;
  if (typeof postcode !== 'string' || !/^[0-9]{4}$/.test(postcode) || postcode === '0000') reject('invalid-input', 'environment.postcode');
  if (environment.jurisdiction !== 'NSW' || !coversPostcode(postcode)) reject('unsupported-postcode', 'environment.postcode');
  if (environment.coverageRelease !== coverageRelease) reject('invalid-provenance', 'environment.coverageRelease');
  if (!['hot', 'mixed', 'cold'].includes(essClimateZone) || !Number.isInteger(bcaClimateZone) || bcaClimateZone < 1 || bcaClimateZone > 8) {
    reject('invalid-input', 'environment');
  }
  const envValidUntil = freshness(environment, asOf, 'environment');

  const physical = ['coolingCapacityKw', 'heatingCapacityKw', 'coolingInputKw', 'ratedAeer', 'ratedAcop'];
  const seasonal = ['tcspfMixed', 'hspfMixed', 'hspfCold'];
  const ratings = record(equipment.ratings, [...physical, ...seasonal, 'annualEnergy'], 'equipment.ratings');
  for (const key of physical) rating(ratings[key], `equipment.ratings.${key}`, false);
  for (const key of seasonal) rating(ratings[key], `equipment.ratings.${key}`, true);
  if (ratings.coolingCapacityKw >= (productClass === 8 ? 4 : 10)) reject('unsupported-equipment', 'equipment.ratings.coolingCapacityKw');
  const annual = record(ratings.annualEnergy, ['hot', 'mixed', 'cold'], 'equipment.ratings.annualEnergy');
  for (const zone of ['hot', 'mixed', 'cold']) {
    const field = `equipment.ratings.annualEnergy.${zone}`;
    annual[zone] = record(annual[zone], ['coolingKwh', 'heatingKwh'], field);
    rating(annual[zone].coolingKwh, `${field}.coolingKwh`, true);
    rating(annual[zone].heatingKwh, `${field}.heatingKwh`, true);
  }

  const lookup = engineFields({ PDRS__postcode: postcode }, [
    'get_climate_zone_by_postcode', 'BCA_climate_zone_by_postcode', 'PDRS__regional_network_factor', 'get_network_loss_factor_by_postcode',
  ]);
  if (lookup.get_climate_zone_by_postcode !== essClimateZone || lookup.BCA_climate_zone_by_postcode !== String(bcaClimateZone)) {
    reject('environment-mismatch', 'environment');
  }

  // Match the quote path's comparisons on registered decimals (not float32).
  const key = `product_class_${productClass}`;
  const prc = ratings.tcspfMixed > 0
    ? ratings.tcspfMixed >= coolingBenchmark.TCSPF_mixed[key]
    : ratings.ratedAeer >= coolingBenchmark.AEER[key];
  const hspf = essClimateZone === 'cold' ? 'HSPF_cold' : 'HSPF_mixed';
  const heatRating = essClimateZone === 'cold' ? ratings.hspfCold : ratings.hspfMixed;
  const esc = prc && (heatRating > 0 ? heatRating >= heatingBenchmark[hspf][key] : ratings.ratedAcop >= heatingBenchmark.ACOP[key]);
  const counts = { esc: 0, prc: 0 };
  if (esc || prc) {
    const savings = engineFields({
      PDRS__postcode: postcode,
      Activity: request.installation === 'new' ? 'new_installation_activity' : 'replacement_activity',
      Air_Conditioner_type: systemType === 'ducted' ? 'ducted_single_split_system' : 'non_ducted_single_split_system',
      product_class_input: `Class ${productClass}`,
      HSPF_cold: ratings.hspfCold,
      HSPF_mixed: ratings.hspfMixed,
      TCSPF_mixed: ratings.tcspfMixed,
      cooling_capacity_input: ratings.coolingCapacityKw,
      heating_capacity_input: ratings.heatingCapacityKw,
      rated_ACOP_input: ratings.ratedAcop,
      rated_AEER_input: ratings.ratedAeer,
      residential_TCEC: annual[essClimateZone].coolingKwh,
      residential_THEC: annual[essClimateZone].heatingKwh,
      input_power: ratings.coolingInputKw,
      BCA_Climate_Zone: `BCA_Climate_Zone_${bcaClimateZone}`,
    }, ['electricity_savings', 'peak_demand_reduction_capacity']);
    // Quote decimals use the raw outputs, never the floored official counts.
    if (esc) counts.esc = savings.electricity_savings * lookup.PDRS__regional_network_factor * 1.06;
    if (prc) counts.prc = savings.peak_demand_reduction_capacity * lookup.get_network_loss_factor_by_postcode * 10;
    for (const scheme of ['esc', 'prc']) {
      if (!Number.isFinite(counts[scheme])) reject('calculation-error', scheme);
      if (counts[scheme] < 0) reject('negative-savings', scheme);
    }
  }

  return {
    status: 'calculated',
    schemaVersion: 1,
    counts,
    eligibility: { esc, prc },
    context: {
      asOf: request.asOf, installation: request.installation, brand: equipment.brand, model: equipment.model,
      productClass, systemType, postcode, essClimateZone, bcaClimateZone,
    },
    provenance: {
      rule: RULE,
      gems: { ...registration },
      environment: { coverageRelease, observedAt: environment.observedAt, validUntil: environment.validUntil },
      validUntil: new Date(Math.min(gemsValidUntil, registrationValidUntil, envValidUntil)).toISOString(),
      publisherAuthenticated: false,
    },
  };
}

export function calculateSharedCertificates(input) {
  try {
    return evaluate(input);
  } catch (error) {
    return Rejection.is(error) ? error.result : { status: 'unsupported', code: 'calculation-error' };
  }
}

export function compareCertificateShadow(input, authoritative) {
  try {
    const baseline = record(authoritative, ['esc', 'prc'], 'authoritative', 'invalid-authoritative');
    if (![baseline.esc, baseline.prc].every((value) => Number.isFinite(value) && value >= 0)) {
      return { status: 'unsupported', code: 'invalid-authoritative', field: 'authoritative' };
    }
    const candidate = calculateSharedCertificates(input);
    if (candidate.status !== 'calculated') return candidate;
    const delta = { esc: candidate.counts.esc - baseline.esc, prc: candidate.counts.prc - baseline.prc };
    return {
      status: Math.abs(delta.esc) <= TOLERANCE && Math.abs(delta.prc) <= TOLERANCE ? 'match' : 'mismatch',
      tolerance: TOLERANCE, candidate, delta,
    };
  } catch (error) {
    return Rejection.is(error) ? error.result : { status: 'unsupported', code: 'calculation-error' };
  }
}
