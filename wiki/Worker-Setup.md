# Worker Setup

Deploy your own API Worker (Durable Objects, email, git sync). GUI stays on the CDN.

The **Deploy to Cloudflare** button clones
[`Ackvyn/crm` → `worker/`](https://github.com/Ackvyn/crm/tree/main/worker)
only — that folder’s `wrangler.toml` is the public template. If you connect the
repo manually in Workers Builds, set **Root directory** to `worker`.

Secrets (`GITHUB_TOKEN`, `CRM_DATA_PASSPHRASE`) are **blank** in the template —
paste your own. Passphrase = long random string (generate at
https://crm.ackvyn.org/site/worker.html#passphrase or `openssl rand -base64 32`).

- Product overview: https://crm.ackvyn.org/site/worker.html
- Deploy button + checklist: https://crm.ackvyn.org/docs/worker-setup.html
- Auth & OAuth: https://crm.ackvyn.org/docs/auth.html
- Cloudflare docs: https://developers.cloudflare.com/workers/platform/deploy-buttons/
