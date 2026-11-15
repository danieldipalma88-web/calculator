import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
export { tableMapping } from './manufacturer-table.mjs';

const HOSTS = {
  HISENSE: ['hisense.com.au', 'www.hisense.com.au', 'dtc-aus-api.hisense.com'],
  DAIKIN: ['daikin.com.au', 'www.daikin.com.au'],
  'MITSUBISHI HEAVY INDUSTRIES': ['mhiaa.com.au', 'www.mhiaa.com.au'],
  'MITSUBISHI ELECTRIC': ['mitsubishielectric.com.au', 'www.mitsubishielectric.com.au'],
  MIDEA: ['midea.com.au', 'www.midea.com.au', 'mdhome.com.au', 'www.mdhome.com.au'],
  RINNAI: ['rinnai.com.au', 'www.rinnai.com.au'],
  ACTRONAIR: ['actronair.com.au', 'www.actronair.com.au'],
  TEMPERZONE: ['temperzone.com', 'www.temperzone.com', 'temperzone.com.au', 'www.temperzone.com.au'],
  'FUJITSU GENERAL': ['fujitsugeneral.com.au', 'www.fujitsugeneral.com.au'],
  PANASONIC: ['panasonic.com', 'www.panasonic.com'],
  SAMSUNG: ['samsung.com', 'www.samsung.com'],
  LG: ['lg.com', 'www.lg.com'],
};
const code = value => String(value || '').toUpperCase().replace(/\s+/g, '');
const MAX_BYTES = 32 * 1024 * 1024;
export const MANUFACTURER_TIMEOUT_MS = 20_000;

export function manufacturerUrl(brand, value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash
    || !(HOSTS[String(brand).trim().toUpperCase()] || []).includes(url.hostname)) {
    throw new Error('Source must be an allowlisted official manufacturer HTTPS URL');
  }
  return url.href;
}

export function mappingMatches(mapping, requested, proposed) {
  if (!mapping || code(mapping.brand) !== code(proposed.brand) || code(mapping.model) !== code(proposed.model)) return false;
  const parts = String(requested).trim().split(/\s*(?:\/|,|\||\s+and\s+)\s*|\s+/i).map(code).filter(Boolean);
  const components = [code(mapping.indoor), code(mapping.outdoor)];
  return parts.length === 2 && new Set(parts).size === 2
    && parts.every(part => components.includes(part));
}

export class ManufacturerEvidence {
  constructor(fetcher = fetch) { this.fetch = fetcher; }
  async verify(mapping) {
    const { brand, model, indoor, outdoor } = mapping || {};
    if ([model, indoor, outdoor].some(value => typeof value !== 'string' || !/^[A-Z0-9][A-Z0-9._+-]{1,99}$/i.test(value))
      || new Set([model, indoor, outdoor].map(code)).size !== 3) throw new Error('Three distinct exact model codes are required');
    const sourceUrl = manufacturerUrl(brand, mapping.sourceUrl);
    const signal = AbortSignal.timeout(MANUFACTURER_TIMEOUT_MS);
    const response = await this.fetch(sourceUrl, { redirect: 'error', signal });
    if (!response.ok || !/application\/pdf/i.test(response.headers.get('content-type') || '')
      || Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Manufacturer PDF is unavailable or exceeds the evidence limit');
    const reader = response.body.getReader();
    const chunks = []; let length = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BYTES) throw new Error('Manufacturer PDF exceeds the evidence limit');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const bytes = Buffer.concat(chunks);
    if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Source is not a PDF');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    signal.throwIfAborted();
    const worker = new Worker(resolve(process.cwd(), 'lib/model-research/manufacturer-pdf-worker.mjs'), {
      workerData: { bytes: new Uint8Array(bytes), mapping },
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      env: {},
    });
    let abort;
    try {
      const result = await new Promise((done, reject) => {
        abort = () => reject(new Error('Manufacturer evidence timed out'));
        signal.addEventListener('abort', abort, { once: true });
        worker.once('message', done);
        worker.once('error', () => reject(new Error('Manufacturer parser unavailable')));
        worker.once('exit', () => reject(new Error('Manufacturer parser stopped before returning evidence')));
        if (signal.aborted) abort();
      });
      if (result.error) throw new Error(result.error);
      if (!result.page) {
        const error = new Error('The manufacturer document does not verify this exact system and component pairing');
        error.code = 'MODEL_MAPPING_NOT_VERIFIED';
        throw error;
      }
      return { brand, model, indoor, outdoor, sourceUrl, page: result.page, sha256,
        method: 'manufacturer-labelled-table-column', verifiedAt: new Date().toISOString() };
    } finally { signal.removeEventListener('abort', abort); await worker.terminate(); }
  }
}
