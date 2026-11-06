// SPDX-License-Identifier: AGPL-3.0-only
// Local port of NSW Government OpenFisca HVAC1_PDRSAug24, ae8d778f18e0612bd38c69a2527ff9d7e12d3747.
// Standalone AGPL service only. See ../LICENSE and ../README.md.
import parameterSnapshot from './nsw-calculation-fallback-data.mjs';

const data = parameterSnapshot();
const f32 = Math.fround;
const climate = [undefined, 'hot', 'mixed', 'cold'];
const climateKey = [undefined, 'hot_zone', 'average_zone', 'cold_zone'];

function number(value, label) {
  if (!Number.isFinite(value)) throw new RangeError(`Invalid NSW calculation value: ${label}`);
  return value;
}

function positive(value, label) {
  if (!(number(value, label) > 0)) throw new RangeError(`Nonpositive NSW lookup: ${label}`);
  return value;
}

function bracket(rows, postcode) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (rows[mid][0] <= postcode) low = mid + 1;
    else high = mid;
  }
  return low === 0 ? 0 : rows[low - 1][1];
}

export function requireNswPostcode(postcode) {
  positive(bracket(data.network, postcode), `network factor for ${postcode}`);
  positive(bracket(data.regional, postcode), `regional factor for ${postcode}`);
}

function zoneKey(zone) {
  if (!climateKey[zone]) {
    const error = new RangeError(`Unsupported NSW ESS climate code: ${zone}`);
    error.code = 'NSW_UNSUPPORTED_ESS_CLIMATE';
    throw error;
  }
  return climateKey[zone];
}

function annualUse(capacity, hours, efficiency) {
  return efficiency === 0 ? 0 : f32(f32(capacity * hours) / efficiency);
}

function peakPower(cooling, baseline) {
  return baseline === 0 ? 0 : f32(cooling / baseline);
}

function temperature(zone) {
  return number(data.temperature[zone], `temperature factor for ${zone}`);
}

function nonnegative(value) {
  return Math.max(0, value);
}

