# Free tier & Worker usage

Canonical page: https://crm.ackvyn.org/docs/free-tier.html

Aimed at Cloudflare Workers Free (including the usual 100,000 requests/day per
Worker — verify current [limits](https://developers.cloudflare.com/workers/platform/limits/)).

Like [Sveltia CMS](https://sveltiacms.app/en/): auth Worker + browser commits to
GitHub for day-to-day CRM edits (tickets, contacts, Documents). Live chat,
inbound email, visitor intake, and e-sign share sessions still go through your
CRM Worker. Design goal: keep that surface small so Free-plan headroom stays
realistic; mileage varies with traffic and other Workers on the account.

Product story: https://crm.ackvyn.org/site/why.html
