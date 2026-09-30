import { send, authUser, withImap, readJson } from "../../lib/common.js";
import { simpleParser } from "mailparser";
import { pdfText as readPdf } from "../../lib/pdftext.js";
import { hasAI, aiExtract } from "../../lib/ai.js";
import { heuristicExtract } from "../../lib/heuristic.js";
import { extractInvoiceLinks, downloadInvoice } from "../../lib/links.js";

const TABLE = "au_docs", BUCKET = "au-facturas";
const CATS = ["Software y suscripciones","Servidores y hosting","Publicidad","Material y equipos","Servicios profesionales","Subcontratación","Formación","Viajes y dietas","Vehículo y transporte","Teléfono e internet","Oficina y suministros","Cuota de autónomos","Seguros","Comisiones bancarias","Otros"];
const EU = /\b(IE|DE|FR|NL|LU|BE|IT|PT|AT|SE|DK|FI|PL|CZ|EE|LT|LV|HU|SK|SI|HR|RO|BG|GR|EL|CY|MT)\d{6,12}[A-Z0-9]*\b/;
const r2 = n => Math.round((+n || 0) * 100) / 100;
const isPdf = a => a.contentType === "application/pdf" || /\.pdf$/i.test(a.filename || "") || (a.content && a.content.slice(0, 4).toString() === "%PDF");

