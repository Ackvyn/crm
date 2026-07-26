# What is Ackvyn CRM?

Canonical page: https://crm.ackvyn.org/site/what-is.html

Ackvyn CRM is an open, portable CRM + live chat stack for static / git-hosted
sites: CDN GUI, your own Cloudflare Worker for the API, encrypted records in
`crm-data/` (contacts, tickets, Documents library, and more).

It covers the connected workflow from live website chat and intake, through
tickets and contact history, to document storage and revocable PDF e-sign share
links. Completed PDFs include visual signing, audit hashes, a per-site
self-signed PKCS#7 integrity seal, and a DigiCert RFC 3161 timestamp. The
timestamp is independently trusted proof of completion time; the site
certificate is not a public-CA or qualified signer credential.
