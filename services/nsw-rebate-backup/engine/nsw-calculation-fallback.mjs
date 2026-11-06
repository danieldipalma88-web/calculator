// SPDX-License-Identifier: AGPL-3.0-only
// Local port of NSW Government OpenFisca HVAC1_PDRSAug24, ae8d778f18e0612bd38c69a2527ff9d7e12d3747.
// Standalone AGPL service only. See ../LICENSE and ../README.md.
import { evaluateNswModel, requireNswPostcode } from './nsw-calculation-fallback-model.mjs';

const DATE = '2021-01-01';
const PREFIX = 'HVAC1_PDRSAug24_';
const POSTCODE = 'PDRS__postcode';
const activities = new Set(['new_installation_activity', 'replacement_activity']);
const types = new Set(['non_ducted_single_split_system', 'ducted_single_split_system', 'non_ducted_multi_split_system']);
const classes = new Set([5, 6, 7, 8, 9, 10, 11, 12, 18, 19, 20, 21].map((id) => `Class ${id}`));
const floatInputs = new Set([
  'HSPF_cold', 'HSPF_mixed', 'TCSPF_mixed', 'cooling_capacity_input', 'heating_capacity_input',
  'rated_ACOP_input', 'rated_AEER_input', 'residential_TCEC', 'residential_THEC', 'input_power',
]);
const enumInputs = new Map([
  ['Activity', (value) => activities.has(value)],
  ['Air_Conditioner_type', (value) => types.has(value)],
  ['product_class_input', (value) => classes.has(value)],
  ['BCA_Climate_Zone', (value) => typeof value === 'string' && /^BCA_Climate_Zone_[1-8]$/.test(value)],
]);
const lookupOutputs = new Set([
  'get_climate_zone_by_postcode', 'BCA_climate_zone_by_postcode',
  'PDRS__regional_network_factor', 'get_network_loss_factor_by_postcode',
]);
const certificateOutputs = new Set([
  'electricity_savings', 'peak_demand_reduction_capacity', 'ESC_calculation',
  'PRC_calculation', 'annual_energy_savings', 'peak_demand_annual_savings',
]);

function recordKeys(value, label) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`Expected NSW payload object: ${label}`);
  }
  return Reflect.ownKeys(value).map((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !property.enumerable || !Object.hasOwn(property, 'value')) {
      throw new TypeError(`Expected JSON properties: ${label}`);
    }
    return key;
  });
}

function requireKeys(value, expected, label) {
  const keys = recordKeys(value, label);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    throw new RangeError(`Unsupported NSW payload fields: ${label}`);
  }
}

function parseInput(field, value) {
  if (field === POSTCODE) {
    if ((typeof value === 'string' && /^\d{4}$/.test(value) && value !== '0000')
      || (Number.isInteger(value) && value >= 1000 && value <= 9999)) return Number(value);
  } else if (floatInputs.has(field)) {
    const mayUseAnnualFormula = field === 'residential_TCEC' || field === 'residential_THEC';
    if (Number.isFinite(value) && Number.isFinite(Math.fround(value)) && (value >= 0 || mayUseAnnualFormula)) {
      return value;
    }
  } else if (enumInputs.get(field)?.(value)) {
    return value;
  }
  throw new RangeError(`Invalid NSW calculation input: ${field}`);
}

// Core's web API emits the shortest decimal that round-trips to the float32.
export function toOpenFiscaDecimal(value) {
  if (value === 0) return 0;
  const sign = Math.sign(value);
  const [coefficient, exponent] = Math.abs(value).toExponential(40).split('e');
  const digits = coefficient.replace('.', '');
  for (let precision = 1; precision <= 9; precision++) {
    const lower = Number(digits.slice(0, precision));
    const tail = digits.slice(precision);
    const halfway = `5${'0'.repeat(tail.length - 1)}`;
    const increment = Number(tail > halfway || (tail === halfway && lower % 2 === 1));
    // Check both neighbors: a power of two can have asymmetric float32 spacing.
    for (const significand of [lower + increment, lower + 1 - increment]) {
      const decimal = sign * Number(`${significand}e${Number(exponent) - precision + 1}`);
      if (Math.fround(decimal) === value) return decimal;
    }
  }
  throw new RangeError('Invalid NSW float32 output');
}

/** Evaluate the supported, single-building OpenFisca payload; throw on unsupported input. */
export function calculateNswFallback(payload) {
  requireKeys(payload, ['buildings', 'persons'], 'root');
  requireKeys(payload.buildings, ['building_1'], 'buildings');
  requireKeys(payload.persons, ['person1'], 'persons');
  requireKeys(payload.persons.person1, [], 'person1');
  const request = payload.buildings.building_1;
  const building = {};
  const inputs = Object.create(null);
  const outputs = [];

  for (const name of recordKeys(request, 'building_1')) {
    if (!name.startsWith(PREFIX)) throw new RangeError(`Unsupported NSW variable: ${name}`);
    const field = name.slice(PREFIX.length);
    requireKeys(request[name], [DATE], `${name} (only ${DATE} is supported)`);
    const value = request[name][DATE];
    if (lookupOutputs.has(field) || certificateOutputs.has(field)) {
      if (value !== null) throw new RangeError(`Cannot override NSW calculation output: ${name}`);
      outputs.push(field);
    } else {
      inputs[field] = parseInput(field, value);
    }
    building[name] = { [DATE]: value };
  }

  if (!outputs.length || !Object.hasOwn(inputs, POSTCODE)) throw new RangeError('Missing NSW postcode or outputs');
  const hasEquipment = Object.keys(inputs).length > 1 || outputs.some((field) => certificateOutputs.has(field));
  if (hasEquipment) {
    for (const field of [...floatInputs, ...enumInputs.keys()]) {
      if (!Object.hasOwn(inputs, field)) throw new RangeError(`Missing NSW calculation input: ${field}`);
    }
  }

  requireNswPostcode(inputs[POSTCODE]);
  const get = evaluateNswModel(inputs);
  for (const field of outputs) {
    const value = get(field);
    // Keep the official ESS lookup sentinel; it is not a usable certificate zone.
    if (field === 'BCA_climate_zone_by_postcode' && !/^[1-8]$/.test(value)) {
      throw new RangeError(`Unsupported NSW climate lookup: ${field} for ${inputs[POSTCODE]}`);
    }
    building[PREFIX + field][DATE] = typeof value === 'number' ? toOpenFiscaDecimal(value) : value;
  }
  return { buildings: { building_1: building }, persons: { person1: {} } };
}