async function extract(profile, mail, pdfText, pdfFile) {
  const fromName = mail.from?.value?.[0]?.name || mail.from?.value?.[0]?.address || "";
  const dateIso = (mail.date || new Date()).toISOString().slice(0, 10);
  const basic = () => ({ ...heuristicExtract({ text: pdfText || mail.text || "", subject: mail.subject || "", fromName, dateIso, companyCif: profile.nif || "" }), noAi: true });
  if (!hasAI()) return basic();
  try { return await aiExtract({ profile, subject: mail.subject || "", from: mail.from?.text || "", text: mail.text || "", pdf: pdfFile ? { name: pdfFile.name, buf: pdfFile.buf, text: pdfText } : null, cats: CATS }); }
  catch (e) { console.error("aiExtract", e.message); return basic(); }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Usa POST" });
  try {
    const { sb } = await authUser(req);
    const { id, folder, uid, existingId, acct, files: onlyFiles } = await readJson(req);
    if (!/^imap-[0-9a-f]{20}$/.test(id || "") || !folder || !uid) return send(res, 400, { error: "Petición no válida" });
    const { data: existingFirst } = existingId && /^[\w.:-]{1,80}$/.test(existingId) ? await sb.from(TABLE).select("data").eq("collection", "expenses").eq("id", existingId).maybeSingle() : { data: null };
    const { data: already } = await sb.from(TABLE).select("id").eq("collection", "expenses").eq("id", id).maybeSingle();
    if (already && !existingFirst) return send(res, 200, { status: "duplicate" });

    const raw = await withImap(async client => {
      const lock = await client.getMailboxLock(folder);
      try { const m = await client.fetchOne(String(uid), { source: true }, { uid: true }); return m && m.source; } finally { lock.release(); }
    }, +acct || 0);
    if (!raw) return send(res, 404, { error: "No se encontró el correo" });
    const mail = await simpleParser(raw);

    // 1) Facturas adjuntas; 2) si no hay, facturas descargables desde los enlaces del correo
    const wanted = Array.isArray(onlyFiles) && onlyFiles.length ? new Set(onlyFiles) : null;
    const files = (mail.attachments || []).filter(isPdf).filter(a => !wanted || wanted.has(a.filename || "documento.pdf") || wanted.has(a.filename)).map(a => ({ buf: a.content, name: a.filename || "factura.pdf", from: "adjunto" }));
    const linkNotes = [];
    if (!files.length) {
      const links = extractInvoiceLinks(mail.html || mail.textAsHtml || "", mail.text || "");
      for (const l of links) {
        const r = await downloadInvoice(l.url);
        if (r.ok) { files.push({ buf: r.buf, name: r.name, from: "enlace", url: l.url }); break; }
        linkNotes.push({ url: l.url, text: l.text, reason: r.reason, login: !!r.login });
      }
    }
    const { data: prof } = await sb.from(TABLE).select("data").eq("collection", "settings").eq("id", "profile").maybeSingle();
    const profile = prof?.data || {};
    const addr = (mail.from?.value?.[0]?.address || "").toLowerCase();
    const mailMeta = { source: "correo", mailAddr: addr, mailSubject: mail.subject || "", mailDate: (mail.date || new Date()).toISOString() };

    const build = async (file) => {
      let pdfText = "";
      if (file) { try { pdfText = (await readPdf(file.buf, 3)).slice(0, 14000); } catch {} }
      const f = await extract(profile, mail, pdfText, file);
      const all = `${pdfText}\n${mail.text || ""}`;
      const cur = String(f.currency || "EUR").toUpperCase();
      const region = f.region || (EU.test(all) ? "UE" : f.reverse_charge ? "EXT" : "ES");
      const reverse = region !== "ES" ? true : !!f.reverse_charge;
      return { f, fresh: {
        date: /^\d{4}-\d{2}-\d{2}$/.test(f.date || "") ? f.date : (mail.date || new Date()).toISOString().slice(0, 10),
        supplier: String(f.supplier || "").slice(0, 120), cif: f.cif || (all.match(EU) || [""])[0], number: f.number || "", concept: String(f.concept || "").slice(0, 120),
        category: CATS.includes(f.category) ? f.category : "Otros", region,
        base: r2(f.base), vat: reverse ? 0 : (+f.vat_rate || 0), vatAmount: reverse ? 0 : (f.vat_amount != null ? r2(f.vat_amount) : null),
        irpf: +f.irpf_rate || 0, deductiblePct: 100, deductible: true, reverseCharge: reverse, paid: true, paidDate: null,
        currency: cur, originalAmount: cur !== "EUR" ? String(f.total ?? "") : "",
      } };
    };
    const upload = async (docId, file) => {
      const path = `gastos/${docId}.pdf`;
      const up = await sb.storage.from(BUCKET).upload(path, file.buf, { contentType: "application/pdf", upsert: true });
      if (up.error) throw Object.assign(new Error("No se pudo guardar el PDF: " + up.error.message), { status: 500 });
      return { assetId: path, assetName: file.name };
    };
    const saved = [];

    if (!files.length) {
      // Sin PDF descargable: solo se registra si hay un enlace de factura que exige iniciar sesión (p. ej. Google Ads)
      const gated = linkNotes.find(n => n.login);
      if (existingFirst) return send(res, 200, { status: "nofile", links: linkNotes });
      if (!gated) return send(res, 200, { status: "nofile", links: linkNotes });
      const { f, fresh } = await build(null);
      if (f.is_invoice === false) return send(res, 200, { status: "skipped" });
      const doc = { ...fresh, ...mailMeta, assetId: "", invoiceUrl: gated.url, needsReview: true, reviewNote: "La factura está tras un enlace que pide iniciar sesión: ábrelo, descarga el PDF, súbelo aquí y revisa la base.", importedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      const ins = await sb.from(TABLE).insert({ collection: "expenses", id, data: doc });
      if (ins.error) throw Object.assign(new Error(ins.error.message), { status: 500 });
      return send(res, 200, { status: "imported", files: [], gated: true });
    }

    for (let k = 0; k < files.length; k++) {
      const file = files[k];
      const { f, fresh } = await build(file);
      if (k === 0 && existingFirst) {
        const e = existingFirst.data; const docId = existingId;
        const a = await upload(docId, file);
        const doc = { ...e, ...a, invoiceUrl: file.url || e.invoiceUrl || "" };
        if (!(+e.base) && fresh.base) {
          if (fresh.currency === "EUR") Object.assign(doc, { base: fresh.base, vat: e.reverseCharge ? 0 : fresh.vat, vatAmount: e.reverseCharge ? 0 : fresh.vatAmount });
          else Object.assign(doc, { currency: fresh.currency, originalAmount: fresh.originalAmount || String(fresh.base) });
        }
        Object.assign(doc, { number: e.number || fresh.number, cif: e.cif || fresh.cif, needsReview: true, reviewNote: "Factura descargada del correo: revisa los importes y guarda.", updatedAt: new Date().toISOString() });
        const up = await sb.from(TABLE).update({ data: doc }).eq("collection", "expenses").eq("id", docId);
        if (up.error) throw Object.assign(new Error(up.error.message), { status: 500 });
        saved.push({ name: file.name, from: file.from, completed: true });
        continue;
      }
      if (f.is_invoice === false && files.length === 1) return send(res, 200, { status: "skipped" });
      const docId = k === 0 ? id : `${id}-${k + 1}`;
      const { data: dup } = await sb.from(TABLE).select("id").eq("collection", "expenses").eq("id", docId).maybeSingle();
      if (dup) continue;
      const a = await upload(docId, file);
      const doc = { ...fresh, ...mailMeta, ...a, invoiceUrl: file.url || "", needsReview: true,
        reviewNote: (f.noAi ? "Importes leídos automáticamente del PDF" : "Importes leídos del PDF") + (file.from === "enlace" ? " (descargado desde el enlace del correo)" : "") + ": revísalos y guarda.",
        importedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      const ins = await sb.from(TABLE).insert({ collection: "expenses", id: docId, data: doc });
      if (ins.error) throw Object.assign(new Error("No se pudo guardar el gasto: " + ins.error.message), { status: 500 });
      saved.push({ name: file.name, from: file.from });
    }
    send(res, 200, { status: "imported", files: saved });
  } catch (e) {
    send(res, e.status || 500, { error: e.message || "Error", code: e.code });
  }
}
