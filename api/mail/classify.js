import { send, authUser, withImap, readJson } from "../../lib/common.js";
import { simpleParser } from "mailparser";
import { pdfText } from "../../lib/pdftext.js";
import { extractInvoiceLinks } from "../../lib/links.js";
import { classifyPdf, classifyLinkMail } from "../../lib/classify.js";
import { hasAI, aiClassify } from "../../lib/ai.js";

const TABLE = "au_docs";
const V = hasAI() ? 5 : 3; // versión de las reglas: si cambia, se vuelven a revisar los correos

async function streamToBuf(s) { const chunks = []; for await (const c of s) chunks.push(c); return Buffer.concat(chunks); }

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Usa POST" });
  try {
    const { sb } = await authUser(req);
    const { items } = await readJson(req);
    if (!Array.isArray(items) || !items.length || items.length > 8) return send(res, 400, { error: "Envía entre 1 y 8 correos" });
    const acct = +items[0].acct || 0;
    const ids = items.map(i => String(i.id)).filter(id => /^imap-[0-9a-f]{20}$/.test(id));
    const { data: cached } = await sb.from(TABLE).select("id,data").eq("collection", "mailcheck").in("id", ids);
    const cache = Object.fromEntries((cached || []).filter(r => r.data.v === V).map(r => [r.id, r.data]));
    const { data: prof } = await sb.from(TABLE).select("data").eq("collection", "settings").eq("id", "profile").maybeSingle();
    const profile = prof?.data || {};
    const { data: invs } = await sb.from(TABLE).select("data").eq("collection", "invoices");
    const own = new Set((invs || []).map(r => String(r.data.number || "").toUpperCase()).filter(Boolean));

    const { data: rules } = await sb.from(TABLE).select("id,data").eq("collection", "senders");
    const senderRule = Object.fromEntries((rules || []).map(r => [r.data.addr, r.data.rule]));
    const todo = items.filter(i => !cache[i.id] && ids.includes(i.id));
    const results = {};
    const gathered = [];
    for (const it of todo) {
      const rule = senderRule[String(it.addr || "").toLowerCase()];
      if (rule === "block") results[it.id] = { ok: false, reason: "Remitente marcado por ti como «no es factura»", v: V };
    }
    const pending = todo.filter(it => !results[it.id]);
    if (pending.length) {
      await withImap(async client => {
        for (const it of pending) {
          let lock;
          try {
            lock = await client.getMailboxLock(it.folder);
            const g = { it, pdfs: [], text: "", links: [], subject: it.subject || "", from: it.addr || "" };
            for (const p of (it.parts || []).slice(0, 5)) {
              try {
                const dl = await client.download(String(it.uid), p.part, { uid: true, maxBytes: 8 * 1024 * 1024 });
                const buf = await streamToBuf(dl.content);
                let text = ""; try { text = await pdfText(buf, 2); } catch {}
                g.pdfs.push({ name: p.name, buf, text });
              } catch {}
            }
            const m = await client.fetchOne(String(it.uid), { source: { start: 0, maxLength: 300000 } }, { uid: true });
            const parsed = await simpleParser(m.source);
            g.text = parsed.text || ""; g.subject = parsed.subject || g.subject; g.from = parsed.from?.text || g.from;
            if (!g.pdfs.length) g.links = extractInvoiceLinks(parsed.html || parsed.textAsHtml || "", parsed.text || "");
            gathered.push(g);
          } catch { results[it.id] = { ok: false, reason: "No se pudo revisar este correo", error: true }; }
          finally { if (lock) lock.release(); }
        }
      }, acct);
      const ownList = [...own];
      await Promise.all(gathered.map(async g => {
        const rule = senderRule[String(g.it.addr || "").toLowerCase()];
        let r = null;
        if (hasAI()) {
          try { r = await aiClassify({ profile, ownNumbers: ownList, subject: g.subject, from: g.from, text: g.text, pdfs: g.pdfs, links: g.links, senderRule: rule }); } catch (e) { console.error("aiClassify", e.message); }
        }
        if (!r) {
          if (g.pdfs.length) {
            const good = [], bad = [];
            for (const p of g.pdfs) { const v = classifyPdf(p.text, p.name, profile, own); (v.ok ? good : bad).push({ name: p.name, reason: v.reason, total: v.total ?? null }); }
            r = good.length ? { ok: true, reason: good[0].reason, files: good.map(x => x.name), total: good[0].total } : { ok: false, reason: bad[0]?.reason || "Sin facturas" };
          } else r = classifyLinkMail({ subject: g.subject, from: g.from, text: g.text, links: g.links });
        }
        results[g.it.id] = { ...r, links: g.links, v: V };
      }));
      const rows = Object.entries(results).filter(([, r]) => !r.error).map(([id, data]) => ({ collection: "mailcheck", id, data }));
      if (rows.length) await sb.from(TABLE).upsert(rows);
    }
    send(res, 200, { results: { ...cache, ...results } });
  } catch (e) {
    send(res, e.status || 500, { error: e.message || "Error", code: e.code });
  }
}
