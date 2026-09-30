import { send, authUser, withImap, readJson } from "../../lib/common.js";
import { simpleParser } from "mailparser";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import Anthropic from "@anthropic-ai/sdk";
import { heuristicExtract } from "../../lib/heuristic.js";

const TABLE = "au_docs", BUCKET = "au-facturas";
const CATS = ["Software y suscripciones","Servidores y hosting","Publicidad","Material y equipos","Servicios profesionales","Subcontratación","Formación","Viajes y dietas","Vehículo y transporte","Teléfono e internet","Oficina y suministros","Cuota de autónomos","Seguros","Comisiones bancarias","Otros"];
const EU = /\b(IE|DE|FR|NL|LU|BE|IT|PT|AT|SE|DK|FI|PL|CZ|EE|LT|LV|HU|SK|SI|HR|RO|BG|GR|EL|CY|MT)\d{6,12}[A-Z0-9]*\b/;
const r2 = n => Math.round((+n || 0) * 100) / 100;
const isPdf = a => a.contentType === "application/pdf" || /\.pdf$/i.test(a.filename || "") || (a.content && a.content.slice(0, 4).toString() === "%PDF");

async function extract(profile, mail, pdfText) {
  const fromName = mail.from?.value?.[0]?.name || mail.from?.value?.[0]?.address || "";
  const dateIso = (mail.date || new Date()).toISOString().slice(0, 10);
  const basic = () => ({ ...heuristicExtract({ text: pdfText || mail.text || "", subject: mail.subject || "", fromName, dateIso, companyCif: profile.nif || "" }), noAi: true });
  if (!process.env.ANTHROPIC_API_KEY) return basic();
  try {
    const client = new Anthropic();
    const prompt = `Extrae los datos de una factura RECIBIDA por el autónomo ${profile.name || ""} (NIF ${profile.nif || "-"}). Devuelve SOLO JSON con: supplier, cif, number, date (AAAA-MM-DD), concept (máx. 70 caracteres), category (una de: ${CATS.join(" | ")}), currency, base, vat_rate, vat_amount, total, irpf_rate (retención si la factura la aplica, si no 0), region ("ES" | "UE" | "EXT" según el país del emisor), reverse_charge (true si el emisor no es español y no cobra IVA español), is_invoice (false si no es una factura o recibo de gasto), confidence ("alta"|"media"|"baja").

CORREO
De: ${mail.from?.text || ""}
Asunto: ${mail.subject || ""}
${(mail.text || "").slice(0, 5000)}

TEXTO DEL PDF
${pdfText || "(sin PDF)"}`;
    const r = await client.messages.create({ model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001", max_tokens: 800, messages: [{ role: "user", content: prompt }] });
    const txt = r.content.map(b => b.text || "").join("");
    return JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
  } catch { return basic(); }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Usa POST" });
  try {
    const { sb } = await authUser(req);
    const { id, folder, uid, existingId } = await readJson(req);
    if (!/^imap-[0-9a-f]{20}$/.test(id || "") || !folder || !uid) return send(res, 400, { error: "Petición no válida" });
    const targetId = existingId && /^[\w.:-]{1,80}$/.test(existingId) ? existingId : id;
    const { data: existing } = await sb.from(TABLE).select("data").eq("collection", "expenses").eq("id", targetId).maybeSingle();
    if (existing && existing.data.assetId) return send(res, 200, { status: "duplicate" });

    const raw = await withImap(async client => {
      const lock = await client.getMailboxLock(folder);
      try { const m = await client.fetchOne(String(uid), { source: true }, { uid: true }); return m && m.source; } finally { lock.release(); }
    });
    if (!raw) return send(res, 404, { error: "No se encontró el correo" });
    const mail = await simpleParser(raw);
    const pdf = (mail.attachments || []).find(isPdf);
    let pdfText = "";
    if (pdf) { try { pdfText = (await pdfParse(pdf.content, { max: 3 })).text.slice(0, 14000); } catch {} }
    const { data: prof } = await sb.from(TABLE).select("data").eq("collection", "settings").eq("id", "profile").maybeSingle();
    const f = await extract(prof?.data || {}, mail, pdfText);
    if (f.is_invoice === false && !existing) return send(res, 200, { status: "skipped" });

    let assetId = "", assetName = "";
    if (pdf) {
      const path = `gastos/${targetId}.pdf`;
      const up = await sb.storage.from(BUCKET).upload(path, pdf.content, { contentType: "application/pdf", upsert: true });
      if (up.error) throw Object.assign(new Error("No se pudo guardar el PDF: " + up.error.message), { status: 500 });
      assetId = path; assetName = pdf.filename || "factura.pdf";
    }
    const all = `${pdfText}\n${mail.text || ""}`;
    const cur = String(f.currency || "EUR").toUpperCase();
    let region = f.region || (EU.test(all) ? "UE" : f.reverse_charge ? "EXT" : "ES");
    const reverse = region !== "ES" ? true : !!f.reverse_charge;
    const addr = (mail.from?.value?.[0]?.address || "").toLowerCase();
    const fresh = {
      date: /^\d{4}-\d{2}-\d{2}$/.test(f.date || "") ? f.date : (mail.date || new Date()).toISOString().slice(0, 10),
      supplier: String(f.supplier || "").slice(0, 120), cif: f.cif || (all.match(EU) || [""])[0], number: f.number || "", concept: String(f.concept || "").slice(0, 120),
      category: CATS.includes(f.category) ? f.category : "Otros", region,
      base: r2(f.base), vat: reverse ? 0 : (+f.vat_rate || 0), vatAmount: reverse ? 0 : (f.vat_amount != null ? r2(f.vat_amount) : null),
      irpf: +f.irpf_rate || 0, deductiblePct: 100, deductible: true, reverseCharge: reverse, paid: true, paidDate: null,
      currency: cur, originalAmount: cur !== "EUR" ? String(f.total ?? "") : "",
    };
    let doc;
    if (existing) {
      const e = existing.data;
      doc = { ...e, assetId: assetId || e.assetId || "", assetName: assetName || e.assetName || "" };
      if (!(+e.base) && fresh.base) {
        if (fresh.currency === "EUR") Object.assign(doc, { base: fresh.base, vat: e.reverseCharge ? 0 : fresh.vat, vatAmount: e.reverseCharge ? 0 : fresh.vatAmount });
        else Object.assign(doc, { currency: fresh.currency, originalAmount: fresh.originalAmount || String(fresh.base) });
      }
      Object.assign(doc, { number: e.number || fresh.number, cif: e.cif || fresh.cif });
      doc.needsReview = true; doc.reviewNote = "Importes completados con el PDF del correo: revísalos y guarda."; doc.updatedAt = new Date().toISOString();
      const up = await sb.from(TABLE).update({ data: doc }).eq("collection", "expenses").eq("id", targetId);
      if (up.error) throw Object.assign(new Error(up.error.message), { status: 500 });
      return send(res, 200, { status: "imported", completed: true, hasPdf: !!pdf });
    }
    doc = { ...fresh, assetId, assetName, source: "correo", mailAddr: addr, mailSubject: mail.subject || "", mailDate: (mail.date || new Date()).toISOString(),
      needsReview: true, reviewNote: f.noAi ? "Importes leídos automáticamente del PDF: revísalos y guarda." : "Revisa los importes y guarda.", importedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const ins = await sb.from(TABLE).insert({ collection: "expenses", id, data: doc });
    if (ins.error) throw Object.assign(new Error("No se pudo guardar el gasto: " + ins.error.message), { status: 500 });
    send(res, 200, { status: "imported", hasPdf: !!pdf });
  } catch (e) {
    send(res, e.status || 500, { error: e.message || "Error", code: e.code });
  }
}
