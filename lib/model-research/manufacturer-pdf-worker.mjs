import { parentPort, workerData } from 'node:worker_threads';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { tableMapping } from './manufacturer-table.mjs';

const task = getDocument({ data: workerData.bytes, isEvalSupported: false,
  useSystemFonts: false, disableFontFace: true, stopAtErrors: true, verbosity: 0 });
try {
  const doc = await task.promise;
  if (doc.numPages > 80) throw new Error('Manufacturer document exceeds the page limit');
  let textSize = 0;
  let matchedPage = null;
  for (let page = 1; page <= doc.numPages; page++) {
    const pdfPage = await doc.getPage(page);
    const { items } = await pdfPage.getTextContent();
    textSize += items.reduce((sum, item) => sum + (item.str?.length || 0), 0);
    if (textSize > 500000) throw new Error('Manufacturer document exceeds the text limit');
    if (tableMapping(items, workerData.mapping)) matchedPage ??= page;
    pdfPage.cleanup();
  }
  parentPort.postMessage({ page: matchedPage });
} catch {
  parentPort.postMessage({ error: 'Manufacturer PDF could not be safely parsed' });
} finally { await task.destroy(); }
