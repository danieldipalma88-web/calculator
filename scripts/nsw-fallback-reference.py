"""Offline data generator and oracle for the pinned, unmodified NSW model subset."""

import argparse
import json
from pathlib import Path
import sys
from types import ModuleType

import yaml
from openfisca_core.parameters import ParameterNodeAtInstant
from openfisca_core.taxbenefitsystems import TaxBenefitSystem
from openfisca_core.taxscales import SingleAmountTaxScale
from openfisca_web_api.handlers import calculate


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'outputs' / 'nsw-offline-reference' / 'openfisca_nsw_safeguard'
HVAC = 'ESS_PDRS_Estimator/HVAC1_PDRSAug24'
DATE = '2021-01-01'
SHA = 'ae8d778f18e0612bd38c69a2527ff9d7e12d3747'


def make_system():
    package = ModuleType(SOURCE.name)
    package.__path__ = [str(SOURCE)]
    sys.modules[SOURCE.name] = package
    from openfisca_nsw_safeguard.entities import Building, Person

    system = TaxBenefitSystem([Building, Person])
    system.load_parameters(SOURCE / 'parameters')
    system.add_variables_from_directory(SOURCE / 'variables' / HVAC / 'certificate_estimation')
    return system


def snapshot(parameters):
    def unpack(value):
        if isinstance(value, ParameterNodeAtInstant):
            return {name: unpack(value[name]) for name in sorted(value)}
        if isinstance(value, SingleAmountTaxScale):
            return list(zip(value.thresholds, value.amounts, strict=True))
        if type(value) not in (int, float):
            raise ValueError(f'Unexpected parameter value: {value!r}')
        return value

    return {
        'hours': unpack(parameters.ESS.HEER.table_D16_1),
        'baseline': unpack(parameters.ESS.HEER.table_D16_2_product_class),
        'heatingBenchmark': unpack(parameters.ESS.HEER.table_D16_4_product_class),
        'coolingBenchmark': unpack(parameters.PDRS.AC.table_HVAC_1_2_product_class),
        'essLifetime': parameters.ESS.ESS_D16.related_constants.lifetime,
        'pdrsLifetime': parameters.PDRS.AC.AC_related_constants.lifetime,
        'temperature': unpack(parameters.PDRS.table_A28_temperature_factor.temperature_factor),
        'climate': unpack(parameters.ESS.ESS_general.table_A27_4_climate_zone_by_postcode),
        'bca': unpack(parameters.ESS.ESS_general.table_A26_May25_BCA_climate_zone_by_postcode),
        'regional': unpack(parameters.PDRS.table_A24_regional_network_factor),
        'network': unpack(parameters.PDRS.table_network_loss_factor_by_postcode),
    }


def make_data(system):
    data = snapshot(system.get_parameters_at_instant(DATE))
    for year in (2022, 2024, 2025):
        if snapshot(system.get_parameters_at_instant(f'{year}-01-01')) != data:
            raise ValueError(f'Official fixture parameter data differs in {year}')
    lines = [
        '// SPDX-License-Identifier: AGPL-3.0-only',
        '// NSW Government (upstream); generated parameter snapshot for this AGPL service.',
        f'// OpenFisca NSW Safeguard {SHA}; instant {DATE}.',
        '// See ../README.md and ../LICENSE.',
        'export default function parameterSnapshot() {',
        '  return {',
    ]
    for key, value in data.items():
        encoded = json.dumps(value, allow_nan=False, separators=(',', ':'))
        if isinstance(value, list):
            encoded = '[\n' + '\n'.join(f'      {json.dumps(row)},' for row in value) + '\n    ]'
        lines.append(f'    {key}: {encoded},')
    return '\n'.join([*lines, '  };', '}', ''])


def read_cases():
    return [
        {'file': path.name, 'index': index, **case}
        for path in sorted((SOURCE / 'tests' / HVAC).glob('*_calculation.yaml'))
        for index, case in enumerate(yaml.safe_load(path.read_bytes()), start=1)
    ]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('data', 'cases', 'oracle'))
    parser.add_argument('--write', action='store_true', help='Write the generated JS data module')
    args = parser.parse_args()
    if args.write and args.action != 'data':
        parser.error('--write requires data')

    if args.action == 'cases':
        print(json.dumps(read_cases(), allow_nan=False))
        return
    system = make_system()
    if args.action == 'data':
        content = make_data(system)
        if args.write:
            target = ROOT / 'services' / 'nsw-rebate-backup' / 'engine' / 'nsw-calculation-fallback-data.mjs'
            target.write_bytes(content.encode('ascii'))
        else:
            sys.stdout.write(content)
    else:
        results = []
        for payload in json.load(sys.stdin):
            try:
                results.append({'response': calculate(system, payload)})
            except (ValueError, TypeError, KeyError) as error:
                results.append({'error': f'{type(error).__name__}: {error}'})
        print(json.dumps(results, allow_nan=False))


if __name__ == '__main__':
    main()
