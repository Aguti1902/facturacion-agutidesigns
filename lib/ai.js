// Clasificación y lectura de facturas con Claude (si hay ANTHROPIC_API_KEY).
import Anthropic from "@anthropic-ai/sdk";

export const hasAI = () => !!process.env.ANTHROPIC_API_KEY;
const MODEL = () => process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
let client; const ai0 = () => (client ||= new Anthropic());
const FALLBACK = ["claude-sonnet-4-5", "claude-haiku-4-5-20251001"];
async function create(params) {
  try { return await ai0().messages.create({ ...params, model: MODEL() }); }
  catch (e) { if (e.status === 404 || /model/i.test(e.message || "")) { for (const m of FALLBACK) { try { return await ai0().messages.create({ ...params, model: m }); } catch {} } } throw e; }
}

function jsonFrom(txt) { const a = txt.indexOf("{"), b = txt.lastIndexOf("}"); return JSON.parse(txt.slice(a, b + 1)); }
function pdfBlocks(pdfs) {
  // PDF con texto: se envía el texto. PDF escaneado (sin texto): se envía el propio PDF para que Claude lo lea.
  const blocks = []; let docs = 0;
  for (const p of pdfs) {
    if ((p.text || "").trim().length > 40) blocks.push({ type: "text", text: `--- PDF «${p.name}» ---\n${p.text.slice(0, 7000)}` });
    else if (p.buf && p.buf.length < 5 * 1024 * 1024 && docs < 2) { docs++; blocks.push({ type: "text", text: `--- PDF «${p.name}» (escaneado, va adjunto) ---` }); blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: p.buf.toString("base64") } }); }
    else blocks.push({ type: "text", text: `--- PDF «${p.name}»: no se pudo leer ---` });
  }
  return blocks;
}

/** ¿El correo contiene una factura de GASTO del usuario? */
export async function aiClassify({ profile, ownNumbers, subject, from, text, pdfs, links, senderRule }) {
  const intro = `Eres el asistente contable de ${profile.name || "un autónomo"} (NIF ${profile.nif || "-"}${profile.brandName ? `, nombre comercial «${profile.brandName}»` : ""}). Revisa este correo y decide si contiene una FACTURA DE GASTO suya: una factura, recibo o ticket de pago emitido por un proveedor a su nombre por algo que ha comprado o contratado (software, hosting, publicidad, servicios, suministros, material, préstamos…).
NO son facturas de gasto: facturas que emite él a sus clientes${ownNumbers.length ? ` (sus números son, entre otros: ${ownNumbers.slice(0, 40).join(", ")})` : ""}, presupuestos, proformas, pedidos o confirmaciones sin factura, avisos de pago o recordatorios, pagos fallidos, extractos bancarios, contratos, condiciones, newsletters, publicidad, envíos o seguimientos.
${senderRule === "allow" ? "El usuario ha confirmado antes que este remitente le envía facturas de gasto." : ""}
Responde SOLO con JSON: {"es_factura_gasto": true|false, "motivo": "frase corta en español", "pdfs_factura": ["nombre exacto de cada PDF que sea factura de gasto"], "factura_en_enlace": true|false}
"factura_en_enlace" es true solo si no hay PDF de factura pero el correo trae un enlace para ver o descargar esa factura concreta.`;
  const content = [{ type: "text", text: `${intro}\n\nCORREO\nDe: ${from}\nAsunto: ${subject}\nTexto:\n${String(text || "").replace(/\s+\n/g, "\n").slice(0, 4000)}\n${links.length ? `Enlaces detectados: ${links.map(l => `${l.text} → ${l.url}`).join(" | ")}` : "Sin enlaces de descarga detectados."}\n${pdfs.length ? "PDF adjuntos:" : "Sin PDF adjuntos."}` }, ...pdfBlocks(pdfs)];
  const r = await create({ max_tokens: 400, messages: [{ role: "user", content }] });
  const j = jsonFrom(r.content.map(b => b.text || "").join(""));
  const names = new Set(pdfs.map(p => p.name));
  const files = (j.pdfs_factura || []).filter(n => names.has(n));
  const ok = !!j.es_factura_gasto && (files.length > 0 || (!!j.factura_en_enlace && links.length > 0));
  return { ok, reason: j.motivo || (ok ? "Factura de gasto" : "No es una factura de gasto"), files, viaLink: !files.length && ok, ai: true };
}

/** Lee los datos de una factura de gasto. */
export async function aiExtract({ profile, subject, from, text, pdf, cats }) {
  const prompt = `Extrae los datos de esta factura RECIBIDA por ${profile.name || "el autónomo"} (NIF ${profile.nif || "-"}). Devuelve SOLO JSON con: supplier (razón social del emisor), cif (NIF/VAT del emisor), number, date (fecha de la factura AAAA-MM-DD), concept (máx. 70 caracteres), category (una de: ${cats.join(" | ")}), currency (EUR, USD…), base (base imponible), vat_rate (tipo de IVA %, 0 si no hay), vat_amount, total, irpf_rate (retención aplicada o 0), region ("ES" | "UE" | "EXT" según el país del emisor), reverse_charge (true si el emisor no es español y no cobra IVA español), is_invoice (false si no es una factura de gasto), confidence ("alta"|"media"|"baja"). Números con punto decimal.
Correo de: ${from}\nAsunto: ${subject}\n${String(text || "").slice(0, 2500)}`;
  const content = [{ type: "text", text: prompt }, ...(pdf ? pdfBlocks([pdf]) : [])];
  const r = await create({ max_tokens: 700, messages: [{ role: "user", content }] });
  return jsonFrom(r.content.map(b => b.text || "").join(""));
}
