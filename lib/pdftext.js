// Extrae el texto de un PDF con pdf.js (más fiable que pdf-parse).
import pdfjs from "pdfjs-dist/legacy/build/pdf.js";
import worker from "pdfjs-dist/legacy/build/pdf.worker.js";
if (!globalThis.pdfjsWorker) globalThis.pdfjsWorker = worker;

export async function pdfText(buf, maxPages = 3) {
  const data = new Uint8Array(buf.buffer ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf);
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 }).promise;
  let out = "";
  try {
    for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
      const page = await doc.getPage(p); const c = await page.getTextContent(); let last = null;
      for (const it of c.items) { if (last !== null && Math.abs(it.transform[5] - last) > 2) out += "\n"; else if (out && !out.endsWith(" ")) out += " "; out += it.str; last = it.transform[5]; }
      out += "\n\n";
    }
  } finally { try { await doc.destroy(); } catch {} }
  return out;
}
