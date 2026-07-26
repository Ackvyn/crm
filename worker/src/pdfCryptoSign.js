/**
 * Cryptographic PDF sealing for Ackvyn CRM e-sign.
 *
 * Visual ink (drawn/typed signature PNGs) is still applied client-side.
 * After complete, the Worker adds a document-level PKCS#7 / ByteRange
 * signature (adbe.pkcs7.detached) so Acrobat/Edge show a real digital
 * signature panel — same mechanism as mainstream e-sign tools.
 *
 * Caveats (intentional):
 * - Certificate is self-signed per CRM site (not a public CA / not QES).
 *   Viewers will warn "identity could not be verified" against global trust
 *   stores — same as any self-signed TLS cert.
 * - Trust for operators is the site public cert at /sign/cert and the
 *   /sign/verify endpoint (integrity + cert match against this site).
 * - Private key never leaves the Durable Object.
 */

import forge from "node-forge";
import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { SignPdf } from "@signpdf/signpdf";
import { P12Signer } from "@signpdf/signer-p12";
import { PDFDocument } from "pdf-lib";
import {
  extractTimestamps,
  KNOWN_TSA_URLS,
  timestampPdf,
  verifyTimestamp,
} from "pdf-rfc3161";

/** Internal P12 password — DO storage only, not a user-facing secret. */
const P12_PASS = "ackvyn-esign-v1";
/** DigiCert's public RFC 3161 endpoint; authority time is independent of Worker time. */
const TRUSTED_TSA_URL = KNOWN_TSA_URLS.DIGICERT;

/**
 * @param {import('node-forge').pki.Certificate} cert
 */
function certFingerprintSha256(cert) {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const md = forge.md.sha256.create();
  md.update(der);
  return md.digest().toHex();
}

/**
 * Ensure this site has a durable self-signed signing identity.
 * @param {{ exec: Function }} sql
 * @param {string} siteKey
 */
