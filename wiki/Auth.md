# Auth & OAuth

The CRM Worker is API-only. GitHub OAuth lives on a separate auth Worker you
point at with `AUTH_WORKER_URL` — often the same one you already use for a
git-based CMS.

Open the console from a private authenticated page on your site (iframe or
link), not from the public CDN nav.

Canonical guide: https://crm.ackvyn.org/docs/auth.html

See also: [Worker](https://crm.ackvyn.org/site/worker.html) · [Worker setup](https://crm.ackvyn.org/docs/worker-setup.html)
