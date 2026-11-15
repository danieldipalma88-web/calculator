import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const worker = 'lib/model-research/manufacturer-pdf-worker.mjs';
const pdfWorker = 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs';
for (const route of ['model-requests', 'model-requests/respond', 'admin/model-requests', 'cron/model-requests', 'internal/model-research']) {
  const trace = join(root, '.next/server/app/api', route, 'route.js.nft.json');
  const files = JSON.parse(readFileSync(trace, 'utf8')).files.map(file => resolve(dirname(trace), file));
  for (const required of [worker, 'lib/model-research/manufacturer-table.mjs', pdfWorker]) {
    const target = realpathSync(join(root, required));
    assert.ok(files.some(file => {
      if (!existsSync(file)) return false;
      const actual = realpathSync(file);
      return actual === target || (statSync(file).isDirectory() && target.startsWith(actual + sep));
    }), `${route} deployment trace omits ${required}`);
  }
}
// The smoke test lives outside the checkout and has no ancestor node_modules or
// NODE_PATH fallback. It runs the actual parser worker with only packaged files.
const destination = mkdtempSync(join(tmpdir(), 'calculator-manufacturer-package-'));
try {
  for (const file of ['manufacturer.mjs', 'manufacturer-table.mjs', 'manufacturer-pdf-worker.mjs', 'registry.mjs', 'config.mjs']) {
    cpSync(join(root, 'lib/model-research', file), join(destination, 'lib/model-research', file));
  }
  cpSync(join(root, 'scripts/verify-manufacturer-mapping.mjs'), join(destination, 'scripts/verify-manufacturer-mapping.mjs'));
  cpSync(join(root, 'node_modules/pdfjs-dist'), join(destination, 'node_modules/pdfjs-dist'), { recursive: true, dereference: true });
  const napi = join(root, 'node_modules/@napi-rs');
  if (existsSync(napi)) for (const name of readdirSync(napi).filter(name => name.startsWith('canvas'))) {
    cpSync(join(napi, name), join(destination, 'node_modules/@napi-rs', name), { recursive: true, dereference: true });
  }
  // pnpm keeps optional native canvas beside the PDF package instead of hoisting.
  const nestedNapi = resolve(realpathSync(join(root, 'node_modules/pdfjs-dist')), '..', '@napi-rs');
  if (existsSync(nestedNapi)) for (const name of readdirSync(nestedNapi).filter(name => name.startsWith('canvas'))) {
    cpSync(join(nestedNapi, name), join(destination, 'node_modules/@napi-rs', name), { recursive: true, dereference: true });
    const nativeSiblings = resolve(realpathSync(join(nestedNapi, name)), '..');
    for (const native of readdirSync(nativeSiblings).filter(value => value.startsWith('canvas-'))) {
      cpSync(join(nativeSiblings, native), join(destination, 'node_modules/@napi-rs', native), { recursive: true, dereference: true });
    }
  }
  execFileSync(process.execPath, ['scripts/verify-manufacturer-mapping.mjs'], {
    cwd: destination, env: { PATH: process.env.PATH || '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    windowsHide: true, stdio: 'inherit', timeout: 60000,
  });
  console.log(`Packaged manufacturer parser passed on ${process.platform}; all five research routes include runtime worker files.`);
} finally {
  const absolute = resolve(destination);
  if (dirname(absolute) !== resolve(tmpdir()) || !absolute.startsWith(join(resolve(tmpdir()), 'calculator-manufacturer-package-'))) throw Error('Unsafe smoke-test cleanup path');
  rmSync(absolute, { recursive: true, force: true });
}
