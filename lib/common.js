import { createClient } from "@supabase/supabase-js";
import { ImapFlow } from "imapflow";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/** Verifica el token de Supabase y que el email esté autorizado. Devuelve un cliente con los permisos del usuario. */
export async function authUser(req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) throw Object.assign(new Error("Falta la sesión"), { status: 401 });
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) throw Object.assign(new Error("Sesión caducada"), { status: 401 });
  const { data: ok } = await sb.rpc("au_is_allowed");
  if (!ok) throw Object.assign(new Error("Este email no tiene acceso"), { status: 403 });
  return { sb, user: data.user };
}

/** Buzones configurados: IMAP_* (principal) e IMAP2_* (opcional, segundo buzón). */
export function accounts() {
  const out = [];
  for (const p of ["IMAP", "IMAP2"]) {
    const user = process.env[p + "_USER"], pass = process.env[p + "_PASSWORD"];
    const host = process.env[p + "_HOST"] || (/@(gmail\.com|googlemail\.com)$/i.test(user || "") ? "imap.gmail.com" : process.env.IMAP_HOST);
    if (user && pass && host) out.push({ host, user, pass: String(pass).replace(/\s+/g, ""), port: Number(process.env[p + "_PORT"] || 993), secure: String(process.env[p + "_SECURE"] || "true") !== "false" });
  }
  return out;
}
export function imapConfigured() { return accounts().length > 0; }

function loginReason(e, user) {
  const t = `${e.responseText || ""} ${e.response || ""} ${e.message || ""} ${e.code || ""}`;
  if (/application-specific password|app password|ALERT.*password/i.test(t)) return `Gmail exige una contraseña de aplicación para ${user} (no la contraseña normal).`;
  if (/AUTHENTICATIONFAILED|Invalid credentials|authentication failed|LOGIN failed/i.test(t) || e.authenticationFailed) return `Usuario o contraseña incorrectos en ${user}. Usa una contraseña de aplicación de Google creada con esa misma cuenta.`;
  if (/IMAP.*(disabled|not enabled)|Web login required|log in via your web browser/i.test(t)) return `Google ha bloqueado el acceso IMAP de ${user}. Entra en Gmail desde el navegador, revisa el aviso de seguridad y vuelve a probar.`;
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timeout/i.test(t)) return `No se pudo conectar con el servidor de correo de ${user}.`;
  return `No se pudo entrar en ${user}: ${(e.responseText || e.message || "error desconocido").slice(0, 160)}`;
}

export async function withImap(fn, acct = 0) {
  const list = accounts();
  if (!list.length) throw Object.assign(new Error("Falta configurar el correo (IMAP_USER e IMAP_PASSWORD) en Vercel"), { status: 412, code: "imap_not_configured" });
  const a = list[acct] || list[0];
  const client = new ImapFlow({ host: a.host, port: a.port, secure: a.secure, auth: { user: a.user, pass: a.pass }, logger: false, socketTimeout: 45000 });
  try { await client.connect(); }
  catch (e) { console.error("IMAP login", a.user, e.responseText || e.message, e.code); throw Object.assign(new Error(loginReason(e, a.user)), { status: 502, code: "imap_login" }); }
  try { return await fn(client, a); } finally { try { await client.logout(); } catch {} }
}

export function readJson(req) {
  return new Promise((ok, ko) => {
    if (req.body && typeof req.body === "object") return ok(req.body);
    let d = ""; req.on("data", c => (d += c)); req.on("end", () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { ko(e); } }); req.on("error", ko);
  });
}

export function folders() {
  return String(process.env.IMAP_FOLDERS || "INBOX").split(",").map(s => s.trim()).filter(Boolean);
}
