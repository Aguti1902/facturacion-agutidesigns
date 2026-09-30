// Detecta enlaces a facturas dentro de un correo y los descarga como PDF.
const GOOD = /(invoice|factura|receipt|recibo|download|descarg|billing|facturaci|documento|document|pdf|comprobante|justificante)/i;
const BAD = /(unsubscribe|darse de baja|baja|privacy|privacidad|terms|condiciones|help|ayuda|support|soporte|facebook|twitter|linkedin|instagram|youtube|preferences|preferencias|manage|gestionar|policy|politica|mailto:|tel:|login|signin|sign-in|iniciar sesi)/i;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

function decodeEntities(s) { return String(s).replace(/&amp;/g, "&").replace(/&#x2F;/gi, "/").replace(/&#47;/g, "/").replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }

export function extractInvoiceLinks(html, text) {
  const out = []; const seen = new Set();
  const push = (url, label) => {
    url = decodeEntities(url).trim().replace(/[\])>.,;]+$/, "");
    if (!/^https:\/\//i.test(url) || seen.has(url)) return;
    const hay = `${label} ${url}`;
    if (!GOOD.test(hay) || BAD.test(label) || /unsubscribe|optout|opt-out|\/preferences/i.test(url)) return;
    seen.add(url); out.push({ url, text: String(label || "").replace(/\s+/g, " ").trim().slice(0, 80) });
  };
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi; let m;
  while ((m = re.exec(html || ""))) push(m[1], m[2].replace(/<[^>]+>/g, " "));
  const re2 = /([^\n<>\[]{0,60})[<\[]?(https:\/\/[^\s<>"')\]]+)[>\]]?/g;
  while ((m = re2.exec(text || ""))) push(m[2], m[1]);
  // Prioriza los que dicen explícitamente factura/invoice/download
  out.sort((a, b) => score(b) - score(a));
  return out.slice(0, 4);
}
function score(l) { const h = `${l.text} ${l.url}`; return (/(invoice|factura|receipt|recibo)/i.test(h) ? 2 : 0) + (/(download|descarg|pdf)/i.test(h) ? 2 : 0); }

function safeUrl(u) {
  try { const x = new URL(u); if (x.protocol !== "https:") return false; if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/.test(x.hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(x.hostname)) return false; return true; } catch { return false; }
}
async function get(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { redirect: "follow", signal: ctl.signal, headers: { "User-Agent": UA, Accept: "application/pdf,text/html;q=0.9,*/*;q=0.8" } });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 20 * 1024 * 1024) throw new Error("too_large");
    return { ok: r.ok, status: r.status, type: (r.headers.get("content-type") || "").toLowerCase(), buf, finalUrl: r.url, disp: r.headers.get("content-disposition") || "" };
  } finally { clearTimeout(t); }
}
const isPdfBuf = b => b && b.length > 4 && b.slice(0, 4).toString() === "%PDF";
function nameFrom(res, fallback) { const m = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(res.disp || ""); return m ? decodeURIComponent(m[1]) : fallback; }

/** Intenta descargar un PDF desde un enlace del correo (y, si es una página, desde sus enlaces de descarga). */
export async function downloadInvoice(url) {
  if (!safeUrl(url)) return { ok: false, reason: "Enlace no válido" };
  const stripe = /^https:\/\/invoice\.stripe\.com\/i\/([^/?#]+)\/([^/?#]+)/.exec(url);
  if (stripe) { try { const r = await get(`https://pay.stripe.com/invoice/${stripe[1]}/${stripe[2]}/pdf?s=em`); if (isPdfBuf(r.buf)) return { ok: true, buf: r.buf, name: nameFrom(r, "invoice.pdf"), via: "stripe.com" }; } catch {} }
  let res;
  try { res = await get(url); } catch { return { ok: false, reason: "El enlace no respondió" }; }
  if (isPdfBuf(res.buf)) return { ok: true, buf: res.buf, name: nameFrom(res, "factura.pdf"), via: new URL(res.finalUrl || url).hostname };
  if (!res.type.includes("html")) return { ok: false, reason: "El enlace no lleva a un PDF" };
  const html = res.buf.toString("utf8");
  if (/type=["']password["']|iniciar sesi[oó]n|sign in to|log in to|accounts\.google\.com/i.test(html) || /accounts\.google\.com|\/login|\/signin/i.test(res.finalUrl || "")) return { ok: false, reason: "Hay que iniciar sesión para descargarla", login: true };
  const base = res.finalUrl || url; const cands = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi; let m;
  while ((m = re.exec(html))) { const h = decodeEntities(m[1]); if (/\.pdf(\?|$)|\/pdf(\?|\/|$)|download|descarg|invoice.*pdf/i.test(h)) { try { cands.push(new URL(h, base).href); } catch {} } }
  for (const c of [...new Set(cands)].slice(0, 4)) {
    if (!safeUrl(c)) continue;
    try { const r2 = await get(c); if (isPdfBuf(r2.buf)) return { ok: true, buf: r2.buf, name: nameFrom(r2, "factura.pdf"), via: new URL(r2.finalUrl || c).hostname }; } catch {}
  }
  return { ok: false, reason: "No se encontró el PDF en la página del enlace" };
}
