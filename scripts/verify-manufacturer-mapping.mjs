import assert from 'node:assert/strict';
import { ManufacturerEvidence, manufacturerUrl, tableMapping, mappingMatches } from '../lib/model-research/manufacturer.mjs';
import { canonical, requestDetails, validateFinding } from '../lib/model-research/registry.mjs';

const mapping = { brand: 'HISENSE', model: 'HAWH9KR', indoor: 'HAWH9KR-I', outdoor: 'HAWH9KR-O',
  sourceUrl: 'https://dtc-aus-api.hisense.com/medias/spec.pdf' };
const cell = (str, x, y, width = 60) => ({ str, transform: [1, 0, 0, 1, x, y], width });
const items = [cell('Set Model', 18, 748), cell('HAWH9KR', 214, 748, 44),
  cell('Indoor unit model', 18, 740), cell('HAWH9KR-I', 219, 740, 34),
  cell('Outdoor unit model', 18, 732), cell('HAWH9KR-O', 218, 732, 36)];
assert.equal(tableMapping(items, mapping), true);
assert.equal(tableMapping(items, { ...mapping, indoor: 'HAWH9KR-IA' }), false);
assert.equal(tableMapping(items.map(x => x.str === mapping.outdoor ? { ...x, transform: [1, 0, 0, 1, 280, 732] } : x), mapping), false);
assert.equal(tableMapping(items.filter(x => x.str !== 'Indoor unit model'), mapping), false);
const stacked = [...items.map(x => x.str === 'HAWH9KR-I' ? { ...x, str: 'OTHER-I' } : x.str === 'HAWH9KR-O' ? { ...x, str: 'OTHER-O' } : x),
  ...items.map(x => ({ ...x, str: x.str === 'HAWH9KR' ? 'OTHER-SYSTEM' : x.str,
    transform: [1, 0, 0, 1, x.transform[4], x.transform[5] - 25] }))];
assert.equal(tableMapping(stacked, mapping), false, 'Cannot combine package from one table with components from another');
assert.equal(tableMapping(items.map(x => ({ ...x, transform: [1, 0, 0, 1, x.transform[4], 740] })), mapping), false);
assert.equal(mappingMatches(mapping, 'HAWH9KR-O/ HAWH9KR-I', mapping), true);
assert.equal(mappingMatches(mapping, 'HAWH9KR-IA', mapping), false);
assert.equal(mappingMatches(mapping, 'HAWH9KR-I', mapping), false, 'One component does not prove a unique package');
assert.equal(mappingMatches(mapping, 'HAWH9KR-O/HAWH9KR-O', mapping), false);
assert.equal(mappingMatches(mapping, 'HAWH9KR-O/HAWH9KR-I', { ...mapping, brand: 'Other' }), false);
for (const url of ['http://hisense.com.au/a.pdf', 'https://hisense.com.au.evil.com/a.pdf',
  'https://hisense.com.au@evil.com/a.pdf', 'https://localhost/a.pdf', 'https://127.0.0.1/a.pdf',
  'https://hisense.com.au:8080/a.pdf', 'https://user:secret@hisense.com.au/a.pdf']) {
  assert.throws(() => manufacturerUrl('Hisense', url));
}
assert.throws(() => manufacturerUrl('Daikin', mapping.sourceUrl));
assert.equal(manufacturerUrl(mapping.brand, mapping.sourceUrl), mapping.sourceUrl);
const record = { Brand: 'HISENSE', Model_No: 'HAWH9KR', 'Registration Number': 'AAC9478',
  SubmitStatus: 'Approved', 'Availability Status': 'Available', Sold_in: 'Australia', ExpDate: '2030-09-30',
  Configuration1: 'Non Ducted', Configuration2: 'Single Split System', 'Outdoor unit only': 'No',
  Phase: 'Single', 'C-Total Cool Rated': '2.5' };
const request = requestDetails({ id: 'fixture', brand: 'Hisense', model: 'HAWH9KR-O/ HAWH9KR-I',
  capacity: '2.5kw', system_type: 'split', postcode: '2148', install_type: 'new' });
const finding = { outcome: 'candidate', canonical: canonical(record), summary: 'Verified system mapping',
  sourceUrls: [mapping.sourceUrl], question: null };
const date = new Date('2026-11-16');
assert.throws(() => validateFinding(finding, request, [record], new Set(finding.sourceUrls), date), /without verified/);
assert.equal(validateFinding(finding, request, [record], new Set(finding.sourceUrls), date, [mapping]).manufacturerMapping, mapping);
assert.throws(() => validateFinding(finding, request, [record, record], new Set(finding.sourceUrls), date, [mapping]), /exactly one/);
assert.equal(validateFinding(finding, { ...request, model: 'HAWH9KR' }, [record], new Set(finding.sourceUrls), date).canonical.model, 'HAWH9KR');

// Minimal PDF fixture exercises the real parser, with the same table alignment as the manufacturer brochure.
function pdfFixture() {
  const commands = items.map(x => `BT /F1 8 Tf ${x.str.startsWith('HAWH') ? 240 - x.str.length * 2.4 : 18} ${x.transform[5]} Td (${x.str}) Tj ET`).join('\n');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>', `<< /Length ${commands.length} >>\nstream\n${commands}\nendstream`];
  let body = '%PDF-1.4\n'; const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(body.length); body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = body.length;
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return body;
}
const fetches = [];
const service = new ManufacturerEvidence(async (url, options) => {
  fetches.push(url); assert.equal(options.redirect, 'error'); assert.ok(options.signal);
  return new Response(pdfFixture(), { headers: { 'Content-Type': 'application/pdf' } });
});
const evidence = await service.verify(mapping);
assert.equal(evidence.page, 1); assert.match(evidence.sha256, /^[a-f0-9]{64}$/);
await assert.rejects(service.verify({ ...mapping, sourceUrl: 'https://127.0.0.1/a.pdf' }));
assert.equal(fetches.length, 1);
await assert.rejects(new ManufacturerEvidence(async () => new Response('not pdf', { headers: { 'Content-Type': 'text/html' } })).verify(mapping));
await assert.rejects(new ManufacturerEvidence(async () => new Response('bad', { headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(33 * 1024 * 1024) } })).verify(mapping));
console.log('Manufacturer mapping: exact table pairing, suffix rejection, registry conflict, SSRF boundaries and PDF parser passed');
