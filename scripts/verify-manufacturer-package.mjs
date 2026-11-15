import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const worker = 'lib/model-research/manufacturer-pdf-worker.mjs';
const pdfWorker = 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs';
const routePackages = [];
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
  routePackages.push({ route, files });
}
// The smoke test lives outside the checkout and has no ancestor node_modules or
// NODE_PATH fallback. It runs the actual parser worker with only packaged files.
const destination = mkdtempSync(join(tmpdir(), 'calculator-manufacturer-package-'));
try {
  for (const { route, files } of routePackages) {
    const packaged = join(destination, route.replaceAll('/', '-'));
    // Copy only runtime files named by this route's trace, at their deployed paths.
    for (const file of [...new Set(files)].sort((a, b) => a.length - b.length)) {
      const path = relative(root, file);
      if (!path.startsWith(`node_modules${sep}`) && ![worker, 'lib/model-research/manufacturer-table.mjs'].includes(path.split(sep).join('/'))) continue;
      assert.ok(!path.startsWith('..'), 'Runtime trace escaped the project');
      const target = join(packaged, path);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(file, target, { recursive: true, dereference: true });
    }
    // These source adapters are bundled by Next; only the test harness uses them.
    for (const file of ['manufacturer.mjs', 'registry.mjs', 'config.mjs']) {
      cpSync(join(root, 'lib/model-research', file), join(packaged, 'lib/model-research', file));
    }
    mkdirSync(join(packaged, 'scripts'), { recursive: true });
    cpSync(join(root, 'scripts/verify-manufacturer-mapping.mjs'), join(packaged, 'scripts/verify-manufacturer-mapping.mjs'));
    execFileSync(process.execPath, ['scripts/verify-manufacturer-mapping.mjs'], {
      cwd: packaged, env: { PATH: process.env.PATH || '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      windowsHide: true, stdio: 'inherit', timeout: 60000,
    });
    console.log(`Trace-only manufacturer parser passed on ${process.platform}: ${route}`);
  }
} finally {
  const absolute = resolve(destination);
  if (dirname(absolute) !== resolve(tmpdir()) || !absolute.startsWith(join(resolve(tmpdir()), 'calculator-manufacturer-package-'))) throw Error('Unsafe smoke-test cleanup path');
  rmSync(absolute, { recursive: true, force: true });
}
