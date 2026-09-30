// Lectura básica de facturas sin IA: busca total, base, IVA, fecha, número y NIF en el texto.
const MONTHS = { jan:1,ene:1,january:1,enero:1,feb:2,february:2,febrero:2,mar:3,march:3,marzo:3,apr:4,abr:4,april:4,abril:4,may:5,mayo:5,jun:6,june:6,junio:6,jul:7,july:7,julio:7,aug:8,ago:8,august:8,agosto:8,sep:9,sept:9,set:9,september:9,septiembre:9,oct:10,october:10,octubre:10,nov:11,november:11,noviembre:11,dec:12,dic:12,december:12,diciembre:12 };
const AMOUNT = /(?:[€$£]\s?)?-?\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{2})(?!\d)(?:\s?(?:€|eur|usd|\$))?/gi;

export function parseAmount(s) {
  let t = String(s).replace(/[^\d.,-]/g, "");
  const lc = Math.max(t.lastIndexOf(","), t.lastIndexOf("."));
  if (lc < 0) return +t;
  const intPart = t.slice(0, lc).replace(/[.,]/g, ""), dec = t.slice(lc + 1);
  return +(intPart + "." + dec);
}
const amountsIn = line => (line.match(AMOUNT) || []).map(parseAmount).filter(n => isFinite(n));
const pad = n => String(n).padStart(2, "0");

function findDate(text) {
  const lines = text.split(/\n/);
  const pick = s => {
    let m = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})\b/); if (m && +m[2] <= 12) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
    m = s.match(/\b([A-Za-zé]{3,10})\.?\s+(\d{1,2}),?\s+(\d{4})\b/); if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[1].toLowerCase()])}-${pad(m[2])}`;
    m = s.match(/\b(\d{1,2})\s+(?:de\s+)?([A-Za-zé]{3,10})\.?\s+(?:de\s+)?(\d{4})\b/); if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}`;
    return null;
  };
  for (let i = 0; i < lines.length; i++) if (/(fecha|date|emisi[oó]n|issued)/i.test(lines[i]) && !/(venc|due)/i.test(lines[i])) { const d = pick(lines[i] + " " + (lines[i + 1] || "")); if (d) return d; }
  for (const l of lines) { const d = pick(l); if (d) return d; }
  return null;
}

function category(s) {
  s = s.toLowerCase();
  if (/(supabase|vercel|aws|amazon web|hosting|servidor|server|cloud|dondominio|hetzner|digitalocean|ovh|netlify|render\.com|railway)/.test(s)) return "Servidores y hosting";
  if (/(google ads|meta ads|facebook ads|linkedin ads|publicidad|advertising|ads\b)/.test(s)) return "Publicidad";
  if (/(workspace|microsoft 365|office|adobe|figma|notion|slack|github|openai|anthropic|licen|subscription|suscrip|software|saas)/.test(s)) return "Software y suscripciones";
  if (/(banco|bank|comisi[oó]n|stripe fee|paypal fee)/.test(s)) return "Comisiones bancarias";
  if (/(asesor|gestor|abogad|notar|consult)/.test(s)) return "Servicios profesionales";
  if (/(renfe|vueling|iberia|ryanair|hotel|booking|uber|cabify|taxi|restaurante)/.test(s)) return "Viajes y dietas";
  return "Otros";
}

export function heuristicExtract({ text, subject, fromName, dateIso, companyCif }) {
  const lines = String(text || "").split(/\n/).map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const all = lines.join("\n");
  let total = null, base = null, vatAmount = null, vatRate = null;
  // total: la mayor cifra de las líneas con "total" que no sean subtotal
  const tot = []; lines.forEach((l, i) => { if (/total|importe a pagar|amount due|a pagar/i.test(l) && !/sub\s?total|base/i.test(l)) { const a = amountsIn(l).concat(amountsIn(lines[i + 1] || "")); if (a.length) tot.push(Math.max(...a)); } });
  if (tot.length) total = Math.max(...tot);
  for (let i = 0; i < lines.length; i++) { const l = lines[i]; if (/(base imponible|subtotal|sub total|importe neto|net amount)/i.test(l)) { const a = amountsIn(l).concat(amountsIn(lines[i + 1] || "")); if (a.length) { base = a[0]; break; } } }
  for (let i = 0; i < lines.length; i++) { const l = lines[i]; const m = l.match(/(iva|vat|tax|impuesto)[^\d%]{0,20}(\d{1,2}(?:[.,]\d+)?)\s?%/i); if (m) { vatRate = parseAmount(m[2]); const a = amountsIn(l.slice(l.indexOf(m[0]) + m[0].length)).concat(amountsIn(lines[i + 1] || "")); if (a.length) vatAmount = a[0]; break; } }
  if (total != null && base == null) { base = vatRate ? Math.round(total / (1 + vatRate / 100) * 100) / 100 : total; }
  if (base != null && vatAmount == null) vatAmount = vatRate ? Math.round(base * vatRate / 100 * 100) / 100 : (total != null ? Math.round((total - base) * 100) / 100 : 0);
  if (vatRate == null && base && vatAmount) vatRate = Math.round(vatAmount / base * 100);
  const currency = /(usd|us\$|\$\s?\d|\d\s?\$)/i.test(all) && !/€|eur\b/i.test(all) ? "USD" : "EUR";
  const numM = all.match(/(?:factura|invoice|n[ºo°]\.?\s*de\s*factura)\s*(?:n[ºo°.]*|number|num\.?|#|no\.?)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/_.]{2,24})/i);
  const cifs = (all.match(/\b(?:ES)?([A-HJ-NP-SUVW]\d{7}[0-9A-J]|\d{8}[A-Z])\b/g) || []).map(c => c.replace(/^ES/, "")).filter(c => c !== companyCif);
  const reverse = /reverse charge|inversi[oó]n del sujeto pasivo|autoliquidaci/i.test(all) || currency !== "EUR" || (!cifs.length && (vatAmount === 0 || vatAmount == null) && total != null);
  const found = total != null;
  return {
    supplier: fromName, cif: cifs[0] || "", number: numM ? numM[1] : "", date: findDate(all) || dateIso,
    concept: String(subject || "").slice(0, 80), category: category(`${fromName} ${subject} ${all.slice(0, 500)}`),
    currency, base: base ?? 0, vat_rate: reverse ? 0 : (vatRate ?? 21), vat_amount: reverse ? 0 : vatAmount, total: total ?? 0,
    reverse_charge: reverse, is_invoice: true, confidence: found ? "media" : "baja",
  };
}