const rules = {
  certificate_climate_zone: (get) => bracket(data.climate, get('PDRS__postcode')),
  get_climate_zone_by_postcode: (get) => climate[get('certificate_climate_zone')] ?? '0',
  BCA_climate_zone_by_postcode: (get) => String(bracket(data.bca, get('PDRS__postcode'))),
  PDRS__regional_network_factor: (get) => bracket(data.regional, get('PDRS__postcode')),
  get_network_loss_factor_by_postcode: (get) => bracket(data.network, get('PDRS__postcode')),
  product_class_int: (get) => Number(get('product_class_input').slice(6)),
  product_class_is_18_to_21: (get) => get('product_class_int') >= 18 && get('product_class_int') <= 21,
  baseline_AEER_input: (get) => baseline(get, 'AEER'),
  baseline_ACOP_input: (get) => baseline(get, 'ACOP'),
  equivalent_heating_hours_input: (get) => hours(get, 'heating'),
  equivalent_cooling_hours_input: (get) => hours(get, 'cooling'),
  heating_annual_energy_use: (get) => annualUse(get('heating_capacity_input'), get('equivalent_heating_hours_input'), get('rated_ACOP_input')),
  cooling_annual_energy_use: (get) => annualUse(get('cooling_capacity_input'), get('equivalent_cooling_hours_input'), get('rated_AEER_input')),
  reference_heating_annual_energy_use: (get) => annualUse(get('heating_capacity_input'), get('equivalent_heating_hours_input'), get('baseline_ACOP_input')),
  reference_cooling_annual_energy_use: (get) => annualUse(get('cooling_capacity_input'), get('equivalent_cooling_hours_input'), get('baseline_AEER_input')),
  THEC_or_annual_heating: (get) => get('residential_THEC') > 0 ? get('residential_THEC') : get('heating_annual_energy_use'),
  TCEC_or_annual_cooling: (get) => get('residential_TCEC') > 0 ? get('residential_TCEC') : get('cooling_annual_energy_use'),
  deemed_activity_electricity_savings(get) {
    const cooling = f32(get('reference_cooling_annual_energy_use') - get('TCEC_or_annual_cooling'));
    const heating = f32(get('reference_heating_annual_energy_use') - get('THEC_or_annual_heating'));
    return f32(cooling + heating) * f32(positive(data.essLifetime, 'ESS lifetime') / 1000);
  },
  electricity_savings: (get) => get('deemed_activity_electricity_savings'),
  annual_energy_savings: (get) => nonnegative(get('deemed_activity_electricity_savings')),
  TCSPF_or_AEER_exceeds_ESS_benchmark(get) {
    const tcspf = get('TCSPF_mixed');
    return tcspf === 0
      ? get('rated_AEER_input') >= benchmark(data.coolingBenchmark, 'AEER', get)
      : tcspf >= benchmark(data.coolingBenchmark, 'TCSPF_mixed', get);
  },
  HSPF_or_ACOP_exceeds_ESS_benchmark(get) {
    const metric = get('certificate_climate_zone') === 3 ? 'HSPF_cold' : 'HSPF_mixed';
    const hspf = get(metric);
    return hspf === 0
      ? get('rated_ACOP_input') >= benchmark(data.heatingBenchmark, 'ACOP', get)
      : hspf >= benchmark(data.heatingBenchmark, metric, get);
  },
  ESC_calculation(get) {
    const savings = get('electricity_savings');
    const regional = get('PDRS__regional_network_factor');
    const cool = get('TCSPF_or_AEER_exceeds_ESS_benchmark');
    const heat = get('HSPF_or_ACOP_exceeds_ESS_benchmark');
    // The uncovered zero-heating combination uses upstream's np.select default.
    const eligible = heat && (get('heating_capacity_input') === 0 ? !cool : cool);
    const result = eligible ? nonnegative(Math.floor(f32(f32(savings * regional) * f32(1.06)))) : 0;
    return get('product_class_is_18_to_21')
      ? Math.min(result, get('certificate_climate_zone') === 3 ? 90 : 70)
      : result;
  },
  baseline_input_power: (get) => peakPower(get('cooling_capacity_input'), get('baseline_AEER_input')),
  baseline_peak_adjustment_factor: (get) => 0.72 * temperature(get('BCA_Climate_Zone')),
  peak_demand_savings_activity(get) {
    const adjustment = get('baseline_peak_adjustment_factor');
    return f32(get('baseline_input_power') * adjustment) - f32(get('input_power') * adjustment);
  },
  peak_demand_reduction_capacity: (get) => f32(get('peak_demand_savings_activity') * 6) * positive(data.pdrsLifetime, 'PDRS lifetime'),
  peak_demand_annual_savings(get) {
    // This upstream formula is inlined: its vector temperature factor stays float64.
    const adjustment = 0.72 * temperature(get('BCA_Climate_Zone'));
    const baseline = peakPower(get('cooling_capacity_input'), get('baseline_AEER_input'));
    const activity = baseline * adjustment - get('input_power') * adjustment;
    return nonnegative(activity * 6 * positive(data.pdrsLifetime, 'PDRS lifetime'));
  },
  PRC_calculation(get) {
    const capacity = get('peak_demand_reduction_capacity');
    const loss = get('get_network_loss_factor_by_postcode');
    const result = get('TCSPF_or_AEER_exceeds_ESS_benchmark')
      ? nonnegative(Math.floor(f32(f32(capacity * loss) * 10))) : 0;
    return get('product_class_is_18_to_21') ? Math.min(result, 500) : result;
  },
  PRC_savings_check: (get) => get('PRC_calculation') > 0 ? get('peak_demand_annual_savings') : 0,
};

function classKey(get) {
  return `product_class_${get('product_class_int')}`;
}

function baseline(get, metric) {
  return positive(data.baseline[metric][get('Activity')]?.[classKey(get)], `baseline ${metric}`);
}

function hours(get, mode) {
  const zone = zoneKey(get('certificate_climate_zone'));
  return positive(data.hours[`equivalent_${mode}_hours`][zone], `${mode} hours for ${zone}`);
}

function benchmark(table, metric, get) {
  // Fancy-indexed parameter values are float64; inputs are float32.
  return positive(table[metric][classKey(get)], `benchmark ${metric}`);
}

const integerFields = new Set(['PDRS__postcode', 'certificate_climate_zone', 'product_class_int']);

// Internal only. Overrides let the verifier replay official unit tests; the
// public payload adapter never permits overrides of calculated variables.
export function evaluateNswModel(inputs) {
  const cache = new Map();
  function get(field) {
    if (cache.has(field)) return cache.get(field);
    let value;
    if (Object.hasOwn(inputs, field)) value = inputs[field];
    else if (Object.hasOwn(rules, field)) value = rules[field](get);
    else throw new RangeError(`Missing NSW calculation input: ${field}`);
    if (typeof value === 'number') value = number(integerFields.has(field) ? value : f32(value), field);
    cache.set(field, value);
    return value;
  }
  return get;
}
