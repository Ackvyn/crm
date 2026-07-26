# Documents & e-sign

Canonical page: https://crm.ackvyn.org/docs/documents.html

Encrypted Documents library in `crm-data/{site}/documents/` (folders, PDF field
placement). Share-link e-sign runs on your CRM Worker; completed signed PDFs
attach to tickets. Save to Documents (with optional contact + audit) to keep a
copy after the ticket is deleted. Contact detail lists signed docs (deduped).

## PDF preparation

- Place signature, initials, name, date, number, text, checkbox, dropdown, and
  white-out fields.
- Shift-peek native PDF text and unmapped AcroForm controls. Selected text can
  become one or more editable fields while retaining its position and available
  font styling.
- White-out removes covered text and unmapped widgets structurally, while every
  field receives an opaque base so old document content does not interfere.
- Duplicate fields, adjust their relative layer order, resize with collision
  stops, and control text size, line spacing, wrapping, alignment, color, and
  stamp labels.
- Download creates active AcroForm widgets for writable fields. Signature and
  initials use standard `/FT /Sig`; number is a `/Tx` field whose numeric-only
  behavior is enforced by Ackvyn CRM during signing.
- **Overwrite source** permanently bakes locked values and white-outs into the
  library PDF while preserving writable controls as fillable widgets.

## Share-link workflow

1. Create a signing session for a contact and ticket.
2. Send the generated URL; the public signer completes required fields.
3. Revoke any pending request from the link dialog or its ticket activity.
4. On completion, the signed PDF and audit record attach to the ticket.
5. Save the attachment to Documents when it should outlive the ticket.

## Cryptographic completion record

Completed PDFs contain:

1. Visual signature/initials ink and the completed field values.
2. A PKCS#7 (`adbe.pkcs7.detached`) integrity seal made with an RSA-2048,
   self-signed certificate generated once per CRM site.
3. A DigiCert RFC 3161 `DocTimeStamp` over the sealed PDF. The TSA receives only
   a SHA-256 document hash and supplies an independently trusted completion
   time.
4. Ticket audit metadata: before/after SHA-256 hashes, signer/session details,
   site-certificate fingerprint, timestamp time/serial, and verification URLs.

The timestamp proves **when the final bytes existed**. It does not turn the
self-signed site certificate into a globally trusted signer identity. This is
not an AATL/EUTL certificate or qualified electronic signature (QES).

## Public verification

```text
GET  /v1/{site}/sign/cert
POST /v1/{site}/sign/verify
```

`/sign/cert` returns the site's public PEM and SHA-256 fingerprint.
`/sign/verify` accepts `{ "pdfBase64": "..." }`, checks the PKCS#7 site seal,
and validates RFC 3161 timestamps against the covered PDF bytes. New signed
documents should return `fullyVerified: true`; legacy sealed documents without
a trusted timestamp can still pass `siteSeal`.

If the public TSA is temporarily unavailable, Ackvyn keeps the completed PDF
with its valid site seal and reports the timestamp failure rather than
discarding the signer’s work.
