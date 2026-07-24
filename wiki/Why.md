# Why

Canonical page: https://crm.ackvyn.org/site/why.html

Origin: static-site + git CMS workflows (Sveltia-shaped) already work; live chat
and light CRM were the missing open piece. Tawk and similar remain strong SaaS
options; Ackvyn CRM is the in-house, git-based alternative.

Also aimed at people with a free Cloudflare account for their domain: maximize
client-side work (console CRUD → GitHub like Sveltia), keep email + live chat on
the Worker, and design to stay within Workers Free request headroom (~100k/day)
when traffic is modest. Practical notes:
https://crm.ackvyn.org/docs/free-tier.html
