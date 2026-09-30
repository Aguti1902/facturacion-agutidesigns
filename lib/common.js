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

export function imapConfigured() {
  return !!(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASSWORD);
}

export async function withImap(fn) {
  if (!imapConfigured()) throw Object.assign(new Error("Falta configurar el correo (IMAP_HOST, IMAP_USER, IMAP_PASSWORD) en Vercel"), { status: 412, code: "imap_not_configured" });
  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT || 993),
    secure: String(process.env.IMAP_SECURE || "true") !== "false",
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASSWORD },
    logger: false,
    socketTimeout: 45000,
  });
  try {
    await client.connect();
  } catch (e) {
    throw Object.assign(new Error("No se pudo entrar en el correo: revisa servidor, usuario y contraseña IMAP"), { status: 502, code: "imap_login" });
  }
  try { return await fn(client); } finally { try { await client.logout(); } catch {} }
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
