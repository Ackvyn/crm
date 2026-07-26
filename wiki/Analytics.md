# Analytics (Google Analytics)

CRM’s **Analytics** panel reads your GA4 property via the Analytics Data API.
The Worker stores an encrypted service-account key and proxies reports for
signed-in agents. You still need the normal GA4 tag on the website to collect
hits.

## Checklist

1. GA4 property collecting on the site.
2. Enable **Google Analytics Data API** in Google Cloud.
3. Create a service account → download JSON key.
4. GA4 Admin → Property access → add the service account email as **Viewer**.
5. Use the numeric **Property ID** (not `G-…` Measurement ID).
6. CRM console → **Settings → Analytics** → paste Property ID + JSON → Save.
7. View **Analytics** in the console (7d / 28d / 90d).

Requires Worker secret `CRM_DATA_PASSPHRASE`.

Live chat “On site” presence is separate (embed + Durable Object), not GA.

Full guide: https://crm.ackvyn.org/docs/analytics.html
