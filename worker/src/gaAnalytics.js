/**
 * GA4 Data API helpers for the CRM Worker.
 * Service-account JWT (Web Crypto) → OAuth access token → runReport.
 * Credentials are encrypted at rest in the site Durable Object.
 */

import { decryptJson, deriveCrmDataKey, encryptJson } from "./crmCrypto.js";

const GA_STORAGE_KEY = "ga_analytics_enc";
const GA_TOKEN_CACHE_KEY = "ga_access_token_cache";
const GA_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const MAX_SA_JSON_BYTES = 16_384;

function b64url(bytesOrStr) {
  const bytes =
    typeof bytesOrStr === "string"
      ? new TextEncoder().encode(bytesOrStr)
      : bytesOrStr instanceof ArrayBuffer
        ? new Uint8Array(bytesOrStr)
        : bytesOrStr;
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pemToArrayBuffer(pem) {
  const b64 = String(pem)
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

/**
 * @param {unknown} raw
 * @param {{ allowMissingSa?: boolean }} [opts]
 * @returns {{ propertyId: string, serviceAccount: object | null, clientEmail: string | null }}
 */
export function parseGaConfigInput(raw, opts = {}) {
  if (!raw || typeof raw !== "object") {
    throw new Error("invalid_body");
  }
  const propertyId = String(raw.propertyId || "")
    .trim()
    .replace(/^properties\//, "");
  if (!/^\d{5,20}$/.test(propertyId)) {
    throw new Error("invalid_property_id");
  }

  let sa = raw.serviceAccountJson;
  const saEmpty =
    sa == null ||
    (typeof sa === "string" && !sa.trim()) ||
    (typeof sa === "object" && !sa.private_key);
  if (saEmpty) {
    if (opts.allowMissingSa) {
      return { propertyId, serviceAccount: null, clientEmail: null };
    }
    throw new Error("invalid_sa_json");
  }
  if (typeof sa === "string") {
    const trimmed = sa.trim();
    if (trimmed.length > MAX_SA_JSON_BYTES) throw new Error("sa_json_too_large");
    try {
      sa = JSON.parse(trimmed);
    } catch {
      throw new Error("invalid_sa_json");
    }
  }
  if (!sa || typeof sa !== "object") throw new Error("invalid_sa_json");
  const clientEmail = String(sa.client_email || "").trim();
  const privateKey = String(sa.private_key || "").trim();
  if (!clientEmail.includes("@") || !privateKey.includes("PRIVATE KEY")) {
    throw new Error("invalid_sa_json");
  }
  return {
    propertyId,
    serviceAccount: {
      client_email: clientEmail,
      private_key: privateKey,
      private_key_id: sa.private_key_id || undefined,
      token_uri: sa.token_uri || "https://oauth2.googleapis.com/token",
    },
    clientEmail,
  };
}

/**
 * @param {DurableObjectStorage} storage
 * @param {Env} env
 * @param {string} siteKey
 * @param {{ propertyId: string, serviceAccount: object | null, clientEmail: string | null }} parsed
 */
export async function saveGaConfig(storage, env, siteKey, parsed) {
  const passphrase = String(env.CRM_DATA_PASSPHRASE || "").trim();
  if (!passphrase) throw new Error("passphrase_not_configured");
  const key = await deriveCrmDataKey(passphrase, siteKey);
  let serviceAccount = parsed.serviceAccount;
  let clientEmail = parsed.clientEmail;
  if (!serviceAccount) {
    const existing = await loadGaConfigSecret(storage, env, siteKey);
    if (!existing?.serviceAccount) throw new Error("invalid_sa_json");
    serviceAccount = existing.serviceAccount;
    clientEmail =
      existing.clientEmail || existing.serviceAccount.client_email || null;
  }
  const payload = {
    propertyId: parsed.propertyId,
    clientEmail,
    serviceAccount,
    updated_at: new Date().toISOString(),
  };
  const enc = await encryptJson(payload, key);
  await storage.put(GA_STORAGE_KEY, enc);
  await storage.delete(GA_TOKEN_CACHE_KEY);
  return {
    configured: true,
    propertyId: payload.propertyId,
    clientEmail: payload.clientEmail,
    updated_at: payload.updated_at,
  };
}

/** @param {DurableObjectStorage} storage */
export async function clearGaConfig(storage) {
  await storage.delete(GA_STORAGE_KEY);
  await storage.delete(GA_TOKEN_CACHE_KEY);
}

/**
 * @param {DurableObjectStorage} storage
 * @param {Env} env
 * @param {string} siteKey
 * @returns {Promise<{ configured: boolean, propertyId?: string, clientEmail?: string, updated_at?: string }>}
 */
export async function getGaConfigPublic(storage, env, siteKey) {
  const enc = await storage.get(GA_STORAGE_KEY);
  if (!enc || typeof enc !== "string") return { configured: false };
  try {
    const passphrase = String(env.CRM_DATA_PASSPHRASE || "").trim();
    if (!passphrase) return { configured: false };
    const key = await deriveCrmDataKey(passphrase, siteKey);
    const data = await decryptJson(enc, key);
    return {
      configured: true,
      propertyId: String(data.propertyId || ""),
      clientEmail: String(data.clientEmail || data.serviceAccount?.client_email || ""),
      updated_at: data.updated_at || null,
    };
  } catch {
    return { configured: false };
  }
}

/**
 * @param {DurableObjectStorage} storage
 * @param {Env} env
 * @param {string} siteKey
 */
async function loadGaConfigSecret(storage, env, siteKey) {
  const enc = await storage.get(GA_STORAGE_KEY);
  if (!enc || typeof enc !== "string") return null;
  const passphrase = String(env.CRM_DATA_PASSPHRASE || "").trim();
  if (!passphrase) throw new Error("passphrase_not_configured");
  const key = await deriveCrmDataKey(passphrase, siteKey);
  return decryptJson(enc, key);
}

async function signJwtRs256(unsigned, privateKeyPem) {
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsigned),
  );
  return b64url(sig);
}

/**
 * @param {object} serviceAccount
 * @returns {Promise<string>}
 */
async function fetchGoogleAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(
    JSON.stringify({
      alg: "RS256",
      typ: "JWT",
      ...(serviceAccount.private_key_id
        ? { kid: serviceAccount.private_key_id }
        : {}),
    }),
  );
  const claim = b64url(
    JSON.stringify({
      iss: serviceAccount.client_email,
      sub: serviceAccount.client_email,
      aud: serviceAccount.token_uri || "https://oauth2.googleapis.com/token",
      scope: GA_SCOPE,
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${claim}`;
  const jwt = `${unsigned}.${await signJwtRs256(unsigned, serviceAccount.private_key)}`;
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });
  const res = await fetch(
    serviceAccount.token_uri || "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`google_token_failed:${res.status}:${text.slice(0, 180)}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error("google_token_missing");
  return {
    access_token: data.access_token,
    expires_at: Date.now() + Math.max(60, Number(data.expires_in || 3600) - 120) * 1000,
  };
}

/**
 * @param {DurableObjectStorage} storage
 * @param {object} serviceAccount
 */
async function getAccessToken(storage, serviceAccount) {
  const cached = await storage.get(GA_TOKEN_CACHE_KEY);
  if (
    cached &&
    typeof cached === "object" &&
    cached.access_token &&
    cached.expires_at > Date.now()
  ) {
    return cached.access_token;
  }
  const next = await fetchGoogleAccessToken(serviceAccount);
  await storage.put(GA_TOKEN_CACHE_KEY, next);
  return next.access_token;
}

function rangeToDates(range) {
  const days =
    range === "90d" ? 90 : range === "28d" ? 28 : range === "7d" ? 7 : 7;
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { startDate: fmt(start), endDate: fmt(end), days };
}

function metricMap(rows, metricHeaders) {
  const out = {};
  if (!rows?.[0]?.metricValues) return out;
  rows[0].metricValues.forEach((m, i) => {
    const name = metricHeaders[i]?.name;
    if (name) out[name] = Number(m.value || 0);
  });
  return out;
}

function dimRows(rows, dimHeaders, metricHeaders) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const dims = {};
    (row.dimensionValues || []).forEach((d, i) => {
      const name = dimHeaders[i]?.name;
      if (name) dims[name] = d.value || "";
    });
    const metrics = {};
    (row.metricValues || []).forEach((m, i) => {
      const name = metricHeaders[i]?.name;
      if (name) metrics[name] = Number(m.value || 0);
    });
    return { ...dims, ...metrics };
  });
}

