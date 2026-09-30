# agutidesigns Gestión

Facturación y contabilidad de autónomo (Alejandro Gutiérrez Gómez): facturas, presupuestos, recurrentes, rectificativas, gastos con PDF, contactos, productos, tesorería e impuestos (303, 130, 111, 349).

- Front: `index.html` (sin build). Datos en Supabase (tablas `au_docs`, bucket `au-facturas`).
- Importar gastos del correo: `api/mail/*` por IMAP de Gmail.

## Variables en Vercel
SUPABASE_URL, SUPABASE_ANON_KEY, IMAP_HOST=imap.gmail.com, IMAP_PORT=993, IMAP_USER=agutierrezgomez00@gmail.com, IMAP_PASSWORD (contraseña de aplicación de Google, Sensitive), IMAP_FOLDERS=INBOX. Opcional: ANTHROPIC_API_KEY.