export function ensureSigningIdentity(sql, siteKey) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS signing_identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cert_pem TEXT NOT NULL,
      p12_b64 TEXT NOT NULL,
      passphrase TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      common_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const row = sql.exec(`SELECT * FROM signing_identity WHERE id = 1`).toArray()[0];
  if (row) {
    return {
      certPem: String(row.cert_pem),
      p12: Buffer.from(String(row.p12_b64), "base64"),
      passphrase: String(row.passphrase || P12_PASS),
      fingerprint: String(row.fingerprint),
      commonName: String(row.common_name),
      createdAt: String(row.created_at),
    };
  }

  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = Date.now().toString(16) + Math.floor(Math.random() * 1e6).toString(16);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
  const cn = `Ackvyn CRM E-Sign (${String(siteKey || "site").slice(0, 40)})`;
  const attrs = [
    { name: "commonName", value: cn },
    { name: "organizationName", value: "Ackvyn CRM" },
    { shortName: "OU", value: "Self-signed e-sign seal" },
    { name: "countryName", value: "US" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    {
      name: "keyUsage",
      digitalSignature: true,
      nonRepudiation: true,
      critical: true,
    },
    {
      name: "extKeyUsage",
      emailProtection: true,
      clientAuth: true,
    },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(
    keys.privateKey,
    [cert],
    P12_PASS,
    { algorithm: "3des" },
  );
  const p12Der = forge.asn1.toDer(p12Asn1).getBytes();
  const p12B64 = Buffer.from(p12Der, "binary").toString("base64");
  const certPem = forge.pki.certificateToPem(cert);
  const fingerprint = certFingerprintSha256(cert);
  const createdAt = new Date().toISOString();

  sql.exec(
    `INSERT INTO signing_identity
      (id, cert_pem, p12_b64, passphrase, fingerprint, common_name, created_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)`,
    certPem,
    p12B64,
    P12_PASS,
    fingerprint,
    cn,
    createdAt,
  );

  return {
    certPem,
    p12: Buffer.from(p12B64, "base64"),
    passphrase: P12_PASS,
    fingerprint,
    commonName: cn,
    createdAt,
  };
}

/**
 * Add a document-level PKCS#7 seal after visual ink is already baked.
 * @param {Uint8Array|Buffer} pdfBytes
 * @param {ReturnType<typeof ensureSigningIdentity>} identity
 * @param {{ name?: string, reason?: string, location?: string, contactInfo?: string }} meta
 * @returns {Promise<Uint8Array>}
 */
export async function cryptoSealPdf(pdfBytes, identity, meta = {}) {
  const buf = Buffer.isBuffer(pdfBytes)
    ? pdfBytes
    : Buffer.from(pdfBytes);
  const name = String(meta.name || "Signer").slice(0, 120);
  const pdfDoc = await PDFDocument.load(buf);
  pdflibAddPlaceholder({
    pdfDoc,
    reason: String(
      meta.reason ||
        `Electronically signed by ${name} via Ackvyn CRM (self-signed site seal)`,
    ).slice(0, 200),
    contactInfo: String(meta.contactInfo || "").slice(0, 160),
    name,
    location: String(meta.location || "Ackvyn CRM").slice(0, 120),
  });
  const withPh = Buffer.from(
    await pdfDoc.save({ useObjectStreams: false }),
  );
  const signer = new P12Signer(identity.p12, {
    passphrase: identity.passphrase,
  });
  const signed = await new SignPdf().sign(withPh, signer);
  return signed instanceof Uint8Array
    ? signed
    : new Uint8Array(signed);
}

/**
 * Append a DigiCert-backed RFC 3161 DocTimeStamp after the site PKCS#7 seal.
 * This does not make the self-signed signer identity globally trusted; it adds
 * independently trusted proof of when the sealed bytes existed.
 *
 * @param {Uint8Array|Buffer} pdfBytes
 * @param {{ siteKey?: string, contactInfo?: string }} meta
 */
export async function addTrustedTimestamp(pdfBytes, meta = {}) {
  const result = await timestampPdf({
    pdf:
      pdfBytes instanceof Uint8Array
        ? pdfBytes
        : new Uint8Array(pdfBytes),
    tsa: {
      url: TRUSTED_TSA_URL,
      hashAlgorithm: "SHA-256",
      timeout: 20_000,
      retry: 1,
      retryDelay: 500,
    },
    // The TSA token includes its signing certificate. Avoid best-effort OCSP/
    // CRL network fan-out in the completion request; Acrobat validates the
    // DigiCert chain, while our verify endpoint validates token + document hash.
    enableLTV: false,
    signatureSize: 16_384,
    signatureFieldName: "AckvynTrustedTimestamp",
    reason: "Trusted RFC 3161 completion timestamp",
    location: `Ackvyn CRM · ${String(meta.siteKey || "site").slice(0, 60)}`,
    contactInfo: String(meta.contactInfo || "https://ackvyn.org").slice(0, 160),
  });
  return {
    pdf: result.pdf,
    genTime: result.timestamp.genTime.toISOString(),
    policy: result.timestamp.policy,
    serialNumber: result.timestamp.serialNumber,
    hashAlgorithm: result.timestamp.hashAlgorithm,
    tsaUrl: TRUSTED_TSA_URL,
  };
}

/**
 * Verify all RFC 3161 DocTimeStamp tokens and their covered PDF bytes.
 * The embedded DigiCert TSA chain remains independently displayable in Acrobat.
 *
 * @param {Uint8Array|Buffer} pdfBytes
 */
export async function verifyTrustedTimestamps(pdfBytes) {
  const pdf =
    pdfBytes instanceof Uint8Array
      ? pdfBytes
      : new Uint8Array(pdfBytes);
  const extracted = await extractTimestamps(pdf);
  const checked = [];
  for (const timestamp of extracted) {
    const verified = await verifyTimestamp(timestamp, {
      pdf,
      strictESSValidation: true,
    });
    checked.push({
      verified: Boolean(verified.verified),
      error: verified.verificationError || null,
      fieldName: verified.fieldName,
      coversWholeDocument: Boolean(verified.coversWholeDocument),
      genTime: verified.info.genTime.toISOString(),
      policy: verified.info.policy,
      serialNumber: verified.info.serialNumber,
      hashAlgorithm: verified.info.hashAlgorithm,
      hasCertificate: Boolean(verified.info.hasCertificate),
    });
  }
  return {
    ok:
      checked.length > 0 &&
      checked.every(
        (item) => item.verified && item.coversWholeDocument,
      ),
    count: checked.length,
    timestamps: checked,
    tsaUrl: TRUSTED_TSA_URL,
  };
}

/**
 * Verify ByteRange integrity + that the PKCS#7 signer matches this site cert.
 * @param {Uint8Array|Buffer} pdfBytes
 * @param {string} trustedCertPem
 */
export function verifySealedPdf(pdfBytes, trustedCertPem) {
  const pdf = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes);
  const latin = pdf.toString("latin1");
  const br = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(latin);
  if (!br) {
    return { ok: false, error: "no_byte_range", hint: "PDF has no cryptographic signature" };
  }
  const range = br.slice(1).map(Number);
  const contentsMatch = /\/Contents\s*<([0-9A-Fa-f\s]+)>/.exec(latin);
  if (!contentsMatch) {
    return { ok: false, error: "no_contents", hint: "Signature Contents missing" };
  }
  const [a, b, c, d] = range;
  if (
    ![a, b, c, d].every((n) => Number.isFinite(n) && n >= 0) ||
    a + b > pdf.length ||
    c + d > pdf.length
  ) {
    return { ok: false, error: "invalid_byte_range" };
  }
  const digestInput = Buffer.concat([
    pdf.subarray(a, a + b),
    pdf.subarray(c, c + d),
  ]);

  let der = Buffer.from(contentsMatch[1].replace(/\s+/g, ""), "hex");
  while (der.length && der[der.length - 1] === 0) {
    der = der.subarray(0, der.length - 1);
  }

  let p7;
  try {
    p7 = forge.pkcs7.messageFromAsn1(
      forge.asn1.fromDer(der.toString("binary")),
    );
  } catch {
    return { ok: false, error: "pkcs7_parse_failed" };
  }
  if (!p7.certificates?.length || !p7.rawCapture?.signature) {
    return { ok: false, error: "pkcs7_incomplete" };
  }

  const signerCert = p7.certificates[0];
  let trusted;
  try {
    trusted = forge.pki.certificateFromPem(trustedCertPem);
  } catch {
    return { ok: false, error: "trusted_cert_invalid" };
  }

  const spkiSigned = forge.asn1
    .toDer(forge.pki.publicKeyToAsn1(signerCert.publicKey))
    .toHex();
  const spkiTrusted = forge.asn1
    .toDer(forge.pki.publicKeyToAsn1(trusted.publicKey))
    .toHex();
  if (spkiSigned !== spkiTrusted) {
    return {
      ok: false,
      error: "cert_mismatch",
      hint: "Signature was not produced by this site's Ackvyn CRM seal",
      signerCn: signerCert.subject.getField("CN")?.value || null,
    };
  }

  const digestOid = p7.rawCapture.digestAlgorithm
    ? forge.asn1.derToOid(p7.rawCapture.digestAlgorithm)
    : forge.pki.oids.sha256;
  const md =
    digestOid === forge.pki.oids.sha512
      ? forge.md.sha512.create()
      : digestOid === forge.pki.oids.sha384
        ? forge.md.sha384.create()
        : forge.md.sha256.create();
  md.update(digestInput.toString("binary"));
  const pdfDigest = md.digest().getBytes();

  let messageDigestBytes = null;
  for (const attr of p7.rawCapture.authenticatedAttributes || []) {
    try {
      const oid = forge.asn1.derToOid(attr.value[0].value);
      if (oid === forge.pki.oids.messageDigest) {
        messageDigestBytes = attr.value[1].value[0].value;
      }
    } catch {
      /* skip attr */
    }
  }
  if (!messageDigestBytes) {
    return { ok: false, error: "no_message_digest" };
  }
  if (messageDigestBytes !== pdfDigest) {
    return {
      ok: false,
      error: "digest_mismatch",
      hint: "PDF bytes were altered after signing",
    };
  }

  const encodedAttrs = forge.asn1
    .toDer(
      forge.asn1.create(
        forge.asn1.Class.UNIVERSAL,
        forge.asn1.Type.SET,
        true,
        p7.rawCapture.authenticatedAttributes,
      ),
    )
    .getBytes();
  const mdAttrs = forge.md.sha256.create();
  mdAttrs.update(encodedAttrs);
  const sigOk = trusted.publicKey.verify(
    mdAttrs.digest().bytes(),
    p7.rawCapture.signature,
  );
  if (!sigOk) {
    return { ok: false, error: "rsa_invalid" };
  }

  return {
    ok: true,
    commonName: signerCert.subject.getField("CN")?.value || null,
    fingerprint: certFingerprintSha256(signerCert),
    byteRange: range,
    caveat:
      "Self-signed site seal — integrity verified against this CRM site, not a public CA.",
  };
}

/**
 * @param {Uint8Array|ArrayBuffer|string} data base64 or bytes
 */
export async function sha256HexOfPdf(data) {
  let bytes;
  if (typeof data === "string") {
    const bin = atob(data.replace(/\s+/g, ""));
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else {
    bytes = data;
  }
  const dig = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(dig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function bytesToBase64(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return buf.toString("base64");
}

export function base64ToBytes(b64) {
  return new Uint8Array(Buffer.from(String(b64 || "").replace(/\s+/g, ""), "base64"));
}
