/**
 * Web Push helpers for Cloudflare Workers (VAPID + @pushforge/builder).
 * Keys are generated once per site DO and stored in SQLite.
 */

import { buildPushHTTPRequest } from "@pushforge/builder";

function b64urlFromBytes(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesFromB64url(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function jwkCoordToBytes(b64url) {
  return bytesFromB64url(b64url);
}

/** Uncompressed P-256 public key → applicationServerKey (base64url). */
export function publicJwkToApplicationServerKey(jwk) {
  const x = jwkCoordToBytes(jwk.x);
  const y = jwkCoordToBytes(jwk.y);
  const out = new Uint8Array(1 + x.length + y.length);
  out[0] = 0x04;
  out.set(x, 1);
  out.set(y, 1 + x.length);
  return b64urlFromBytes(out);
}

export function ensurePushSchema(sql) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS push_vapid (
      id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      private_jwk TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      agent_login TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

/**
 * Ensure a VAPID keypair exists for this site DO.
 * @returns {{ publicKey: string, privateJwk: object }}
 */
export async function getOrCreateVapid(sql) {
  ensurePushSchema(sql);
  const rows = sql
    .exec(`SELECT public_key, private_jwk FROM push_vapid WHERE id = 'default' LIMIT 1`)
    .toArray();
  if (rows.length) {
    return {
      publicKey: String(rows[0].public_key),
      privateJwk: JSON.parse(String(rows[0].private_jwk)),
    };
  }

  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  // VAPID signing uses ES256; private JWK needs alg/crv
  privateJwk.alg = "ES256";
  privateJwk.crv = privateJwk.crv || "P-256";
  const publicKey = publicJwkToApplicationServerKey(publicJwk);
  const ts = new Date().toISOString();
  sql.exec(
    `INSERT INTO push_vapid (id, public_key, private_jwk, created_at) VALUES ('default', ?, ?, ?)`,
    publicKey,
    JSON.stringify(privateJwk),
    ts,
  );
  return { publicKey, privateJwk };
}

export function upsertPushSubscription(sql, sub, agentLogin, userAgent) {
  ensurePushSchema(sql);
  const endpoint = String(sub?.endpoint || "").trim();
  const p256dh = String(sub?.keys?.p256dh || "").trim();
  const auth = String(sub?.keys?.auth || "").trim();
  if (!endpoint || !p256dh || !auth) {
    throw new Error("invalid_subscription");
  }
  const ts = new Date().toISOString();
  sql.exec(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, agent_login, user_agent, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       agent_login = excluded.agent_login,
       user_agent = excluded.user_agent,
       updated_at = excluded.updated_at`,
    endpoint,
    p256dh,
    auth,
    agentLogin || null,
    (userAgent || "").slice(0, 400) || null,
    ts,
    ts,
  );
}

export function deletePushSubscription(sql, endpoint) {
  ensurePushSchema(sql);
  sql.exec(`DELETE FROM push_subscriptions WHERE endpoint = ?`, String(endpoint || ""));
}

/** How many stored push endpoints can still receive alerts (phone / desktop). */
export function countPushSubscriptions(sql) {
  ensurePushSchema(sql);
  try {
    const row = sql
      .exec(`SELECT COUNT(*) AS c FROM push_subscriptions`)
      .one();
    return Number(row?.c || 0);
  } catch {
    return 0;
  }
}

/**
 * Map agent WS payloads → push notification content (or null to skip).
 */
export function pushPayloadFromAgentEvent(payload) {
  if (!payload || typeof payload !== "object") return null;
  const type = payload.type;
  if (type === "presence" && (payload.newVisitor || payload.returned)) {
    return {
      title: payload.newVisitor ? "New visitor on the site" : "Visitor returned",
      body: payload.pagePath
        ? `Browsing ${payload.pagePath}`
        : payload.displayName || payload.city || "Someone is on the site",
      tag: `visitor-${payload.visitorId || "x"}`,
      kind: "visitor",
    };
  }
  if (type === "chat_started") {
    // Agent-opened threads are silent for other agents' push
    if (payload.startedBy === "agent") return null;
    return {
      title: "New live chat",
      body: "A visitor started a conversation",
      tag: `chat-${payload.chatId || "x"}`,
      kind: "chat_started",
    };
  }
  if (type === "message" && (payload.role || "visitor") === "visitor") {
    return {
      title: "Visitor reply",
      body: String(payload.body || "").slice(0, 120) || "New chat message",
      tag: `msg-${payload.chatId || "x"}`,
      kind: "chat",
    };
  }
  if (type === "ticket_created") {
    // Only form / email / intake — skip agent-created (admin) tickets
    const src = String(payload.source || "")
      .trim()
      .toLowerCase();
    if (src !== "form" && src !== "email" && src !== "intake") return null;
    return {
      title: "New ticket",
      body: payload.subject || "Form / email intake",
      tag: `ticket-${payload.ticketId || "x"}`,
      kind: "ticket_intake",
    };
  }
  return null;
}

/**
 * Send encrypted Web Push to all stored agent subscriptions.
 * Removes gone (410/404) endpoints.
 */
export async function sendWebPushToAgents(sql, env, agentPayload) {
  const note = pushPayloadFromAgentEvent(agentPayload);
  if (!note) return { sent: 0, skipped: true };

  ensurePushSchema(sql);
  const { privateJwk } = await getOrCreateVapid(sql);
  const rows = sql
    .exec(`SELECT endpoint, p256dh, auth FROM push_subscriptions`)
    .toArray();
  if (!rows.length) return { sent: 0 };

  const adminContact = String(env.VAPID_CONTACT || "")
    .trim()
    .startsWith("mailto:")
    ? String(env.VAPID_CONTACT).trim()
    : String(env.VAPID_CONTACT || "").includes("@")
      ? `mailto:${String(env.VAPID_CONTACT).trim()}`
      : "mailto:crm@ackvyn.org";

  const urlPath = "/crm/";
  const payload = {
    title: note.title,
    body: note.body,
    tag: note.tag,
    kind: note.kind,
    url: urlPath,
  };

  let sent = 0;
  for (const row of rows) {
    const subscription = {
      endpoint: String(row.endpoint),
      keys: {
        p256dh: String(row.p256dh),
        auth: String(row.auth),
      },
    };
    try {
      const built = await buildPushHTTPRequest({
        privateJWK: privateJwk,
        subscription,
        message: {
          payload,
          adminContact,
          options: { urgency: "high", ttl: 60 * 60 },
        },
      });
      const res = await fetch(built.endpoint, {
        method: "POST",
        headers: built.headers,
        body: built.body,
      });
      if (res.status === 404 || res.status === 410) {
        sql.exec(
          `DELETE FROM push_subscriptions WHERE endpoint = ?`,
          subscription.endpoint,
        );
        continue;
      }
      if (res.ok || res.status === 201 || res.status === 202) sent += 1;
    } catch {
      /* drop individual failures */
    }
  }
  return { sent };
}
