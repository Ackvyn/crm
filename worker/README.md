# Ackvyn CRM Worker

**API-only** Cloudflare Worker for [Ackvyn CRM](https://crm.ackvyn.org/).

This directory is the **Deploy to Cloudflare** project. Cloudflare clones
**only this folder** from [Ackvyn/crm](https://github.com/Ackvyn/crm) into your
GitHub account, reads `wrangler.toml` here, provisions the Durable Object, and
wires Workers Builds. It does **not** use the monorepo root (that root has no
committed `wrangler.toml` — maintainers keep a private local one).

GUI / docs / `console.js` / `embed.js` CDN: https://crm.ackvyn.org/

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Ackvyn/crm/tree/main/worker)

After it finishes:

1. Edit vars (`ALLOWED_SITE_ORIGINS`, `CRM_GIT_REPO`, `CRM_INBOUND_EMAIL_SITE`,
   `AUTH_WORKER_URL` → **your** auth Worker).
2. Add secrets — **leave blank in the Deploy UI**; paste your own values:

```bash
npx wrangler secret put GITHUB_TOKEN
# your PAT with Contents access to CRM_GIT_REPO

npx wrangler secret put CRM_DATA_PASSPHRASE
# long random string (not a short password). Generate:
#   https://crm.ackvyn.org/site/worker.html#passphrase
#   openssl rand -base64 32
```

3. Point your operator site’s CRM console at this Worker
   (`data-api` / Settings) and set client embeds
   `data-crm="https://YOUR-SUBDOMAIN.workers.dev"`.

Full guide: https://crm.ackvyn.org/docs/worker-setup.html  
Auth: https://crm.ackvyn.org/docs/auth.html

### Manual Git connect (same template)

If you import `Ackvyn/crm` in the Cloudflare dashboard instead of the button,
set **Root directory** to `worker` so Builds uses this `wrangler.toml`. Connecting
the repo root will fail (no public wrangler config there).

## CLI from this folder

```bash
git clone https://github.com/Ackvyn/crm.git
cd crm/worker
npm install
# Edit wrangler.toml [vars]
npx wrangler deploy
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put CRM_DATA_PASSPHRASE
```

## What’s included

| Path | Role |
| --- | --- |
| `src/` | Full Worker + Durable Object API |
| `static/` | Optional `embed.js` / `reviews-embed.js` on the Worker hostname |
| `wrangler.toml` | DO bindings, crons, placeholder vars (no secrets / no account_id) |
| `.dev.vars.example` | Secret **names** only — values intentionally empty |

Maintainers: edit `../src/` then run `../scripts/sync-worker-template.sh` before
publishing so this folder stays in sync.
