import { send, authUser, withImap, folders, accounts } from "../../lib/common.js";
import crypto from "node:crypto";

const KEYWORDS = /(factura|invoice)/i;
const WORDS = String(process.env.MAIL_KEYWORDS || "factura,invoice").split(",").map(s => s.trim()).filter(Boolean);
const gdate = d => d.replace(/-/g, "/");

async function mailboxesFor(client, account) {
  if (/gmail\.com$/i.test(account.host)) {
    try { const list = await client.list(); const allBox = list.find(b => b.specialUse === "\\All"); if (allBox) return [allBox.path]; } catch {}
  }
  return folders();
}

function pdfParts(node, out = []) {
  if (!node) return out;
  const type = `${node.type || ""}`.toLowerCase();
  const name = `${node.dispositionParameters?.filename || node.parameters?.name || ""}`;
  if (type === "application/pdf" || /\.pdf$/i.test(name) || (type === "application/octet-stream" && /\.pdf$/i.test(name))) out.push({ part: node.part || "1", name: name || "documento.pdf" });
  (node.childNodes || []).forEach(c => pdfParts(c, out));
  return out;
}

export default async function handler(req, res) {
  try {
    await authUser(req);
    const url = new URL(req.url, "http://x");
    const from = url.searchParams.get("from"); // AAAA-MM-DD
    const to = url.searchParams.get("to");     // AAAA-MM-DD (exclusivo)
    const all = url.searchParams.get("all") === "1";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from || "") || !/^\d{4}-\d{2}-\d{2}$/.test(to || "")) return send(res, 400, { error: "Fechas no válidas" });
    const own = accounts().map(a => a.user.toLowerCase());
    const items = []; const errors = [];
    for (let acct = 0; acct < Math.max(1, accounts().length); acct++) {
    try { items.push(...await withImap(async (client, account) => {
      const out = [];
      for (const folder of await mailboxesFor(client, account)) {
        let lock;
        try { lock = await client.getMailboxLock(folder); } catch { continue; }
        try {
          const range = { since: new Date(from + "T00:00:00Z"), before: new Date(to + "T00:00:00Z") };
          const words = WORDS.map(w => `"${w}"`).join(" OR ");
          let uids;
          if (all) uids = await client.search(range, { uid: true });
          else if (/gmail\.com$/i.test(account.host)) uids = await client.search({ gmraw: `(${words}) after:${gdate(from)} before:${gdate(to)}` }, { uid: true });
          else uids = await client.search({ ...range, or: WORDS.flatMap(w => [{ subject: w }, { body: w }]) }, { uid: true });
          if (!uids || !uids.length) continue;
          const msgs = [];
          for await (const m of client.fetch(uids.slice(-300), { envelope: true, bodyStructure: true, internalDate: true }, { uid: true })) msgs.push(m);
          for (const m of msgs) {
            const env = m.envelope || {};
            const sender = (env.from && env.from[0]) || {};
            const addr = (sender.address || "").toLowerCase();
            if (own.includes(addr)) continue;
            const parts = pdfParts(m.bodyStructure);
            const subject = env.subject || "";
            const key = env.messageId || `${folder}:${client.mailbox.uidValidity}:${m.uid}`;
            out.push({
              id: "imap-" + crypto.createHash("sha1").update(key).digest("hex").slice(0, 20),
              folder, uid: m.uid,
              date: (env.date || m.internalDate || new Date()).toISOString(),
              sender: sender.name ? `${sender.name} <${addr}>` : addr, addr,
              subject, hasPdf: parts.length > 0, parts, attachments: parts.map(p => p.name), acct, mailbox: account.user,
            });
          }
        } finally { lock.release(); }
      }
      return out;
    }, acct)); } catch (e) { if (e.code === "imap_not_configured") throw e; errors.push(e.message); }
    }
    if (!items.length && errors.length) throw Object.assign(new Error(errors.join(" ")), { status: 502, code: "imap_login" });
    items.sort((a, b) => b.date.localeCompare(a.date));
    send(res, 200, { items, warnings: errors });
  } catch (e) {
    send(res, e.status || 500, { error: e.message || "Error", code: e.code });
  }
}
