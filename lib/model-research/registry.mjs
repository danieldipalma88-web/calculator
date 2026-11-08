import { REGISTRY_TIMEOUT_MS } from './config.mjs';

const RESOURCE = 'd4e17a35-9002-4a0c-ac1c-003ece0de135';
const API = 'https://data.gov.au/data/api/3/action/datastore_search_sql';
const FIELDS = ['_id', 'Registration Number', 'Submit_ID', 'Brand', 'Model_No', 'Family Name',
  'SubmitStatus', 'Availability Status', 'Sold_in', 'ExpDate', 'Configuration1', 'Configuration2',
  'Outdoor unit only', 'Phase', 'Product Class', 'ApplStandard', 'C-Total Cool Rated',
  'H-Total Heat Rated', 'C-Power_Inp_Rated', 'Rated AEER', 'Rated ACOP',
  'Residential TCSPF_mixed', 'Residential HSPF_mixed', 'Residential HSPF_cold',
  ...['tcec', 'thec'].flatMap(kind => ['hot', 'mixed', 'cold'].map(zone => `Residential ${kind}_${zone}`))];
const key = value => String(value || '').toUpperCase().replace(/\s+/g, '');
export const pairParts = value => String(value || '').split('/').map(key).filter(Boolean);

export function requestDetails(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid model request');
  const fields = { id: 100, brand: 100, model: 180, capacity: 30, phase: 30, postcode: 4,
    install_type: 20, system_type: 30, notes: 2000 };
  const result = {};
  for (const [field, max] of Object.entries(fields)) {
    const item = value[field] ?? '';
    if (typeof item !== 'string' || item.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(item)) throw new Error(`Invalid ${field}`);
    result[field] = item.trim();
  }
  if (!result.id || !result.brand || !result.model || !['split', 'ducted'].includes(result.system_type)) throw new Error('Model request needs an ID, brand, model and supported system type');
  if (result.postcode && !/^\d{4}$/.test(result.postcode)) throw new Error('Invalid postcode');
  if (result.install_type && !['new', 'replacement'].includes(result.install_type)) throw new Error('Invalid installation type');
  result.round = value.round ?? 1;
  if (!Number.isSafeInteger(result.round) || result.round < 1 || result.round > 20) throw new Error('Invalid request round');
  const messages = value.messages ?? [];
  if (!Array.isArray(messages) || messages.length > 12 || messages.some(m => typeof m !== 'string' || m.length > 2000)) throw new Error('Invalid requester replies');
  result.messages = messages;
  return result;
}

export function researchInput(request) {
  const scrub = s => s.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email removed]')
    .replace(/(?:\+?61|0)[\d ()-]{8,15}\d/g, '[phone removed]');
  return {
    brand: scrub(request.brand), model: scrub(request.model), capacity: request.capacity, phase: request.phase,
    system_type: request.system_type, postcode: request.postcode, install_type: request.install_type,
    notes: scrub(request.notes), messages: request.messages.map(scrub),
  };
}

export function canonical(record) {
  const phase = String(record.Phase || '').replace(/[- ]phase$/i, '').toLowerCase();
  return {
    brand: String(record.Brand || ''), model: String(record.Model_No || ''),
    systemType: /^non[ -]ducted$/i.test(record.Configuration1) ? 'split' : /^ducted$/i.test(record.Configuration1) ? 'ducted' : '',
    capacityKw: Number(record['C-Total Cool Rated']),
    phase: phase === 'single' || phase === '1' ? 'Single' : phase === 'three' || phase === '3' ? 'Three' : '',
    registrationNumber: String(record['Registration Number'] || ''),
  };
}

export function activeRecord(record, now = new Date()) {
  return /^approved$/i.test(record.SubmitStatus) && /^available$/i.test(record['Availability Status'])
    && String(record.Sold_in || '').split(/[,;]/).some(x => /^australia$/i.test(x.trim()))
    && /^\d{4}-\d{2}-\d{2}$/.test(record.ExpDate || '')
    && Number.isFinite(Date.parse(record.ExpDate))
    && new Date(record.ExpDate).toISOString().slice(0, 10) === record.ExpDate
    && record.ExpDate >= now.toISOString().slice(0, 10)
    && /^single split system$/i.test(record.Configuration2 || '')
    && !/^(yes|true|1)$/i.test(record['Outdoor unit only'] || '');
}

