// Decide si un correo contiene una FACTURA DE GASTO (recibida) y cuáles de sus PDF lo son.
import { parseAmount } from "./heuristic.js";

const INVOICE = /(factura|invoice|receipt|recibo|tax invoice|nota de cargo|n[ºo°]\s*de\s*factura|billing statement|comprobante de pago)/i;
const NOT_INVOICE = /(presupuesto|proforma|pro-forma|cotizaci[oó]n|quotation|\bquote\b|contrato|contract|t[eé]rminos y condiciones|terms (and|&) conditions|condiciones generales|pol[ií]tica de privacidad|newsletter|cat[aá]logo|catalogue|curr[ií]culum|\bcv\b|n[oó]mina|payslip|certificado|certificate|manual|gu[ií]a de|dossier|propuesta|proposal|briefing|entrada|ticket de embarque|boarding pass|itinerario|horario)/i;
const MONEY = /(\d{1,3}(?:[.,\s]\d{3})*[.,]\d{2})\s?(€|eur|usd|\$)|(€|\$|eur|usd)\s?(\d{1,3}(?:[.,\s]\d{3})*[.,]\d{2})/i;
const TOTAL = /(total|importe|amount due|amount paid|a pagar|total due|subtotal|base imponible)/i;
const NIF = /\b(?:ES)?([A-HJ-NP-SUVW]\d{7}[0-9A-J]|\d{8}[A-Z]|[XYZ]\d{7}[A-Z])\b/g;
const BILLING_SENDER = /(billing|invoice|factura|receipt|recibo|payments?|pagos|facturacion|accounts|stripe|paddle|noreply.*(pay|bill))/i;

function norm(s) { return String(s || "").replace(/\s+/g, " "); }

/** Veredicto para el texto de un PDF. */
export function classifyPdf(text, name, profile, ownNumbers) {
  const t = norm(text); const head = t.slice(0, 2500);
  const nm = String(name || "");
  const looksInvoice = INVOICE.test(head) || /(factura|invoice|receipt|recibo|inv[-_ ]?\d)/i.test(nm);
  if (!t.trim()) {
    return /(factura|invoice|receipt|recibo)/i.test(nm) ? { ok: true, reason: "PDF escaneado: por el nombre parece una factura" } : { ok: false, reason: "PDF sin texto que no parece una factura" };
  }
  if (!looksInvoice && NOT_INVOICE.test(head)) return { ok: false, reason: "Es un " + (head.match(NOT_INVOICE)[0] || "documento").toLowerCase() + ", no una factura" };
  if (!looksInvoice) return { ok: false, reason: "El PDF no es una factura" };
  if (/(presupuesto|proforma|pro-forma|quotation)/i.test(head.slice(0, 400)) && !/factura\s+(n|num)/i.test(head.slice(0, 400))) return { ok: false, reason: "Es un presupuesto o proforma" };
  if (!MONEY.test(t) && !TOTAL.test(t)) return { ok: false, reason: "No tiene importes" };
  // ¿La he emitido yo? El primer NIF que aparece suele ser el del emisor.
  const nif = String(profile.nif || "").toUpperCase();
  const nifs = [...t.toUpperCase().matchAll(NIF)].map(m => m[1]);
  if (nif && nifs.length && nifs[0] === nif && nifs.some(n => n !== nif)) return { ok: false, reason: "Es una factura emitida por ti" };
  const brand = String(profile.brandName || "").trim();
  if (brand && new RegExp("^.{0,120}" + brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(t) && nifs[0] === nif) return { ok: false, reason: "Es una factura emitida por ti" };
  const numM = head.match(/(?:factura|invoice)\s*(?:n[ºo°.]*|number|num\.?|#|no\.?)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/_.]{2,24})/i);
  if (numM && ownNumbers.has(numM[1].toUpperCase())) return { ok: false, reason: `Es tu factura ${numM[1]}` };
  const tot = (t.match(/(?:total|importe total|amount due|amount paid)[^\d€$]{0,30}([€$]?\s?\d{1,3}(?:[.,\s]\d{3})*[.,]\d{2})/i) || [])[1];
  return { ok: true, reason: "Factura recibida", total: tot ? parseAmount(tot) : null };
}

/** Veredicto para un correo sin PDF que trae un enlace de factura. */
export function classifyLinkMail({ subject, from, text, links }) {
  const all = `${subject}\n${norm(text).slice(0, 4000)}`;
  if (!links.length) return { ok: false, reason: "No trae factura adjunta ni enlace de descarga" };
  if (NOT_INVOICE.test(subject)) return { ok: false, reason: "Es un " + subject.match(NOT_INVOICE)[0].toLowerCase() };
  if (/(te avisaremos|will be available|está en camino|recordatorio de pago|payment reminder|payment failed|pago rechazado|no se ha efectuado un pago|vence pronto|actualiza tu m[eé]todo de pago|update your payment)/i.test(all)) return { ok: false, reason: "Es un aviso de pago, no la factura" };
  const invoiceish = INVOICE.test(all) && (MONEY.test(all) || /(ver factura|view invoice|download invoice|descargar factura|documento de facturaci[oó]n|billing document|ver documentos)/i.test(all));
  if (invoiceish || (BILLING_SENDER.test(from) && INVOICE.test(all))) return { ok: true, reason: "Factura disponible en un enlace" };
  return { ok: false, reason: "Menciona una factura pero no la trae" };
}
