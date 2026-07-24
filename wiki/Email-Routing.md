# Email Routing

Point Cloudflare Email Routing at **your** CRM Worker.

- **Ideal:** Email Routing owns the zone apex (Cloudflare’s documented happy path).
- **If Proton/etc. already owns root MX:** use a subdomain (e.g. `crm.example.com`)
  for CRM addresses. The dashboard may still say Email Routing is “disabled” for
  the zone — subdomain MX still delivers to a Worker in practice. Longer-term,
  move aliases off the apex so Cloudflare can own the root cleanly.
- **Free / default outbound:** Worker does **not** send mail. Agents mailto +
  CC/BCC the CRM inbound address so replies land as ticket notes.
- **Optional Worker send:** Settings → Sites → “Send email from Worker” (off by
  default). Requires Cloudflare Email Sending on a Workers paid account, verified
  sender domain, and `[[send_email]] name = "EMAIL"` in wrangler. The Worker
  cannot detect paid entitlement by itself.

Guide: https://crm.ackvyn.org/docs/email-routing.html