export function originalMatches(model, registered) {
  const registeredParts = pairParts(registered);
  const separated = String(model).trim().split(/\s*(?:\/|,|\||\s+and\s+)\s*/i).filter(Boolean);
  if (separated.length === 2) return separated.map(key).sort().join('/') === registeredParts.slice().sort().join('/');
  const tokens = String(model).trim().split(/\s+/).map(key);
  if (tokens.length === 2 && tokens.every(p => registeredParts.includes(p))) return true;
  return registeredParts.includes(key(model));
}

export class Registry {
  constructor(fetcher = fetch) { this.fetch = fetcher; }
  async search(code) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._+/-]{1,100}$/.test(code)) throw new Error('Use a model code, not arbitrary search SQL');
    const clause = code.replaceAll("'", "''");
    const sql = `SELECT ${FIELDS.map(field => `"${field}"`).join(',')} FROM "${RESOURCE}" WHERE "Model_No" ILIKE '%${clause}%' LIMIT 51`;
    const url = new URL(API);
    url.searchParams.set('sql', sql);
    const response = await this.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`GEMS register unavailable (${response.status})`);
    const content = await response.text();
    if (content.length > 1_000_000) throw new Error('GEMS response exceeded safe size');
    const data = JSON.parse(content);
    if (!data.success || !Array.isArray(data.result?.records)) throw new Error('GEMS register returned an invalid response');
    return { sourceUrl: url.href, truncated: data.result.records.length > 50, records: data.result.records.slice(0, 50) };
  }
}

export function validateFinding(finding, request, records, sources, now = new Date()) {
  if (!finding || !['candidate', 'needs_details', 'review'].includes(finding.outcome)
    || typeof finding.summary !== 'string' || !finding.summary.trim() || finding.summary.length > 3000
    || !Array.isArray(finding.sourceUrls) || finding.sourceUrls.length > 20
    || finding.sourceUrls.some(url => !sources.has(url))) throw new Error('Agent finding lacks valid collected evidence');
  if (finding.outcome !== 'candidate') {
    if (finding.outcome === 'needs_details' && (typeof finding.question !== 'string' || !finding.question.trim())) throw new Error('Clarification needs one specific question');
    return { ...finding, canonical: null };
  }
  const proposed = finding.canonical;
  if (!finding.sourceUrls.length) throw new Error('Candidate must cite its collected primary evidence');
  if (!proposed || pairParts(proposed.model).length !== 2) throw new Error('Complete registered pairing required; package aliases need human review');
  const matches = records.filter(record => activeRecord(record, now)
    && Object.entries(canonical(record)).every(([field, value]) => proposed[field] === value));
  if (matches.length !== 1) throw new Error('Candidate must identify exactly one independently fetched active GEMS registration');
  if (!originalMatches(request.model, proposed.model)) throw new Error('The proposed model changes an equipment code or suffix');
  if (request.system_type !== proposed.systemType) throw new Error('System type conflicts with the registered equipment');
  const requestedPhase = request.phase.toLowerCase().replace(/[- ]phase$/i, '');
  if (['single', 'three', '1', '3'].includes(requestedPhase)
    && (['single', '1'].includes(requestedPhase) ? 'Single' : 'Three') !== proposed.phase) throw new Error('Requested phase conflicts with registration');
  const requestedCapacity = Number(request.capacity.replace(/\s*kw$/i, ''));
  if (request.capacity && (!Number.isFinite(requestedCapacity) || Math.abs(requestedCapacity - proposed.capacityKw) > Math.max(0.5, proposed.capacityKw * 0.03))) {
    throw new Error('Capacity discrepancy needs explicit confirmation');
  }
  if (!(proposed.capacityKw > 0) || !proposed.phase || !proposed.registrationNumber) throw new Error('Incomplete registered specifications');
  return { ...finding, registration: matches[0],
    identity: [proposed.brand.toUpperCase(), ...pairParts(proposed.model).sort()].join('|') };
}
