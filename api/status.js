import { send, authUser, imapConfigured } from "../lib/common.js";
export default async function handler(req, res) {
  try { await authUser(req); send(res, 200, { imap: imapConfigured(), ai: !!process.env.ANTHROPIC_API_KEY, mailbox: process.env.IMAP_USER || "" }); }
  catch (e) { send(res, e.status || 500, { error: e.message }); }
}
