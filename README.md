# Ackvyn CRM

**This CDN hosts the GUI and docs. You deploy your own Worker for the API.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE.txt)

Same idea as [Sveltia CMS](https://sveltiacms.app/en/): marketing site + wiki on
the product domain; each operator runs a Cloudflare Worker on *their* account.
Nobody shares another operator’s Worker.

- **CDN / docs:** https://crm.ackvyn.org/site/
- **What is:** https://crm.ackvyn.org/site/what-is.html
- **Why:** https://crm.ackvyn.org/site/why.html
- **Worker:** https://crm.ackvyn.org/site/worker.html
- **Repo:** https://github.com/Ackvyn/crm
- **License:** [MIT](LICENSE.txt) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)
The admin console is a CDN JavaScript file (`cdn/console.js`) — same idea as
Sveltia’s `sveltia-cms.js`. You host a thin HTML page on your site that loads
it (see [Auth](docs/auth.html)). It is not a public top-nav destination.

## Quick start

1. [Deploy your Worker](worker.html) ([setup guide](docs/worker-setup.html) — Deploy to Cloudflare button or Wrangler).
2. Set up [Auth & GitHub OAuth](docs/auth.html), then add a `/crm/` page on your site that loads `cdn/console.js` with your `data-api` / `data-auth`.
3. Create a site key; allow your client origins.
4. Paste embeds on client sites — `src` from this CDN (`cdn/embed.js`), `data-crm` = **your** Worker.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Ackvyn/crm/tree/main/worker)

## Client embed

```html
<script
  src="https://crm.ackvyn.org/cdn/embed.js"
  data-site="your-site-key"
  data-crm="https://YOUR-SUBDOMAIN.workers.dev"
  data-mode="float"
  async
></script>
```

| Attribute | Meaning |
| --- | --- |
| `src` | GUI script on this CDN |
| `data-crm` | Your Worker origin (API) |
| `data-site` | Site key on your hub |

## Layout

| Path | Role |
| --- | --- |
| `site/` | Marketing pages + `styles.css` (live under `/site/`) |
| `cdn/` | `console.js`, `console.css`, embeds, showcase (live under `/cdn/`) |
| `docs/`, `wiki/` | Product docs (HTML + markdown mirrors) |
| `console/` | Optional thin HTML demo shell |
| `scripts/` | Build / sync / deploy helpers (+ published `passphrase-gen.js`) |
| `worker/` | **Deploy-to-Cloudflare package** (`wrangler.toml` + `src/` — what the button clones) |
| `open-redact/` | WASM assets for structural white-out |

Root stays lean (README / license / GH Pages `CNAME`); old marketing URLs
redirect into `/site/`. Live script URLs are under `/cdn/`.

This GitHub repo is the **public CDN / docs / Worker template** surface only
(same idea as shipping a built site, not the full maintainer monorepo).
Admin UI source (`app/`) and the maintainer Worker checkout live on the
operator machine; `./scripts/deploy-cdn.sh --push` publishes the build tree.

## Product pages

| Page | Topic |
| --- | --- |
| [What is Ackvyn CRM?](https://crm.ackvyn.org/site/what-is.html) | Product definition |
| [Why](https://crm.ackvyn.org/site/why.html) | Origin, static workflows, Tawk |
| [Worker](https://crm.ackvyn.org/site/worker.html) | Deploy your API Worker |

## Docs

Wiki is baked into the site under [`docs/`](docs/) (same idea as product docs on the marketing domain):

| Guide | Topic |
| --- | --- |
| [Getting started](docs/getting-started.html) | Operator checklist |
| [Worker setup](docs/worker-setup.html) | Deploy button, secrets, vars |
| [Auth & OAuth](docs/auth.html) | GitHub OAuth; console from operator site |
| [Email routing](docs/email-routing.html) | Cloudflare Email → Worker |
| [Embeds](docs/embeds.html) | Script tags |
| [Reviews](docs/reviews.html) | Public reviews JSON |
| [Analytics](docs/analytics.html) | GA4 setup for console Analytics |
| [Documents & e-sign](docs/documents.html) | Library, folders, PDF fields, share links |
| [Config](docs/config.html) | Attributes & git layout |

GitHub `wiki/` mirrors those pages; prefer the HTML docs for links.

## Develop

Maintainer checkout (full source on your machine — not published to this repo):

```bash
# Admin UI
npm install --prefix app && npm run dev --prefix app

# Sync embed scripts to CDN root + worker/static
./scripts/sync-site-embeds.sh
./scripts/sync-worker-template.sh

# Build console.js and force-push the public CDN tree only
./scripts/deploy-cdn.sh --push

# Worker (operators: use worker/ — Deploy button or cd worker && npm i && npx wrangler deploy)
# Maintainers only (local wrangler.toml is gitignored):
cp wrangler.example.toml wrangler.toml   # edit account_id + vars
npm install && npm run deploy
```

## Git data (on your Pages/git repo)

```
crm-data/{site}/
  contacts.json.enc
  tickets.json.enc
  macros.json.enc
  branding.json.enc
  visitors.json.enc
  documents/
    manifest.json.enc
    {id}.enc
  reviews.json          # public
```

## License

[MIT](LICENSE.txt) — see also [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