/**
 * Fetch a sanitized GA4 report for the CRM Analytics UI.
 *
 * @param {DurableObjectStorage} storage
 * @param {Env} env
 * @param {string} siteKey
 * @param {string} range
 */
export async function runGaSiteReport(storage, env, siteKey, range) {
  const cfg = await loadGaConfigSecret(storage, env, siteKey);
  if (!cfg?.propertyId || !cfg?.serviceAccount) {
    throw new Error("ga_not_configured");
  }
  const { startDate, endDate, days } = rangeToDates(range);
  const token = await getAccessToken(storage, cfg.serviceAccount);
  const property = `properties/${cfg.propertyId}`;

  const runReport = async (body) => {
    const res = await fetch(
      `https://analyticsdata.googleapis.com/v1beta/${property}:runReport`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          dateRanges: [{ startDate, endDate }],
          ...body,
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ga_report_failed:${res.status}:${text.slice(0, 220)}`);
    }
    return res.json();
  };

  const [summary, pages, countries] = await Promise.all([
    runReport({
      metrics: [
        { name: "activeUsers" },
        { name: "sessions" },
        { name: "engagedSessions" },
        { name: "screenPageViews" },
      ],
    }),
    runReport({
      dimensions: [{ name: "pagePath" }],
      metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }],
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
      limit: 10,
    }),
    runReport({
      dimensions: [{ name: "country" }],
      metrics: [{ name: "activeUsers" }, { name: "sessions" }],
      orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
      limit: 10,
    }),
  ]);

  const totals = metricMap(
    summary.rows,
    summary.metricHeaders || [
      { name: "activeUsers" },
      { name: "sessions" },
      { name: "engagedSessions" },
      { name: "screenPageViews" },
    ],
  );

  return {
    ok: true,
    propertyId: cfg.propertyId,
    range: `${days}d`,
    startDate,
    endDate,
    totals: {
      activeUsers: totals.activeUsers || 0,
      sessions: totals.sessions || 0,
      engagedSessions: totals.engagedSessions || 0,
      pageViews: totals.screenPageViews || 0,
    },
    topPages: dimRows(
      pages.rows,
      pages.dimensionHeaders || [{ name: "pagePath" }],
      pages.metricHeaders || [
        { name: "screenPageViews" },
        { name: "activeUsers" },
      ],
    ).map((r) => ({
      path: r.pagePath || "/",
      pageViews: r.screenPageViews || 0,
      users: r.activeUsers || 0,
    })),
    countries: dimRows(
      countries.rows,
      countries.dimensionHeaders || [{ name: "country" }],
      countries.metricHeaders || [
        { name: "activeUsers" },
        { name: "sessions" },
      ],
    ).map((r) => ({
      country: r.country || "(unknown)",
      users: r.activeUsers || 0,
      sessions: r.sessions || 0,
    })),
  };
}
