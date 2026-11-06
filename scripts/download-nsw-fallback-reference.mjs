import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = 'energy-savings-scheme/openfisca_nsw_safeguard';
const sha = 'ae8d778f18e0612bd38c69a2527ff9d7e12d3747';
const root = fileURLToPath(new URL('../outputs/nsw-offline-reference/', import.meta.url));
const model = 'openfisca_nsw_safeguard/';
const hvac = 'ESS_PDRS_Estimator/HVAC1_PDRSAug24/';
const args = process.argv.slice(2);
const required = new Set([
  'entities.py', 'base_variables.py',
  'parameters/ESS/HEER/table_D16_1.yaml',
  'parameters/ESS/HEER/table_D16_2_product_class.yaml',
  'parameters/ESS/HEER/table_D16_4_product_class.yaml',
  'parameters/ESS/ESS_D16/related_constants.yaml',
  'parameters/ESS/ESS_general/table_A27_4_climate_zone_by_postcode.yaml',
  'parameters/ESS/ESS_general/table_A26_May25_BCA_climate_zone_by_postcode.yaml',
  'parameters/PDRS/AC/table_HVAC_1_2_product_class.yaml',
  'parameters/PDRS/AC/AC_related_constants.yaml',
  'parameters/PDRS/table_A28_temperature_factor.yaml',
  'parameters/PDRS/table_A24_regional_network_factor.yaml',
  'parameters/PDRS/table_network_loss_factor_by_postcode.yaml',
].map((path) => model + path));

async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return response;
}

const tree = await (await get(`https://api.github.com/repos/${repo}/git/trees/${sha}?recursive=1`)).json();
if (tree.truncated || tree.sha !== sha) throw new Error('Unexpected GitHub tree');
const blobs = tree.tree.filter((entry) => entry.type === 'blob');
if (args[0] === '--list-parameters') {
  for (const { path } of blobs) if (path.startsWith(`${model}parameters/`)) console.log(path);
} else {
  const paths = new Set(args);
  for (const path of paths) {
    if (!blobs.some((entry) => entry.path === path)) throw new Error(`Not a pinned blob: ${path}`);
  }
  const selected = blobs.filter(({ path }) => paths.has(path) || (!args.length && (
    path === 'LICENSE' || path === 'setup.py' || path === 'README.md'
      || required.has(path) || path.startsWith(`${model}variables/${hvac}`) || path.startsWith(`${model}tests/${hvac}`)
  )));
  for (const { path, sha: blob } of selected) {
    const bytes = Buffer.from(await (await get(`https://raw.githubusercontent.com/${repo}/${sha}/${path}`)).arrayBuffer());
    const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (actual !== blob) throw new Error(`Git blob digest mismatch: ${path}`);
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    console.log(`${blob} ${path}`);
  }
}
