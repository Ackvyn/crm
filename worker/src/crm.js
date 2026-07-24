/**
 * Per-site CRM Durable Object — live chat + presence/stats (SQLite).
 * Contacts/tickets currently also live here; target: migrate those to git commits.
 * Chat transcripts stay in DO until archived.
 */

import { assertCrmSession } from "./crmAuth.js";
import { readEdgeVisitorMeta } from "./edgeMeta.js";
import {
  clearGaConfig,
  getGaConfigPublic,
  parseGaConfigInput,
  runGaSiteReport,
  saveGaConfig,
} from "./gaAnalytics.js";
import {
  clearReviewsConfig,
  fetchPublicReviews,
  getReviewsConfigPublic,
  parseReviewsConfigInput,
  saveReviewsConfig,
  syncReviewsToGit,
} from "./googleReviews.js";
// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// import { commitIntakeTicket, gitStoreConfigured, commitVisitorsUpsert } from "./gitStore.js";
// NEW CODE - TESTING: no visitor git upserts (GA owns analytics)
import {
  appendSignedPdfToTicket,
  commitIntakeTicket,
  gitStoreConfigured,
} from "./gitStore.js";
import {
  hasEmailSendBinding,
  outboundEmailErrorPayload,
  sendTicketOutboundEmail,
} from "./emailOutbound.js";
import { HUB_SITE_KEY, handleHubFetch } from "./hub.js";
import { formatVisitorLabel, parseUserAgent } from "./visitorLabel.js";
import { buildSignPageHtml } from "./signPageHtml.js";
import {
  deletePushSubscription,
  ensurePushSchema,
  getOrCreateVapid,
  countPushSubscriptions,
  sendWebPushToAgents,
  upsertPushSubscription,
} from "./webPush.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  business_type TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_email ON contacts(email);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  contact_id TEXT,
  subject TEXT,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS tickets_updated ON tickets(updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  role TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_ticket ON messages(ticket_id, created_at);

CREATE TABLE IF NOT EXISTS visitors (
  id TEXT PRIMARY KEY,
  contact_id TEXT,
  display_name TEXT,
  email TEXT,
  page_path TEXT,
  status TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_offline_at TEXT,
  return_count INTEGER NOT NULL DEFAULT 0,
  user_agent TEXT,
  active_ticket_id TEXT
);
CREATE INDEX IF NOT EXISTS visitors_status ON visitors(status);
CREATE INDEX IF NOT EXISTS visitors_seen ON visitors(last_seen_at);

CREATE TABLE IF NOT EXISTS presence_events (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  page_path TEXT
);
CREATE INDEX IF NOT EXISTS presence_events_at ON presence_events(at DESC);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS chats_visitor ON chats(visitor_id);
CREATE INDEX IF NOT EXISTS chats_status ON chats(status);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  author_login TEXT,
  author_name TEXT
);
CREATE INDEX IF NOT EXISTS chat_messages_chat ON chat_messages(chat_id, created_at);
`;

/**
 * Missed presence → offline (ms).
 * Widget keep-alive ~45s; ~1 minute without a ping ⇒ offline (small margin for lag).
 */
const OFFLINE_AFTER_MS = 70_000;
/** Away this long before a return is “notable” for agents. */
const RETURN_NOTABLE_MS = 5 * 60_000;
/** Alarm cadence while anyone is marked online. */
const PRESENCE_ALARM_MS = 30_000;
/** Hint to embeds: how often to send presence over the visitor WS. */
const PRESENCE_INTERVAL_HINT_MS = 45_000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function id() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

function ensureSchemaExtras(sql) {
  try {
    sql.exec(`ALTER TABLE contacts ADD COLUMN notes TEXT`);
  } catch {
    /* exists */
  }
  try {
    sql.exec(`ALTER TABLE visitors ADD COLUMN active_chat_id TEXT`);
  } catch {
    /* exists */
  }
  try {
    sql.exec(`ALTER TABLE chats ADD COLUMN archived_at TEXT`);
  } catch {
    /* exists */
  }
  const visitorCols = [
    ["ip", "TEXT"],
    ["country", "TEXT"],
    ["city", "TEXT"],
    ["region", "TEXT"],
    ["browser", "TEXT"],
    ["os", "TEXT"],
    ["device", "TEXT"],
    ["language", "TEXT"],
    ["timezone", "TEXT"],
    ["screen", "TEXT"],
    ["referrer", "TEXT"],
    ["as_org", "TEXT"],
  ];
  for (const [col, typ] of visitorCols) {
    try {
      sql.exec(`ALTER TABLE visitors ADD COLUMN ${col} ${typ}`);
    } catch {
      /* exists */
    }
  }
  sql.exec(`
    CREATE TABLE IF NOT EXISTS site_settings (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      allowed_origins TEXT NOT NULL DEFAULT '[]',
      forms_json TEXT NOT NULL DEFAULT '[]',
      widgets_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT
    );
  `);
  try {
    sql.exec(`ALTER TABLE site_settings ADD COLUMN widget_json TEXT`);
  } catch {
    /* exists */
  }
  try {
    sql.exec(`ALTER TABLE site_settings ADD COLUMN branding_json TEXT`);
  } catch {
    /* exists */
  }
  try {
    sql.exec(`ALTER TABLE site_settings ADD COLUMN inbound_mailbox TEXT`);
  } catch {
    /* exists */
  }
  try {
    sql.exec(`ALTER TABLE site_settings ADD COLUMN mailto_copy_mode TEXT`);
  } catch {
    /* exists */
  }
  try {
    sql.exec(`ALTER TABLE site_settings ADD COLUMN agent_emails_json TEXT`);
  } catch {
    /* exists */
  }
  try {
    sql.exec(`ALTER TABLE site_settings ADD COLUMN tickets_json TEXT`);
  } catch {
    /* exists */
  }
  // NEW CODE - TESTING: optional Cloudflare Email Sending (off by default)
  try {
    sql.exec(
      `ALTER TABLE site_settings ADD COLUMN worker_outbound_email TEXT NOT NULL DEFAULT '0'`,
    );
  } catch {
    /* exists */
  }
  try {
    sql.exec(`ALTER TABLE visitors ADD COLUMN enrichment_json TEXT`);
  } catch {
    /* exists */
  }
  try {
    sql.exec(`ALTER TABLE chat_messages ADD COLUMN author_login TEXT`);
  } catch {
    /* exists */
  }
  try {
    sql.exec(`ALTER TABLE chat_messages ADD COLUMN author_name TEXT`);
  } catch {
    /* exists */
  }
  // NEW CODE - TESTING: share-link visual e-sign sessions (PDF envelope in DO)
  sql.exec(`
    CREATE TABLE IF NOT EXISTS sign_sessions (
      token TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      contact_id TEXT,
      contact_email TEXT,
      contact_name TEXT,
      document_id TEXT,
      filename TEXT,
      fields_json TEXT NOT NULL,
      pdf_b64 TEXT NOT NULL,
      unsigned_sha256 TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      completed_at TEXT,
      signed_sha256 TEXT,
      signer_name TEXT,
      signer_ip TEXT,
      signer_ua TEXT,
      created_by_login TEXT
    );
  `);
  // NEW CODE - TESTING: Web Push subscriptions + VAPID per site
  ensurePushSchema(sql);
}

export class CrmSite {
  /**
   * @param {DurableObjectState} ctx
   * @param {Env} env
   */
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    /** @type {Map<WebSocket, { kind: string, ticketId?: string, chatId?: string, visitorId?: string, role?: string }>} */
    this.sessions = new Map();
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(SCHEMA);
      ensureSchemaExtras(this.ctx.storage.sql);
    });

    // Hibernation: rebuild session map after DO wake (CF workers-chat-demo pattern)
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att && typeof att === "object") this.sessions.set(ws, att);
    }

    // Edge-level ping/pong — does NOT wake the DO / does not bill DO requests
    try {
      this.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair("ping", "pong"),
      );
    } catch {
      /* runtime without auto-response */
    }

    // Presence offline sweep via alarm (not on every HTTP hit)
    this.ctx.storage.getAlarm().then((existing) => {
      if (existing == null) {
        return this.ctx.storage.setAlarm(Date.now() + PRESENCE_ALARM_MS);
      }
    });
  }

  /** Durable Object alarm — offline sweep only (analytics → GA, not git). */
  async alarm() {
    this.sweepOfflineVisitors();
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // try {
    //   const pending = await this.ctx.storage.get("visitor_git_pending");
    //   if (pending) {
    //     await this.ctx.storage.delete("visitor_git_pending");
    //     await this.flushVisitorsToGit();
    //   }
    // } catch {
    //   /* git flush best-effort */
    // }
    // NEW CODE - TESTING: clear any stale flush flag; do not commit visitors.json.enc
    try {
      await this.ctx.storage.delete("visitor_git_pending");
    } catch {
      /* ignore */
    }
    const online = this.ctx.storage.sql
      .exec(
        `SELECT COUNT(*) AS c FROM visitors WHERE status = 'online'`,
      )
      .one();
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // const stillPending = await this.ctx.storage.get("visitor_git_pending");
    // if (Number(online?.c || 0) > 0 || stillPending) {
    // NEW CODE - TESTING
    if (Number(online?.c || 0) > 0) {
      await this.ctx.storage.setAlarm(Date.now() + PRESENCE_ALARM_MS);
    }
  }

  /**
   * OLD CODE - KEEP UNTIL CONFIRMED WORKING: Debounce visitor analytics commits (~60s).
   * NEW CODE - TESTING: no-op — GA owns analytics; DO only keeps live presence for chat.
   */
  scheduleVisitorGitFlush() {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // if (this.ctx.id.name === HUB_SITE_KEY) return;
    // if (!gitStoreConfigured(this.env)) return;
    // void this.ctx.storage.put("visitor_git_pending", true);
    // void this.ctx.storage.getAlarm().then((existing) => {
    //   const due = Date.now() + 60_000;
    //   if (existing == null || existing > due) {
    //     return this.ctx.storage.setAlarm(due);
    //   }
    // });
  }

  /** @deprecated Visitor git history disabled — kept for rollback. */
  async flushVisitorsToGit() {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // if (this.ctx.id.name === HUB_SITE_KEY) return;
    // if (!gitStoreConfigured(this.env)) return;
    // ... commitVisitorsUpsert(...)
    return;
  }

  /** @param {Request} request */
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, "");

    // OLD CODE - KEEP UNTIL CONFIRMED WORKING:
    // this.sweepOfflineVisitors(); // every request → wakes DO + extra work

    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocket(request, path, url);
    }

    // Multi-site registry (portable CRM hub)
    if (this.ctx.id.name === HUB_SITE_KEY) {
      return handleHubFetch(this, request, path);
    }

    const routes = [
      ["POST", "intake", () => this.handleIntake(request)],
      ["GET", "contacts", () => this.handleListContacts()],
      ["POST", "contacts", () => this.handleCreateContact(request)],
      ["GET", "tickets", () => this.handleListTickets(url)],
      ["POST", "tickets", () => this.handleCreateTicket(request)],
      ["GET", "chats", () => this.handleListChats(url)],
      ["POST", "presence/heartbeat", () => this.handleHeartbeat(request)],
      ["GET", "presence", () => this.handleListPresence()],
      ["GET", "presence/events", () => this.handlePresenceEvents(url)],
      ["POST", "archive-due", () => this.handleArchiveDue()],
      ["GET", "settings", () => this.handleGetSettings()],
      ["PATCH", "settings", () => this.handlePatchSettings(request)],
      ["GET", "agents/status", () => this.handleAgentsStatus()],
    ];

    for (const [method, exact, handler] of routes) {
      if (request.method === method && path === exact) return handler();
    }

    // contacts/:id
    let m = path.match(/^contacts\/([^/]+)$/);
    if (m && request.method === "GET") return this.handleGetContact(m[1]);
    if (m && request.method === "PATCH") return this.handlePatchContact(m[1], request);

    // tickets/:id
    m = path.match(/^tickets\/([^/]+)$/);
    if (m && request.method === "GET") return this.handleGetTicket(m[1]);
    if (m && request.method === "PATCH") return this.handlePatchTicket(m[1], request);

    m = path.match(/^tickets\/([^/]+)\/close$/);
    if (m && request.method === "POST") return this.handleCloseTicket(m[1]);

    m = path.match(/^tickets\/([^/]+)\/messages$/);
    if (m && request.method === "POST") return this.handlePostMessage(m[1], request);

    // NEW CODE - TESTING: Worker outbound via Cloudflare Email Sending
    m = path.match(/^tickets\/([^/]+)\/send-email$/);
    if (m && request.method === "POST") {
      return this.handleSendTicketEmail(m[1], request);
    }

    // chats/:id
    m = path.match(/^chats\/([^/]+)$/);
    if (m && request.method === "GET") return this.handleGetChat(m[1]);

    m = path.match(/^chats\/([^/]+)\/messages$/);
    if (m && request.method === "POST") return this.handlePostChatMessage(m[1], request);

    m = path.match(/^chats\/([^/]+)\/close$/);
    if (m && request.method === "POST") return this.handleCloseChat(m[1]);

    m = path.match(/^chats\/([^/]+)\/archive$/);
    if (m && request.method === "POST") return this.handleArchiveChat(m[1]);

    m = path.match(/^chats\/([^/]+)$/);
    if (m && request.method === "DELETE") return this.handleDeleteChat(m[1]);

    m = path.match(/^visitors\/([^/]+)\/start-chat$/);
    if (m && request.method === "POST") return this.handleStartChat(m[1], request);

    // NEW CODE - TESTING: GA4 config + report (session-gated)
    if (path === "analytics/ga/config" && request.method === "GET") {
      return this.handleGaGetConfig(request);
    }
    if (path === "analytics/ga/config" && request.method === "PUT") {
      return this.handleGaPutConfig(request);
    }
    if (path === "analytics/ga/config" && request.method === "DELETE") {
      return this.handleGaDeleteConfig(request);
    }

    // NEW CODE - TESTING: Web Push (background phone/desktop when CRM closed)
    if (path === "push/vapid-public" && request.method === "GET") {
      return this.handlePushVapidPublic(request);
    }
    if (path === "push/subscribe" && request.method === "POST") {
      return this.handlePushSubscribe(request);
    }
    if (path === "push/unsubscribe" && request.method === "POST") {
      return this.handlePushUnsubscribe(request);
    }
    if (path === "analytics/ga/report" && request.method === "GET") {
      return this.handleGaReport(request, url);
    }

    // Google Place reviews — config + sync to content/reviews.json (not live Places)
    if (path === "reviews/config" && request.method === "GET") {
      return this.handleReviewsGetConfig(request);
    }
    if (path === "reviews/config" && request.method === "PUT") {
      return this.handleReviewsPutConfig(request);
    }
    if (path === "reviews/config" && request.method === "DELETE") {
      return this.handleReviewsDeleteConfig(request);
    }
    if (path === "reviews/sync" && request.method === "POST") {
      return this.handleReviewsSync(request);
    }
    if (path === "reviews/cron-sync" && request.method === "POST") {
      return this.handleReviewsCronSync(request);
    }
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING: live Places via Worker
    // if (path === "reviews" && request.method === "GET") {
    //   return this.handlePublicReviews();
    // }
    // NEW CODE - TESTING: cached payload only (site should use content/reviews.json)
    if (path === "reviews" && request.method === "GET") {
      return this.handlePublicReviews();
    }

    // Worker → DO: agent email allowlist for inbound attribution
    if (path === "internal/agent-emails" && request.method === "GET") {
      const settings = this.readSettingsRow() || this.defaultSettings();
      return json({ emails: settings.agentEmails || [] });
    }

    // Worker → DO nudge after git intake (email / form)
    if (path === "internal/notify-ticket" && request.method === "POST") {
      return this.handleNotifyTicket(request);
    }

    // NEW CODE - TESTING: visual e-sign share links
    if (path === "sign/sessions" && request.method === "POST") {
      return this.handleCreateSignSession(request);
    }
    // NEW CODE - TESTING: agent revoke pending share link
    m = path.match(/^sign\/sessions\/([^/]+)\/revoke$/);
    if (m && request.method === "POST") {
      return this.handleRevokeSignSession(m[1], request);
    }
    m = path.match(/^sign\/([^/]+)$/);
    if (m && request.method === "GET") {
      return this.handleSignPage(m[1], request);
    }
    m = path.match(/^sign\/([^/]+)\/envelope$/);
    if (m && request.method === "GET") {
      return this.handleSignEnvelope(m[1]);
    }
    m = path.match(/^sign\/([^/]+)\/complete$/);
    if (m && request.method === "POST") {
      return this.handleSignComplete(m[1], request);
    }

    return json({ error: "not_found", path }, 404);
  }

  sweepOfflineVisitors() {
    const cutoff = new Date(Date.now() - OFFLINE_AFTER_MS).toISOString();
    const stale = this.ctx.storage.sql
      .exec(
        `SELECT id, page_path FROM visitors
         WHERE status = 'online' AND last_seen_at < ?`,
        cutoff,
      )
      .toArray();
    const ts = now();
    for (const row of stale) {
      this.ctx.storage.sql.exec(
        `UPDATE visitors SET status = 'offline', last_offline_at = ? WHERE id = ?`,
        ts,
        row.id,
      );
      this.recordPresenceEvent(row.id, "offline", ts, row.page_path);
      this.broadcastAgents({
        type: "presence",
        visitorId: row.id,
        status: "offline",
        pagePath: row.page_path,
        at: ts,
      });
    }
  }

  recordPresenceEvent(visitorId, kind, at, pagePath) {
    this.ctx.storage.sql.exec(
      `INSERT INTO presence_events (id, visitor_id, kind, at, page_path)
       VALUES (?, ?, ?, ?, ?)`,
      id(),
      visitorId,
      kind,
      at,
      pagePath || null,
    );
  }

  async handleListContacts() {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT c.*,
          (SELECT COUNT(*) FROM tickets t WHERE t.contact_id = c.id) AS ticket_count
         FROM contacts c
         ORDER BY c.updated_at DESC
         LIMIT 500`,
      )
      .toArray();
    return json({ contacts: rows });
  }

  async handleGetContact(contactId) {
    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM contacts WHERE id = ? LIMIT 1`, contactId)
      .toArray();
    if (!rows.length) return json({ error: "not_found" }, 404);
    const tickets = this.ctx.storage.sql
      .exec(
        `SELECT id, subject, status, source, updated_at FROM tickets
         WHERE contact_id = ? ORDER BY updated_at DESC`,
        contactId,
      )
      .toArray();
    return json({ contact: rows[0], tickets });
  }

  async handleCreateContact(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    if (!name || !email) return json({ error: "name_email_required" }, 400);
    const ts = now();
    const contactId = id();
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO contacts (id, name, email, business_type, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        contactId,
        name,
        email,
        String(body.businessType || body.business_type || "").trim() || null,
        String(body.notes || "").trim() || null,
        ts,
        ts,
      );
    } catch {
      return json({ error: "email_exists" }, 409);
    }
    return json({ ok: true, contact: { id: contactId, name, email } });
  }

  async handlePatchContact(contactId, request) {
    const existing = this.ctx.storage.sql
      .exec(`SELECT * FROM contacts WHERE id = ? LIMIT 1`, contactId)
      .toArray();
    if (!existing.length) return json({ error: "not_found" }, 404);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const cur = existing[0];
    const name = body.name != null ? String(body.name).trim() : cur.name;
    const email =
      body.email != null ? String(body.email).trim().toLowerCase() : cur.email;
    const businessType =
      body.businessType != null || body.business_type != null
        ? String(body.businessType || body.business_type || "").trim() || null
        : cur.business_type;
    const notes =
      body.notes != null ? String(body.notes).trim() || null : cur.notes;
    const ts = now();
    try {
      this.ctx.storage.sql.exec(
        `UPDATE contacts SET name = ?, email = ?, business_type = ?, notes = ?, updated_at = ?
         WHERE id = ?`,
        name,
        email,
        businessType,
        notes,
        ts,
        contactId,
      );
    } catch {
      return json({ error: "email_conflict" }, 409);
    }
    return this.handleGetContact(contactId);
  }

  upsertContactFromFields(name, email, businessType) {
    const ts = now();
    const existing = this.ctx.storage.sql
      .exec(`SELECT id FROM contacts WHERE email = ? LIMIT 1`, email)
      .toArray();
    if (existing.length) {
      const contactId = existing[0].id;
      this.ctx.storage.sql.exec(
        `UPDATE contacts SET name = ?, business_type = COALESCE(?, business_type), updated_at = ?
         WHERE id = ?`,
        name,
        businessType || null,
        ts,
        contactId,
      );
      return contactId;
    }
    const contactId = id();
    this.ctx.storage.sql.exec(
      `INSERT INTO contacts (id, name, email, business_type, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      contactId,
      name,
      email,
      businessType || null,
      ts,
      ts,
    );
    return contactId;
  }

  async handleNotifyTicket(request) {
    let body = {};
    try {
      body = await request.json();
    } catch {
      /* optional */
    }
    const ticketId = String(body.ticketId || "");
    const subject = String(body.subject || "New ticket");
    const ts = now();
    this.broadcastAgents({
      type: "ticket_created",
      ticketId,
      subject,
      source: body.source || "intake",
      at: ts,
      git: true,
    });
    return json({ ok: true });
  }

  async handleIntake(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const message = String(body.message || "").trim();
    const messageHtml =
      body.messageHtml != null || body.message_html != null
        ? String(body.messageHtml || body.message_html || "").trim()
        : "";
    const businessType = String(
      body.businessType || body.business_type || "",
    ).trim();
    if (String(body._honey || "").trim()) {
      return json({ ok: true, ticketId: "ignored" });
    }
    if (!name || !email || !message) {
      return json({ error: "name_email_message_required" }, 400);
    }

    if (!gitStoreConfigured(this.env)) {
      return json(
        {
          error: "git_intake_not_configured",
          hint: "Set Worker secrets GITHUB_TOKEN + CRM_DATA_PASSPHRASE",
        },
        503,
      );
    }

    const siteKey = this.ctx.id.name;
    const subject =
      String(body.subject || "").trim() ||
      `Message from ${name}${businessType ? ` (${businessType})` : ""}`;

    let result;
    try {
      result = await commitIntakeTicket(this.env, siteKey, {
        name,
        email,
        message,
        messageHtml: messageHtml || null,
        businessType,
        subject,
        source: "form",
      });
    } catch (err) {
      return json(
        {
          error: "git_commit_failed",
          detail: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }

    const ts = now();
    this.broadcastAgents({
      type: "ticket_created",
      ticketId: result.ticketId,
      subject,
      source: "form",
      at: ts,
      git: true,
    });
    return json({
      ok: true,
      ticketId: result.ticketId,
      contactId: result.contactId,
      storage: "github",
    });
  }

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING (SQLite intake):
  async handleIntakeSqliteLegacy(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const message = String(body.message || "").trim();
    const businessType = String(
      body.businessType || body.business_type || "",
    ).trim();
    if (String(body._honey || "").trim()) {
      return json({ ok: true, ticketId: "ignored" });
    }
    if (!name || !email || !message) {
      return json({ error: "name_email_message_required" }, 400);
    }
    const contactId = this.upsertContactFromFields(name, email, businessType);
    const ts = now();
    const ticketId = id();
    const subject =
      String(body.subject || "").trim() ||
      `Message from ${name}${businessType ? ` (${businessType})` : ""}`;
    this.ctx.storage.sql.exec(
      `INSERT INTO tickets (id, contact_id, subject, status, source, created_at, updated_at)
       VALUES (?, ?, ?, 'open', 'form', ?, ?)`,
      ticketId,
      contactId,
      subject,
      ts,
      ts,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO messages (id, ticket_id, role, body, created_at)
       VALUES (?, ?, 'visitor', ?, ?)`,
      id(),
      ticketId,
      message,
      ts,
    );
    this.broadcastAgents({
      type: "ticket_created",
      ticketId,
      subject,
      source: "form",
      at: ts,
    });
    return json({ ok: true, ticketId, contactId });
  }

  async handleCreateTicket(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    let contactId = body.contactId ? String(body.contactId) : null;
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    if (!contactId && name && email) {
      contactId = this.upsertContactFromFields(
        name,
        email,
        String(body.businessType || "").trim(),
      );
    }
    if (contactId) {
      const ok = this.ctx.storage.sql
        .exec(`SELECT id FROM contacts WHERE id = ?`, contactId)
        .toArray();
      if (!ok.length) return json({ error: "contact_not_found" }, 404);
    }
    const subject = String(body.subject || "").trim() || "New ticket";
    const message = String(body.message || "").trim();
    const source = String(body.source || "admin").trim() || "admin";
    const ts = now();
    const ticketId = id();
    this.ctx.storage.sql.exec(
      `INSERT INTO tickets (id, contact_id, subject, status, source, created_at, updated_at)
       VALUES (?, ?, ?, 'open', ?, ?, ?)`,
      ticketId,
      contactId,
      subject,
      source,
      ts,
      ts,
    );
    if (message) {
      this.ctx.storage.sql.exec(
        `INSERT INTO messages (id, ticket_id, role, body, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        id(),
        ticketId,
        body.role === "visitor" ? "visitor" : "agent",
        message.slice(0, 8000),
        ts,
      );
    }
    this.broadcastAgents({
      type: "ticket_created",
      ticketId,
      subject,
      source,
      at: ts,
    });
    return json({ ok: true, ticketId, contactId });
  }

  async handleListTickets(url) {
    const limit = Math.min(Number(url.searchParams.get("limit") || 100), 300);
    const status = url.searchParams.get("status");
    // Tickets only — live chats live in /chats
    const rows = status
      ? this.ctx.storage.sql
          .exec(
            `SELECT t.id, t.subject, t.status, t.source, t.created_at, t.updated_at, t.closed_at,
                    c.name AS contact_name, c.email AS contact_email
             FROM tickets t
             LEFT JOIN contacts c ON c.id = t.contact_id
             WHERE t.status = ? AND t.source != 'chat'
             ORDER BY t.updated_at DESC LIMIT ?`,
            status,
            limit,
          )
          .toArray()
      : this.ctx.storage.sql
          .exec(
            `SELECT t.id, t.subject, t.status, t.source, t.created_at, t.updated_at, t.closed_at,
                    c.name AS contact_name, c.email AS contact_email
             FROM tickets t
             LEFT JOIN contacts c ON c.id = t.contact_id
             WHERE t.source != 'chat'
             ORDER BY t.updated_at DESC LIMIT ?`,
            limit,
          )
          .toArray();
    return json({ tickets: rows });
  }

  async handleGetTicket(ticketId) {
    const tickets = this.ctx.storage.sql
      .exec(
        `SELECT t.*, c.name AS contact_name, c.email AS contact_email, c.business_type
         FROM tickets t
         LEFT JOIN contacts c ON c.id = t.contact_id
         WHERE t.id = ? LIMIT 1`,
        ticketId,
      )
      .toArray();
    if (!tickets.length) return json({ error: "not_found" }, 404);
    const messages = this.ctx.storage.sql
      .exec(
        `SELECT id, role, body, created_at FROM messages
         WHERE ticket_id = ? ORDER BY created_at ASC`,
        ticketId,
      )
      .toArray();
    return json({ ticket: tickets[0], messages });
  }

  async handlePatchTicket(ticketId, request) {
    const existing = this.ctx.storage.sql
      .exec(`SELECT * FROM tickets WHERE id = ? LIMIT 1`, ticketId)
      .toArray();
    if (!existing.length) return json({ error: "not_found" }, 404);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const cur = existing[0];
    const subject =
      body.subject != null ? String(body.subject).trim() || cur.subject : cur.subject;
    let status = cur.status;
    if (body.status != null) {
      status = String(body.status).trim();
      if (!["open", "pending", "closed"].includes(status)) {
        return json({ error: "bad_status" }, 400);
      }
    }
    const contactId =
      body.contactId !== undefined
        ? body.contactId
          ? String(body.contactId)
          : null
        : cur.contact_id;
    const ts = now();
    let closedAt = cur.closed_at;
    if (status === "closed" && cur.status !== "closed") closedAt = ts;
    if (status !== "closed") closedAt = null;
    this.ctx.storage.sql.exec(
      `UPDATE tickets SET subject = ?, status = ?, contact_id = ?, updated_at = ?, closed_at = ?
       WHERE id = ?`,
      subject,
      status,
      contactId,
      ts,
      closedAt,
      ticketId,
    );
    this.broadcastTicket(ticketId, {
      type: "ticket_updated",
      ticketId,
      subject,
      status,
      at: ts,
    });
    return this.handleGetTicket(ticketId);
  }

  async handleCloseTicket(ticketId) {
    const ts = now();
    this.ctx.storage.sql.exec(
      `UPDATE tickets SET status = 'closed', closed_at = ?, updated_at = ?
       WHERE id = ? AND status != 'closed'`,
      ts,
      ts,
      ticketId,
    );
    this.broadcastTicket(ticketId, {
      type: "ticket_closed",
      ticketId,
      at: ts,
    });
    return json({ ok: true, ticketId, closedAt: ts });
  }

  async handlePostMessage(ticketId, request) {
    const tickets = this.ctx.storage.sql
      .exec(`SELECT id FROM tickets WHERE id = ? LIMIT 1`, ticketId)
      .toArray();
    if (!tickets.length) return json({ error: "not_found" }, 404);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const text = String(body.body || "").trim();
    const role = body.role === "visitor" ? "visitor" : "agent";
    if (!text) return json({ error: "body_required" }, 400);
    const ts = now();
    const messageId = id();
    this.ctx.storage.sql.exec(
      `INSERT INTO messages (id, ticket_id, role, body, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      messageId,
      ticketId,
      role,
      text.slice(0, 8000),
      ts,
    );
    this.ctx.storage.sql.exec(
      `UPDATE tickets SET updated_at = ?, status = CASE WHEN status = 'closed' THEN status ELSE 'open' END
       WHERE id = ?`,
      ts,
      ticketId,
    );
    const message = {
      id: messageId,
      role,
      body: text.slice(0, 8000),
      created_at: ts,
    };
    this.broadcastTicket(ticketId, {
      type: "message",
      ticketId,
      ...message,
    });
    return json({ ok: true, message });
  }

  /**
   * On WS upgrade: stamp CF geo/IP (+ UA parse) without inventing a fake page path.
   * Creates the visitor row if needed so agents see someone as soon as the socket opens.
   */
  touchVisitorEdge(visitorId, edge, ua) {
    const idSafe = String(visitorId || "").trim();
    if (!idSafe) return;
    const edgeObj = edge || {};
    const parsed = parseUserAgent(ua || "");
    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM visitors WHERE id = ? LIMIT 1`, idSafe)
      .toArray();
    const ts = now();

    if (rows.length) {
      const v = rows[0];
      const wasOffline = v.status === "offline";
      this.ctx.storage.sql.exec(
        `UPDATE visitors SET
           status = 'online',
           last_seen_at = ?,
           user_agent = COALESCE(?, user_agent),
           ip = COALESCE(?, ip),
           country = COALESCE(?, country),
           city = COALESCE(?, city),
           region = COALESCE(?, region),
           as_org = COALESCE(?, as_org),
           browser = COALESCE(?, browser),
           os = COALESCE(?, os),
           device = COALESCE(?, device),
           timezone = COALESCE(timezone, ?)
         WHERE id = ?`,
        ts,
        ua ? String(ua).slice(0, 400) : null,
        edgeObj.ip || null,
        edgeObj.country || null,
        edgeObj.city || null,
        edgeObj.region || null,
        edgeObj.asOrg || null,
        parsed.browser,
        parsed.os,
        parsed.device,
        edgeObj.timezone || null,
        idSafe,
      );
      if (wasOffline) {
        const refreshed = this.ctx.storage.sql
          .exec(`SELECT * FROM visitors WHERE id = ? LIMIT 1`, idSafe)
          .toArray()[0];
        this.recordPresenceEvent(idSafe, "online", ts, refreshed.page_path);
        this.broadcastAgents({
          type: "presence",
          visitorId: idSafe,
          status: "online",
          returned: false,
          pagePath: refreshed.page_path,
          activeChatId: refreshed.active_chat_id || null,
          at: ts,
          displayName: refreshed.display_name,
          email: refreshed.email,
          browser: refreshed.browser,
          os: refreshed.os,
          device: refreshed.device,
          city: refreshed.city,
          country: refreshed.country,
          region: refreshed.region,
          ip: refreshed.ip,
          label: formatVisitorLabel(refreshed),
        });
      }
      void this.ensurePresenceAlarm();
      return;
    }

    this.upsertPresence({
      visitorId: idSafe,
      pagePath: "/",
      ua,
      edge: edgeObj,
    });
  }

  /**
   * Upsert visitor presence. Prefer calling from visitor WebSocket (sparse).
   * Edge geo/IP from Worker headers; browser/OS from client profile or UA parse.
   * Optional client enrichment (ipapi from visitor browser) stored + flushed to git.
   *
   * @param {{
   *   visitorId?: string | null,
   *   pagePath?: string,
   *   displayName?: string | null,
   *   email?: string | null,
   *   ua?: string | null,
   *   profile?: Record<string, string | null> | null,
   *   edge?: Record<string, string> | null,
   *   enrichment?: Record<string, unknown> | null,
   * }} input
   */
  upsertPresence(input) {
    let visitorId = String(input.visitorId || "").trim();
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING: always default pagePath to "/"
    // const pagePath = String(input.pagePath || "/").slice(0, 500);
    // NEW CODE - TESTING: omit pagePath on keep-alives (no SPA page tracking)
    const hasPagePath =
      input.pagePath != null && String(input.pagePath).trim() !== "";
    const pagePath = hasPagePath
      ? String(input.pagePath).slice(0, 500)
      : null;
    const displayName = String(input.displayName || "").trim() || null;
    const email = String(input.email || "").trim().toLowerCase() || null;
    const ua = String(input.ua || "").slice(0, 400) || null;
    const profile = input.profile || {};
    const edge = input.edge || {};
    const enrichmentIn =
      input.enrichment && typeof input.enrichment === "object"
        ? input.enrichment
        : null;
    const parsed = parseUserAgent(ua || "");
    const ts = now();

    const meta = {
      ip: edge.ip || (enrichmentIn && enrichmentIn.query) || null,
      country:
        edge.country || (enrichmentIn && enrichmentIn.country) || null,
      city: edge.city || (enrichmentIn && enrichmentIn.city) || null,
      region: edge.region || (enrichmentIn && enrichmentIn.region) || null,
      as_org: edge.asOrg || (enrichmentIn && enrichmentIn.org) || null,
      browser: profile.browser || parsed.browser || null,
      os: profile.os || parsed.os || null,
      device: profile.device || parsed.device || null,
      language: profile.language || null,
      timezone:
        profile.timezone ||
        edge.timezone ||
        (enrichmentIn && enrichmentIn.timezone) ||
        null,
      screen: profile.screen || null,
      referrer: profile.referrer || null,
    };

    const agentFields = (row) => ({
      displayName: row.display_name,
      email: row.email,
      browser: row.browser,
      os: row.os,
      device: row.device,
      city: row.city,
      country: row.country,
      region: row.region,
      ip: row.ip,
      language: row.language,
      timezone: row.timezone,
      screen: row.screen,
      referrer: row.referrer,
      label: formatVisitorLabel(row),
    });

    let returned = false;
    let created = false;
    let pageChanged = false;
    let notableReturn = false;

    if (visitorId) {
      const rows = this.ctx.storage.sql
        .exec(`SELECT * FROM visitors WHERE id = ? LIMIT 1`, visitorId)
        .toArray();
      if (rows.length) {
        const v = rows[0];
        const wasOffline = v.status === "offline";
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING:
        // pageChanged = String(v.page_path || "") !== pagePath;
        // NEW CODE - TESTING: never treat path as a presence event
        pageChanged = false;
        const pathForStore = hasPagePath
          ? pagePath
          : String(v.page_path || "/") || "/";
        if (wasOffline && v.last_offline_at) {
          const awayMs =
            Date.now() - new Date(v.last_offline_at).getTime();
          notableReturn = awayMs >= RETURN_NOTABLE_MS;
        }
        const returnCount = notableReturn
          ? Number(v.return_count || 0) + 1
          : v.return_count;

        // COALESCE: keep prior enrichment; fill blanks from this ping
        const enrichmentJson = enrichmentIn
          ? JSON.stringify(enrichmentIn).slice(0, 4000)
          : null;
        this.ctx.storage.sql.exec(
          `UPDATE visitors SET
             status = 'online',
             page_path = ?,
             last_seen_at = ?,
             display_name = COALESCE(?, display_name),
             email = COALESCE(?, email),
             user_agent = COALESCE(?, user_agent),
             return_count = ?,
             ip = COALESCE(?, ip),
             country = COALESCE(?, country),
             city = COALESCE(?, city),
             region = COALESCE(?, region),
             as_org = COALESCE(?, as_org),
             browser = COALESCE(?, browser),
             os = COALESCE(?, os),
             device = COALESCE(?, device),
             language = COALESCE(?, language),
             timezone = COALESCE(?, timezone),
             screen = COALESCE(?, screen),
             referrer = COALESCE(?, referrer),
             enrichment_json = COALESCE(?, enrichment_json)
           WHERE id = ?`,
          pathForStore,
          ts,
          displayName,
          email,
          ua,
          returnCount,
          meta.ip,
          meta.country,
          meta.city,
          meta.region,
          meta.as_org,
          meta.browser,
          meta.os,
          meta.device,
          meta.language,
          meta.timezone,
          meta.screen,
          meta.referrer,
          enrichmentJson,
          visitorId,
        );

        const refreshed = this.ctx.storage.sql
          .exec(`SELECT * FROM visitors WHERE id = ? LIMIT 1`, visitorId)
          .toArray()[0];

        // OLD CODE - KEEP UNTIL CONFIRMED WORKING:
        // if (wasOffline || enrichmentIn || pageChanged || notableReturn) {
        // NEW CODE - TESTING: path changes do not flush git / spam agents
        if (wasOffline || enrichmentIn || notableReturn) {
          this.scheduleVisitorGitFlush();
        }

        if (wasOffline) {
          returned = true;
          this.recordPresenceEvent(
            visitorId,
            notableReturn ? "returned" : "online",
            ts,
            pathForStore,
          );
          this.broadcastAgents({
            type: "presence",
            visitorId,
            status: "online",
            returned: notableReturn,
            pagePath: pathForStore,
            activeChatId: refreshed.active_chat_id || null,
            at: ts,
            ...agentFields(refreshed),
          });
        }
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING: broadcast on every pagePath change
        // else if (pageChanged) {
        //   this.broadcastAgents({ type: "presence_ping", ... });
        // }
        void this.ensurePresenceAlarm();
        return {
          ok: true,
          visitorId,
          returned: notableReturn,
          created: false,
          pageChanged,
          // NEW CODE - TESTING: let embeds resume open chats without waiting for agent ping
          activeChatId: refreshed.active_chat_id || null,
        };
      }

      created = true;
      const enrichmentJsonNew = enrichmentIn
        ? JSON.stringify(enrichmentIn).slice(0, 4000)
        : null;
      const createPath = hasPagePath ? pagePath : "/";
      this.ctx.storage.sql.exec(
        `INSERT INTO visitors (
           id, contact_id, display_name, email, page_path, status,
           first_seen_at, last_seen_at, last_offline_at, return_count, user_agent, active_ticket_id,
           ip, country, city, region, as_org, browser, os, device, language, timezone, screen, referrer,
           enrichment_json
         ) VALUES (?, NULL, ?, ?, ?, 'online', ?, ?, NULL, 0, ?, NULL,
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        visitorId,
        displayName,
        email,
        createPath,
        ts,
        ts,
        ua,
        meta.ip,
        meta.country,
        meta.city,
        meta.region,
        meta.as_org,
        meta.browser,
        meta.os,
        meta.device,
        meta.language,
        meta.timezone,
        meta.screen,
        meta.referrer,
        enrichmentJsonNew,
      );
      this.recordPresenceEvent(visitorId, "online", ts, createPath);
      const createdRow = {
        id: visitorId,
        display_name: displayName,
        email,
        ...meta,
      };
      this.broadcastAgents({
        type: "presence",
        visitorId,
        status: "online",
        returned: false,
        newVisitor: true,
        pagePath: createPath,
        activeChatId: null,
        at: ts,
        ...agentFields(createdRow),
      });
      void this.ensurePresenceAlarm();
      this.scheduleVisitorGitFlush();
      return { ok: true, visitorId, returned, created, activeChatId: null };
    }

    visitorId = id();
    created = true;
    const enrichmentJsonBrand = enrichmentIn
      ? JSON.stringify(enrichmentIn).slice(0, 4000)
      : null;
    const brandPath = hasPagePath ? pagePath : "/";
    this.ctx.storage.sql.exec(
      `INSERT INTO visitors (
         id, contact_id, display_name, email, page_path, status,
         first_seen_at, last_seen_at, last_offline_at, return_count, user_agent, active_ticket_id,
         ip, country, city, region, as_org, browser, os, device, language, timezone, screen, referrer,
         enrichment_json
       ) VALUES (?, NULL, ?, ?, ?, 'online', ?, ?, NULL, 0, ?, NULL,
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      visitorId,
      displayName,
      email,
      brandPath,
      ts,
      ts,
      ua,
      meta.ip,
      meta.country,
      meta.city,
      meta.region,
      meta.as_org,
      meta.browser,
      meta.os,
      meta.device,
      meta.language,
      meta.timezone,
      meta.screen,
      meta.referrer,
      enrichmentJsonBrand,
    );
    this.recordPresenceEvent(visitorId, "online", ts, brandPath);
    const createdRow = {
      id: visitorId,
      display_name: displayName,
      email,
      ...meta,
    };
    this.broadcastAgents({
      type: "presence",
      visitorId,
      status: "online",
      returned: false,
      newVisitor: true,
      pagePath: brandPath,
      activeChatId: null,
      at: ts,
      ...agentFields(createdRow),
    });
    void this.ensurePresenceAlarm();
    this.scheduleVisitorGitFlush();
    return { ok: true, visitorId, returned, created, activeChatId: null };
  }

  async ensurePresenceAlarm() {
    const existing = await this.ctx.storage.getAlarm();
    if (existing == null) {
      await this.ctx.storage.setAlarm(Date.now() + PRESENCE_ALARM_MS);
    }
  }

  async handleHeartbeat(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    // Staff / admin / CRM app must not pollute visitor presence
    if (body.staff === true || body.role === "agent" || body.role === "staff") {
      return json({ ok: true, ignored: true, reason: "staff" });
    }
    const result = this.upsertPresence({
      visitorId: body.visitorId,
      pagePath: body.pagePath,
      displayName: body.displayName,
      email: body.email,
      ua: body.userAgent,
      profile: body.profile || null,
      enrichment: body.enrichment || null,
      edge: readEdgeVisitorMeta(request),
    });
    return json(result);
  }

  defaultWidget() {
    return {
      accent: "#3db8a0",
      position: "bottom-right",
      greeting: "Hi — thanks for stopping by. How can we help?",
      launcherLabel: "Chat",
      avatarUrl: "",
      offlineMessage:
        "We're away right now. Leave a message and we'll get back to you.",
      showAgentNames: true,
      offlineFormWhenAway: true,
    };
  }

  normalizeWidget(raw) {
    const d = this.defaultWidget();
    if (!raw || typeof raw !== "object") return { ...d };
    const accent = String(raw.accent || d.accent).trim();
    return {
      accent: /^#[0-9a-fA-F]{3,8}$/.test(accent) ? accent : d.accent,
      position: raw.position === "bottom-left" ? "bottom-left" : "bottom-right",
      greeting: String(raw.greeting ?? d.greeting).slice(0, 280),
      launcherLabel:
        String(raw.launcherLabel ?? d.launcherLabel).slice(0, 40) ||
        d.launcherLabel,
      avatarUrl: String(raw.avatarUrl ?? "").trim().slice(0, 500),
      offlineMessage: String(raw.offlineMessage ?? d.offlineMessage).slice(
        0,
        400,
      ),
      showAgentNames: raw.showAgentNames !== false,
      offlineFormWhenAway: raw.offlineFormWhenAway !== false,
    };
  }

  /** Site widget greeting for quiet system openers (not agent-authored). */
  currentWidgetGreeting() {
    try {
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT widget_json FROM site_settings WHERE id = 'default' LIMIT 1`,
        )
        .toArray();
      if (rows.length) {
        let raw = null;
        try {
          raw = JSON.parse(rows[0].widget_json || "null");
        } catch {
          raw = null;
        }
        return this.normalizeWidget(raw).greeting;
      }
    } catch {
      /* ignore */
    }
    return this.defaultWidget().greeting;
  }

  defaultBranding() {
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // return {
    //   logoUrl: "https://webstudio.ackvyn.org/brand/ackvyn-mini.svg",
    //   wordmark: "Ackvyn",
    //   accentWord: "Web Studio",
    //   productLabel: "CRM",
    //   ...
    // };
    // NEW CODE - TESTING: portable default — Ackvyn CRM, no icon
    return {
      logoUrl: "",
      wordmark: "Ackvyn",
      accentWord: "CRM",
      productLabel: "",
      accent: "#3db8a0",
      tagline: "Sign in with GitHub to open the CRM.",
      mode: "dark",
    };
  }

  normalizeBranding(raw) {
    if (!raw || typeof raw !== "object") return this.defaultBranding();
    const base = this.defaultBranding();
    const accent = String(raw.accent || base.accent).trim();
    return {
      logoUrl: String(raw.logoUrl ?? base.logoUrl).trim().slice(0, 500),
      wordmark: String(raw.wordmark ?? base.wordmark).trim().slice(0, 80) || base.wordmark,
      accentWord: String(raw.accentWord ?? base.accentWord).trim().slice(0, 80),
      productLabel: String(raw.productLabel ?? base.productLabel).trim().slice(0, 40),
      accent: /^#[0-9a-fA-F]{3,8}$/.test(accent) ? accent : base.accent,
      tagline: String(raw.tagline ?? base.tagline).trim().slice(0, 280),
      mode: raw.mode === "light" ? "light" : "dark",
    };
  }

  defaultTickets() {
    return {
      statuses: [
        { key: "open", label: "Open", category: "open", builtin: true },
        {
          key: "pending",
          label: "Pending",
          category: "pending",
          builtin: true,
        },
        { key: "closed", label: "Closed", category: "closed", builtin: true },
      ],
      types: ["Support", "Sales", "Billing", "Project"],
      sources: [
        "email",
        "phone",
        "form",
        "chat",
        "walk-in",
        "admin",
        "other",
      ],
    };
  }

  normalizeTickets(raw) {
    const base = this.defaultTickets();
    const builtins = [
      { key: "open", label: "Open", category: "open", builtin: true },
      {
        key: "pending",
        label: "Pending",
        category: "pending",
        builtin: true,
      },
      { key: "closed", label: "Closed", category: "closed", builtin: true },
    ];
    if (!raw || typeof raw !== "object") {
      return {
        statuses: builtins.map((s) => ({ ...s })),
        types: [...base.types],
        sources: [...base.sources],
      };
    }
    const clean = (v, max = 48) => {
      const s = String(v || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, max);
      return s || null;
    };
    const list = (arr, fallback) => {
      if (!Array.isArray(arr)) return [...fallback];
      const out = [];
      const seen = new Set();
      for (const item of arr) {
        const s = clean(item);
        if (!s) continue;
        const key = s.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(s);
      }
      return out.length ? out : [...fallback];
    };
    const asCat = (v) => {
      const s = String(v || "")
        .trim()
        .toLowerCase();
      return s === "open" || s === "pending" || s === "closed" ? s : null;
    };
    const slug = (label) =>
      String(label || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "status";

    const byKey = new Map(builtins.map((s) => [s.key, { ...s }]));
    if (Array.isArray(raw.statuses)) {
      for (const row of raw.statuses) {
        if (typeof row === "string") {
          const s = clean(row);
          if (!s) continue;
          const key = slug(s);
          if (key === "open" || key === "pending" || key === "closed") continue;
          if (byKey.has(key)) continue;
          byKey.set(key, {
            key,
            label: s,
            category: "open",
            builtin: false,
          });
          continue;
        }
        if (!row || typeof row !== "object") continue;
        const label = clean(row.label) || clean(row.key);
        if (!label) continue;
        const key = slug(row.key || label);
        const category = asCat(row.category);
        if (key === "open" || key === "pending" || key === "closed") {
          const b = byKey.get(key);
          byKey.set(key, {
            ...b,
            label: clean(row.label) || b.label,
          });
          continue;
        }
        if (!category) continue;
        byKey.set(key, { key, label, category, builtin: false });
      }
    }
    const statuses = [
      byKey.get("open"),
      byKey.get("pending"),
      byKey.get("closed"),
      ...[...byKey.values()].filter((s) => !s.builtin),
    ];

    // NEW CODE - TESTING: flat type labels (migrate old {label,subtypes})
    let types = [];
    if (Array.isArray(raw.types)) {
      for (const row of raw.types) {
        if (typeof row === "string") {
          const label = clean(row);
          if (label) types.push(label);
          continue;
        }
        if (!row || typeof row !== "object") continue;
        const label = clean(row.label);
        if (label) types.push(label);
      }
    }
    types = list(types, base.types);
    const sources = list(raw.sources, base.sources).map((s) =>
      s.toLowerCase(),
    );
    return { statuses, types, sources };
  }

  defaultSettings() {
    return {
      displayName: "",
      allowedOrigins: [],
      forms: [
        {
          id: "contact",
          label: "Contact form",
          kind: "intake",
          path: "/contact",
        },
      ],
      widgets: [
        { id: "float", label: "Floating chat", kind: "float" },
        { id: "inline", label: "Inline chat", kind: "inline" },
      ],
      widget: this.defaultWidget(),
      branding: this.defaultBranding(),
      inboundMailbox: "",
      mailtoCopyMode: "cc",
      // NEW CODE - TESTING: off until operator enables Cloudflare Email Sending
      workerOutboundEmail: false,
      agentEmails: [],
      tickets: this.defaultTickets(),
      updated_at: null,
    };
  }

  normalizeAgentEmails(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const out = [];
    const seen = new Set();
    for (const item of list) {
      const email = String(item || "")
        .trim()
        .toLowerCase()
        .slice(0, 200);
      if (!email || !email.includes("@") || seen.has(email)) continue;
      seen.add(email);
      out.push(email);
      if (out.length >= 80) break;
    }
    return out;
  }

  readSettingsRow() {
    const rows = this.ctx.storage.sql
      .exec(`SELECT * FROM site_settings WHERE id = 'default' LIMIT 1`)
      .toArray();
    if (!rows.length) return null;
    const r = rows[0];
    const parse = (raw, fallback) => {
      try {
        const v = JSON.parse(raw || "null");
        return v == null ? fallback : v;
      } catch {
        return fallback;
      }
    };
    const copyMode =
      r.mailto_copy_mode === "bcc" ? "bcc" : "cc";
    return {
      displayName: r.display_name || "",
      allowedOrigins: parse(r.allowed_origins, []),
      forms: parse(r.forms_json, []),
      widgets: parse(r.widgets_json, []),
      widget: this.normalizeWidget(parse(r.widget_json, null)),
      branding: this.normalizeBranding(parse(r.branding_json, null)),
      inboundMailbox: String(r.inbound_mailbox || "").trim(),
      mailtoCopyMode: copyMode,
      // NEW CODE - TESTING
      workerOutboundEmail:
        String(r.worker_outbound_email || "0").trim() === "1",
      agentEmails: this.normalizeAgentEmails(parse(r.agent_emails_json, [])),
      tickets: this.normalizeTickets(parse(r.tickets_json, null)),
      updated_at: r.updated_at,
    };
  }

  countOnlineAgents() {
    let n = 0;
    for (const ws of this.ctx.getWebSockets()) {
      let meta = this.sessions.get(ws);
      if (!meta) {
        try {
          meta = ws.deserializeAttachment();
        } catch {
          meta = null;
        }
      }
      if (meta && meta.kind === "agent") n += 1;
    }
    return n;
  }

  /**
   * Agents “available” for the site widget:
   * live CRM WebSockets OR background Web Push subscriptions (phone shortcut).
   * Stale push endpoints are pruned when a push returns 410/404.
   */
  countReachableAgents() {
    const sockets = this.countOnlineAgents();
    const push = countPushSubscriptions(this.ctx.storage.sql);
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING: sockets only
    // return sockets;
    // NEW CODE - TESTING: push-subscribed phones count as online for the widget
    return Math.max(sockets, push);
  }

  handleAgentsStatus() {
    const agentSockets = this.countOnlineAgents();
    const pushSubscriptions = countPushSubscriptions(this.ctx.storage.sql);
    return json({
      // NEW CODE - TESTING: reachable = live CRM tab OR push-subscribed device
      onlineAgents: this.countReachableAgents(),
      agentSockets,
      pushSubscriptions,
      at: now(),
    });
  }

  /** Session-gated GA4 config status (never returns private key). */
  // NEW CODE - TESTING: Web Push endpoints (session-gated)
  async pushAgentsFromEvent(payload) {
    try {
      await sendWebPushToAgents(this.ctx.storage.sql, this.env, payload);
    } catch {
      /* best-effort */
    }
  }

  async handlePushVapidPublic(request) {
    const user = await assertCrmSession(request, this.env);
    if (!user) return json({ error: "unauthorized" }, 401);
    const { publicKey } = await getOrCreateVapid(this.ctx.storage.sql);
    return json({ publicKey });
  }

  async handlePushSubscribe(request) {
    const user = await assertCrmSession(request, this.env);
    if (!user) return json({ error: "unauthorized" }, 401);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    try {
      upsertPushSubscription(
        this.ctx.storage.sql,
        body?.subscription || body,
        user.login,
        request.headers.get("User-Agent") || "",
      );
    } catch (err) {
      return json(
        { error: err instanceof Error ? err.message : "subscribe_failed" },
        400,
      );
    }
    return json({ ok: true });
  }

  async handlePushUnsubscribe(request) {
    const user = await assertCrmSession(request, this.env);
    if (!user) return json({ error: "unauthorized" }, 401);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    deletePushSubscription(this.ctx.storage.sql, body?.endpoint || "");
    return json({ ok: true });
  }

  async handleGaGetConfig(request) {
    const user = await assertCrmSession(request, this.env);
    if (!user) return json({ error: "unauthorized" }, 401);
    const status = await getGaConfigPublic(
      this.ctx.storage,
      this.env,
      this.ctx.id.name,
    );
    return json(status);
  }

  async handleGaPutConfig(request) {
    const user = await assertCrmSession(request, this.env);
    if (!user) return json({ error: "unauthorized" }, 401);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    try {
      const parsed = parseGaConfigInput(body, { allowMissingSa: true });
      const status = await saveGaConfig(
        this.ctx.storage,
        this.env,
        this.ctx.id.name,
        parsed,
      );
      return json(status);
    } catch (err) {
      const code = err instanceof Error ? err.message : "save_failed";
      const status =
        code === "passphrase_not_configured"
          ? 503
          : code === "sa_json_too_large"
            ? 413
            : 400;
      return json({ error: code }, status);
    }
  }

  async handleGaDeleteConfig(request) {
    const user = await assertCrmSession(request, this.env);
    if (!user) return json({ error: "unauthorized" }, 401);
    await clearGaConfig(this.ctx.storage);
    return json({ configured: false, ok: true });
  }

  async handleGaReport(request, url) {
    const user = await assertCrmSession(request, this.env);
    if (!user) return json({ error: "unauthorized" }, 401);
    const range = String(url.searchParams.get("range") || "7d");
    try {
      const report = await runGaSiteReport(
        this.ctx.storage,
        this.env,
        this.ctx.id.name,
        range,
      );
      return json(report);
    } catch (err) {
      const code = err instanceof Error ? err.message : "report_failed";
      if (code === "ga_not_configured") {
        return json({ error: "ga_not_configured" }, 404);
      }
      if (code === "passphrase_not_configured") {
        return json({ error: code }, 503);
      }
      return json(
        { error: "ga_report_failed", detail: String(code).slice(0, 240) },
        502,
      );
    }
  }

  async handleReviewsGetConfig(request) {
    const user = await assertCrmSession(request, this.env);
    if (!user) return json({ error: "unauthorized" }, 401);
    const status = await getReviewsConfigPublic(
      this.ctx.storage,
      this.env,
      this.ctx.id.name,
    );
    return json(status);
  }

  async handleReviewsPutConfig(request) {
    const user = await assertCrmSession(request, this.env);
    if (!user) return json({ error: "unauthorized" }, 401);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    try {
      const parsed = parseReviewsConfigInput(body, { allowMissingKey: true });
      const status = await saveReviewsConfig(
        this.ctx.storage,
        this.env,
        this.ctx.id.name,
        parsed,
      );
      // NEW CODE - TESTING: first sync after save (Places + content/reviews.json)
      let sync = null;
      try {
        sync = await syncReviewsToGit(
          this.ctx.storage,
          this.env,
          this.ctx.id.name,
          { force: true },
        );
      } catch (syncErr) {
        sync = {
          ok: false,
          error: syncErr instanceof Error ? syncErr.message : "sync_failed",
        };
      }
      return json({ ...status, sync });
    } catch (err) {
      const code = err instanceof Error ? err.message : "save_failed";
      const status =
        code === "passphrase_not_configured"
          ? 503
          : code === "invalid_api_key" || code === "invalid_place_id"
            ? 400
            : 400;
      return json({ error: code }, status);
    }
  }

  async handleReviewsDeleteConfig(request) {
    const user = await assertCrmSession(request, this.env);
    if (!user) return json({ error: "unauthorized" }, 401);
    await clearReviewsConfig(this.ctx.storage);
    return json({ configured: false, ok: true });
  }

  async handleReviewsSync(request) {
    const user = await assertCrmSession(request, this.env);
    if (!user) return json({ error: "unauthorized" }, 401);
    let force = true;
    try {
      const body = await request.json();
      if (body && body.force === false) force = false;
    } catch {
      /* empty body ok */
    }
    try {
      const result = await syncReviewsToGit(
        this.ctx.storage,
        this.env,
        this.ctx.id.name,
        { force },
      );
      return json(result);
    } catch (err) {
      const code = err instanceof Error ? err.message : "sync_failed";
      if (code === "reviews_not_configured") {
        return json({ error: code }, 404);
      }
      if (code === "git_store_not_configured") {
        return json({ error: code }, 503);
      }
      return json(
        { error: "reviews_sync_failed", detail: String(code).slice(0, 240) },
        502,
      );
    }
  }

  /** Cron / Worker scheduled — passphrase header, not session. */
  async handleReviewsCronSync(request) {
    const expected = String(this.env.CRM_DATA_PASSPHRASE || "").trim();
    const got = String(request.headers.get("X-Ackvyn-Cron") || "").trim();
    if (!expected || got !== expected) {
      return json({ error: "unauthorized" }, 401);
    }
    try {
      const result = await syncReviewsToGit(
        this.ctx.storage,
        this.env,
        this.ctx.id.name,
        { force: false },
      );
      return json(result);
    } catch (err) {
      const code = err instanceof Error ? err.message : "sync_failed";
      if (code === "reviews_not_configured") {
        return json({ ok: true, skipped: true, reason: code });
      }
      return json(
        { error: "reviews_sync_failed", detail: String(code).slice(0, 240) },
        502,
      );
    }
  }

  /** Cached only — site homepage uses content/reviews.json. */
  async handlePublicReviews() {
    try {
      const payload = await fetchPublicReviews(
        this.ctx.storage,
        this.env,
        this.ctx.id.name,
      );
      return json(payload);
    } catch (err) {
      const code = err instanceof Error ? err.message : "reviews_failed";
      if (code === "reviews_not_configured" || code === "reviews_not_synced") {
        return json({ error: code }, 404);
      }
      if (code === "passphrase_not_configured") {
        return json({ error: code }, 503);
      }
      return json(
        { error: "reviews_fetch_failed", detail: String(code).slice(0, 240) },
        502,
      );
    }
  }

  async handleGetSettings() {
    const settings = this.readSettingsRow() || this.defaultSettings();
    // NEW CODE - TESTING: binding presence ≠ paid entitlement (toggle + CF account required)
    return json({
      settings,
      emailSendBinding: hasEmailSendBinding(this.env),
    });
  }

  async handlePatchSettings(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const cur = this.readSettingsRow() || this.defaultSettings();
    const displayName =
      body.displayName != null
        ? String(body.displayName).trim().slice(0, 120)
        : cur.displayName;
    const allowedOrigins = Array.isArray(body.allowedOrigins)
      ? body.allowedOrigins.map(String).slice(0, 40)
      : cur.allowedOrigins;
    const forms = Array.isArray(body.forms) ? body.forms : cur.forms;
    const widgets = Array.isArray(body.widgets) ? body.widgets : cur.widgets;
    const widget = this.normalizeWidget(
      body.widget != null ? { ...cur.widget, ...body.widget } : cur.widget,
    );
    // NEW CODE - TESTING: public branding mirror for pre-auth /crm login
    const branding = this.normalizeBranding(
      body.branding != null ? { ...cur.branding, ...body.branding } : cur.branding,
    );
    const inboundMailbox =
      body.inboundMailbox != null
        ? String(body.inboundMailbox).trim().toLowerCase().slice(0, 200)
        : cur.inboundMailbox || "";
    const mailtoCopyMode =
      body.mailtoCopyMode === "bcc" || body.mailtoCopyMode === "cc"
        ? body.mailtoCopyMode
        : cur.mailtoCopyMode || "cc";
    // NEW CODE - TESTING: CRM toggle — still requires CF Email Sending on the account
    const workerOutboundEmail =
      body.workerOutboundEmail != null
        ? Boolean(body.workerOutboundEmail)
        : Boolean(cur.workerOutboundEmail);
    const agentEmails =
      body.agentEmails != null
        ? this.normalizeAgentEmails(body.agentEmails)
        : cur.agentEmails || [];
    const tickets = this.normalizeTickets(
      body.tickets != null ? body.tickets : cur.tickets,
    );
    const ts = now();
    this.ctx.storage.sql.exec(
      `INSERT INTO site_settings (id, display_name, allowed_origins, forms_json, widgets_json, widget_json, branding_json, inbound_mailbox, mailto_copy_mode, worker_outbound_email, agent_emails_json, tickets_json, updated_at)
       VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         display_name = excluded.display_name,
         allowed_origins = excluded.allowed_origins,
         forms_json = excluded.forms_json,
         widgets_json = excluded.widgets_json,
         widget_json = excluded.widget_json,
         branding_json = excluded.branding_json,
         inbound_mailbox = excluded.inbound_mailbox,
         mailto_copy_mode = excluded.mailto_copy_mode,
         worker_outbound_email = excluded.worker_outbound_email,
         agent_emails_json = excluded.agent_emails_json,
         tickets_json = excluded.tickets_json,
         updated_at = excluded.updated_at`,
      displayName,
      JSON.stringify(allowedOrigins),
      JSON.stringify(forms),
      JSON.stringify(widgets),
      JSON.stringify(widget),
      JSON.stringify(branding),
      inboundMailbox,
      mailtoCopyMode,
      workerOutboundEmail ? "1" : "0",
      JSON.stringify(agentEmails),
      JSON.stringify(tickets),
      ts,
    );
    return json({
      ok: true,
      emailSendBinding: hasEmailSendBinding(this.env),
      settings: {
        displayName,
        allowedOrigins,
        forms,
        widgets,
        widget,
        branding,
        inboundMailbox,
        mailtoCopyMode,
        workerOutboundEmail,
        agentEmails,
        tickets,
        updated_at: ts,
      },
    });
  }

  /**
   * Session-gated outbound via Cloudflare Email Sending (site toggle must be on).
   * @param {string} ticketId
   * @param {Request} request
   */
  async handleSendTicketEmail(ticketId, request) {
    const user = await assertCrmSession(request, this.env);
    if (!user) return json({ error: "unauthorized" }, 401);

    const settings = this.readSettingsRow() || this.defaultSettings();
    if (!settings.workerOutboundEmail) {
      return json(
        {
          error: "worker_outbound_disabled",
          hint: "Turn on “Send email from Worker” in Settings → Sites, after enabling Cloudflare Email Sending on your account.",
        },
        403,
      );
    }

    const from = String(settings.inboundMailbox || "")
      .trim()
      .toLowerCase();
    if (!from) {
      return json(
        {
          error: "inbound_mailbox_required",
          hint: "Set CRM inbound mailbox (Settings → Sites) — that address is used as From when the Worker sends.",
        },
        400,
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const to = String(body.to || "")
      .trim()
      .toLowerCase();
    const subject = String(body.subject || "").trim().slice(0, 500);
    const text = String(body.text || body.body || "").trim();
    const html =
      body.html != null ? String(body.html).trim().slice(0, 200000) : "";

    try {
      const result = await sendTicketOutboundEmail(this.env, this.ctx.id.name, {
        ticketId,
        to,
        from,
        subject,
        text,
        html: html || null,
        agentLogin: user.login,
        agentName: user.name || user.login,
      });
      return json(result);
    } catch (err) {
      const payload = outboundEmailErrorPayload(err);
      const status =
        payload.code === "E_FIELD_MISSING" ||
        payload.code === "E_VALIDATION_ERROR"
          ? 400
          : payload.code === "E_BINDING_MISSING"
            ? 503
            : payload.code === "E_RATE_LIMIT_EXCEEDED" ||
                payload.code === "E_DAILY_LIMIT_EXCEEDED"
              ? 429
              : 502;
      return json(payload, status);
    }
  }

  async handleListPresence() {
    this.sweepOfflineVisitors();
    const visitors = this.ctx.storage.sql
      .exec(
        `SELECT * FROM visitors
         ORDER BY
           CASE status WHEN 'online' THEN 0 ELSE 1 END,
           last_seen_at DESC
         LIMIT 200`,
      )
      .toArray();
    return json({
      visitors,
      offlineAfterMs: OFFLINE_AFTER_MS,
      returnNotableMs: RETURN_NOTABLE_MS,
    });
  }

  async handlePresenceEvents(url) {
    const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
    const events = this.ctx.storage.sql
      .exec(
        `SELECT e.*, v.display_name, v.email, v.page_path AS visitor_page
         FROM presence_events e
         LEFT JOIN visitors v ON v.id = e.visitor_id
         ORDER BY e.at DESC LIMIT ?`,
        limit,
      )
      .toArray();
    return json({ events });
  }

  async handleStartChat(visitorId, request) {
    const visitors = this.ctx.storage.sql
      .exec(`SELECT * FROM visitors WHERE id = ? LIMIT 1`, visitorId)
      .toArray();
    if (!visitors.length) return json({ error: "visitor_not_found" }, 404);
    const v = visitors[0];
    let body = {};
    try {
      body = await request.json();
    } catch {
      /* optional body */
    }

    const startedBy = body.startedBy === "agent" ? "agent" : "visitor";

    // OLD CODE - KEEP UNTIL CONFIRMED WORKING: resume only active_chat_id if open/non-archived
    // if (v.active_chat_id) { ... return resumed }

    // NEW CODE - TESTING: one conversation per visitor — reopen latest chat (incl. closed/archived)
    const existing = this.ctx.storage.sql
      .exec(
        `SELECT id, status, archived_at FROM chats
         WHERE visitor_id = ?
         ORDER BY
           CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END,
           CASE WHEN status = 'closed' THEN 1 ELSE 0 END,
           updated_at DESC
         LIMIT 1`,
        visitorId,
      )
      .toArray();
    if (existing.length) {
      const chatId = existing[0].id;
      const tsResume = now();
      this.ctx.storage.sql.exec(
        `UPDATE chats SET status = 'open', archived_at = NULL, closed_at = NULL, updated_at = ?
         WHERE id = ?`,
        tsResume,
        chatId,
      );
      this.ctx.storage.sql.exec(
        `UPDATE visitors SET active_chat_id = ? WHERE id = ?`,
        chatId,
        visitorId,
      );
      // Agent open from CRM: no visitor push — their UI stays closed until a real agent message
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING:
      // this.broadcastVisitor(visitorId, { type: "chat_invite", openPanel: … })
      if (startedBy === "visitor") {
        this.broadcastVisitor(visitorId, {
          type: "chat_invite",
          chatId,
          startedBy,
          resumed: true,
          openPanel: true,
          at: tsResume,
        });
      }
      return json({ ok: true, chatId, resumed: true });
    }

    const ts = now();
    const chatId = id();
    this.ctx.storage.sql.exec(
      `INSERT INTO chats (id, visitor_id, status, started_by, created_at, updated_at)
       VALUES (?, ?, 'open', ?, ?, ?)`,
      chatId,
      visitorId,
      startedBy,
      ts,
      ts,
    );

    // OLD CODE - KEEP UNTIL CONFIRMED WORKING: agent opener as authored agent message
    // const opener = String(body.message || "").trim();
    // INSERT role agent with authorLogin / authorName …

    // NEW CODE - TESTING: seed quiet system greeting (widget copy). Never notify / force-open.
    // Explicit visitor opener (their first typed line) stays a visitor message.
    const visitorOpener =
      startedBy === "visitor" ? String(body.message || "").trim() : "";
    if (visitorOpener) {
      this.ctx.storage.sql.exec(
        `INSERT INTO chat_messages (id, chat_id, role, body, created_at, author_login, author_name)
         VALUES (?, ?, 'visitor', ?, ?, NULL, NULL)`,
        id(),
        chatId,
        visitorOpener.slice(0, 8000),
        ts,
      );
    } else {
      const greeting = this.currentWidgetGreeting();
      if (greeting) {
        this.ctx.storage.sql.exec(
          `INSERT INTO chat_messages (id, chat_id, role, body, created_at, author_login, author_name)
           VALUES (?, ?, 'system', ?, ?, NULL, NULL)`,
          id(),
          chatId,
          greeting.slice(0, 8000),
          ts,
        );
      }
    }

    // Optional identity — never required for chat
    const displayName = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    if (displayName || email) {
      this.ctx.storage.sql.exec(
        `UPDATE visitors SET
           display_name = COALESCE(?, display_name),
           email = COALESCE(?, email)
         WHERE id = ?`,
        displayName || null,
        email || null,
        visitorId,
      );
    }

    this.ctx.storage.sql.exec(
      `UPDATE visitors SET active_chat_id = ? WHERE id = ?`,
      chatId,
      visitorId,
    );

    // Visitor-started: invite can open their panel. Agent-started: silent until a real message.
    if (startedBy === "visitor") {
      this.broadcastVisitor(visitorId, {
        type: "chat_invite",
        chatId,
        startedBy,
        resumed: false,
        openPanel: true,
        at: ts,
        message: null,
      });
      this.broadcastAgents({
        type: "chat_started",
        chatId,
        visitorId,
        startedBy,
        at: ts,
      });
    }

    return json({ ok: true, chatId, resumed: false });
  }

  async handleListChats(url) {
    const limit = Math.min(Number(url.searchParams.get("limit") || 100), 200);
    const visitorId = url.searchParams.get("visitor_id");
    const includeArchived = url.searchParams.get("include") === "archived";
    const clauses = [];
    const params = [];
    if (!includeArchived) {
      clauses.push(`ch.archived_at IS NULL`);
    }
    if (visitorId) {
      clauses.push(`ch.visitor_id = ?`);
      params.push(visitorId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT ch.*,
                v.display_name, v.email, v.page_path, v.status AS visitor_status,
                v.browser, v.os, v.device, v.city, v.country, v.region, v.ip,
                v.language, v.timezone, v.screen, v.referrer
         FROM chats ch
         LEFT JOIN visitors v ON v.id = ch.visitor_id
         ${where}
         ORDER BY ch.updated_at DESC
         LIMIT ?`,
        ...params,
      )
      .toArray();
    return json({ chats: rows });
  }

  async handleGetChat(chatId) {
    const chats = this.ctx.storage.sql
      .exec(
        `SELECT ch.*,
                v.display_name, v.email, v.page_path, v.status AS visitor_status,
                v.browser, v.os, v.device, v.city, v.country, v.region, v.ip,
                v.language, v.timezone, v.screen, v.referrer
         FROM chats ch
         LEFT JOIN visitors v ON v.id = ch.visitor_id
         WHERE ch.id = ? LIMIT 1`,
        chatId,
      )
      .toArray();
    if (!chats.length) return json({ error: "not_found" }, 404);
    const messages = this.ctx.storage.sql
      .exec(
        `SELECT id, role, body, created_at, author_login, author_name FROM chat_messages
         WHERE chat_id = ? ORDER BY created_at ASC`,
        chatId,
      )
      .toArray();
    return json({ chat: chats[0], messages });
  }

  async handlePostChatMessage(chatId, request) {
    const chats = this.ctx.storage.sql
      .exec(`SELECT * FROM chats WHERE id = ? LIMIT 1`, chatId)
      .toArray();
    if (!chats.length) return json({ error: "not_found" }, 404);
    if (chats[0].status === "closed" || chats[0].archived_at) {
      return json({ error: "chat_closed" }, 400);
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const text = String(body.body || "").trim();
    const role = body.role === "agent" ? "agent" : "visitor";
    if (!text) return json({ error: "body_required" }, 400);
    const authorLogin =
      role === "agent"
        ? String(body.authorLogin || body.author_login || "").trim() || null
        : null;
    const authorName =
      role === "agent"
        ? String(body.authorName || body.author_name || "").trim().slice(0, 80) ||
          null
        : null;
    const ts = now();
    const messageId = id();
    this.ctx.storage.sql.exec(
      `INSERT INTO chat_messages (id, chat_id, role, body, created_at, author_login, author_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      messageId,
      chatId,
      role,
      text.slice(0, 8000),
      ts,
      authorLogin,
      authorName,
    );
    this.ctx.storage.sql.exec(
      `UPDATE chats SET updated_at = ? WHERE id = ?`,
      ts,
      chatId,
    );
    const message = {
      id: messageId,
      role,
      body: text.slice(0, 8000),
      created_at: ts,
      author_login: authorLogin,
      author_name: authorName,
    };
    this.broadcastChat(chatId, {
      type: "message",
      chatId,
      ...message,
    });
    // Nudge visitor if agent spoke
    if (role === "agent") {
      this.broadcastVisitor(chats[0].visitor_id, {
        type: "chat_message",
        chatId,
        ...message,
      });
    }
    return json({ ok: true, message });
  }

  async handleCloseChat(chatId) {
    const ts = now();
    const chats = this.ctx.storage.sql
      .exec(`SELECT visitor_id FROM chats WHERE id = ? LIMIT 1`, chatId)
      .toArray();
    this.ctx.storage.sql.exec(
      `UPDATE chats SET status = 'closed', closed_at = ?, updated_at = ?
       WHERE id = ? AND status != 'closed'`,
      ts,
      ts,
      chatId,
    );
    if (chats.length) {
      this.ctx.storage.sql.exec(
        `UPDATE visitors SET active_chat_id = NULL
         WHERE id = ? AND active_chat_id = ?`,
        chats[0].visitor_id,
        chatId,
      );
      this.broadcastVisitor(chats[0].visitor_id, {
        type: "chat_closed",
        chatId,
        at: ts,
      });
    }
    this.broadcastChat(chatId, { type: "chat_closed", chatId, at: ts });
    return json({ ok: true, chatId, closedAt: ts });
  }

  /** Soft-hide: close if open, set archived_at, keep transcript in DO. */
  async handleArchiveChat(chatId) {
    const chats = this.ctx.storage.sql
      .exec(`SELECT * FROM chats WHERE id = ? LIMIT 1`, chatId)
      .toArray();
    if (!chats.length) return json({ error: "not_found" }, 404);
    if (chats[0].archived_at) {
      return json({ ok: true, chatId, archivedAt: chats[0].archived_at });
    }
    const ts = now();
    if (chats[0].status !== "closed") {
      await this.handleCloseChat(chatId);
    }
    this.ctx.storage.sql.exec(
      `UPDATE chats SET archived_at = ?, updated_at = ? WHERE id = ?`,
      ts,
      ts,
      chatId,
    );
    this.broadcastAgents({
      type: "chat_archived",
      chatId,
      visitorId: chats[0].visitor_id,
      at: ts,
    });
    return json({ ok: true, chatId, archivedAt: ts });
  }

  /** Hard delete transcript from DO SQLite. */
  async handleDeleteChat(chatId) {
    const chats = this.ctx.storage.sql
      .exec(`SELECT visitor_id, status FROM chats WHERE id = ? LIMIT 1`, chatId)
      .toArray();
    if (!chats.length) return json({ error: "not_found" }, 404);
    const ts = now();
    const visitorId = chats[0].visitor_id;
    if (chats[0].status !== "closed") {
      this.ctx.storage.sql.exec(
        `UPDATE chats SET status = 'closed', closed_at = ?, updated_at = ?
         WHERE id = ?`,
        ts,
        ts,
        chatId,
      );
      this.broadcastVisitor(visitorId, {
        type: "chat_closed",
        chatId,
        at: ts,
      });
      this.broadcastChat(chatId, { type: "chat_closed", chatId, at: ts });
    }
    this.ctx.storage.sql.exec(
      `UPDATE visitors SET active_chat_id = NULL
       WHERE id = ? AND active_chat_id = ?`,
      visitorId,
      chatId,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM chat_messages WHERE chat_id = ?`,
      chatId,
    );
    this.ctx.storage.sql.exec(`DELETE FROM chats WHERE id = ?`, chatId);
    this.broadcastAgents({
      type: "chat_deleted",
      chatId,
      visitorId,
      at: ts,
    });
    return json({ ok: true, chatId, deleted: true });
  }

  async handleArchiveDue() {
    // Tickets: mark closed records eligible for git (stub).
    // Chats: same idea later — dump transcript then clear from DO SQLite.
    const { commitCrmRecord } = await import("./gitArchive.js");
    const days = Number(this.env.ARCHIVE_AFTER_DAYS || 90);
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const due = this.ctx.storage.sql
      .exec(
        `SELECT id FROM tickets
         WHERE status = 'closed' AND archived_at IS NULL
           AND closed_at IS NOT NULL AND closed_at < ?`,
        cutoff,
      )
      .toArray();
    const ts = now();
    for (const row of due) {
      await commitCrmRecord({
        site: "webstudio",
        kind: "ticket",
        payload: { ticketId: row.id },
      });
      this.ctx.storage.sql.exec(
        `UPDATE tickets SET archived_at = ?, updated_at = ? WHERE id = ?`,
        ts,
        ts,
        row.id,
      );
    }
    return json({
      ok: true,
      archived: due.length,
      note: "SQLite mark only — GitHub archive stub (contacts/tickets → commits next)",
    });
  }

  async handleWebSocket(request, path, url) {
    // ws/agent | ws/visitor/:id | ws/chat/:id?role= | ws/ticket/:id?role= (legacy)
    const parts = path.split("/");
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    if (parts[0] === "ws" && parts[1] === "agent") {
      const meta = { kind: "agent" };
      this.sessions.set(server, meta);
      server.serializeAttachment(meta);
      server.send(
        JSON.stringify({ type: "hello", channel: "agent", at: now() }),
      );
      return new Response(null, { status: 101, webSocket: client });
    }

    if (parts[0] === "ws" && parts[1] === "visitor" && parts[2]) {
      const visitorId = parts[2];
      const meta = { kind: "visitor", visitorId };
      this.sessions.set(server, meta);
      server.serializeAttachment(meta);

      // Capture CF geo/IP on the upgrade itself (no extra HTTP).
      // Do not clobber an existing page_path with "/".
      this.touchVisitorEdge(
        visitorId,
        readEdgeVisitorMeta(request),
        request.headers.get("user-agent"),
      );

      const v = this.ctx.storage.sql
        .exec(
          `SELECT active_chat_id FROM visitors WHERE id = ? LIMIT 1`,
          visitorId,
        )
        .toArray();
      server.send(
        JSON.stringify({
          type: "hello",
          channel: "visitor",
          visitorId,
          activeChatId: v[0]?.active_chat_id || null,
          presenceIntervalMs: PRESENCE_INTERVAL_HINT_MS,
          at: now(),
        }),
      );
      return new Response(null, { status: 101, webSocket: client });
    }

    if (parts[0] === "ws" && parts[1] === "chat" && parts[2]) {
      const chatId = parts[2];
      const role = url.searchParams.get("role") === "agent" ? "agent" : "visitor";
      const chats = this.ctx.storage.sql
        .exec(`SELECT id, status FROM chats WHERE id = ? LIMIT 1`, chatId)
        .toArray();
      if (!chats.length) {
        server.close(1008, "chat_not_found");
        return new Response(null, { status: 101, webSocket: client });
      }
      const meta = { kind: "chat", chatId, role };
      this.sessions.set(server, meta);
      server.serializeAttachment(meta);
      server.send(
        JSON.stringify({
          type: "hello",
          channel: "chat",
          chatId,
          role,
          status: chats[0].status,
        }),
      );
      return new Response(null, { status: 101, webSocket: client });
    }

    if (parts[0] === "ws" && parts[1] === "ticket" && parts[2]) {
      const ticketId = parts[2];
      const role = url.searchParams.get("role") === "agent" ? "agent" : "visitor";
      const tickets = this.ctx.storage.sql
        .exec(`SELECT id, status FROM tickets WHERE id = ? LIMIT 1`, ticketId)
        .toArray();
      if (!tickets.length) {
        server.close(1008, "ticket_not_found");
        return new Response(null, { status: 101, webSocket: client });
      }
      const meta = { kind: "ticket", ticketId, role };
      this.sessions.set(server, meta);
      server.serializeAttachment(meta);
      server.send(
        JSON.stringify({
          type: "hello",
          channel: "ticket",
          ticketId,
          role,
          status: tickets[0].status,
        }),
      );
      return new Response(null, { status: 101, webSocket: client });
    }

    server.close(1008, "bad_path");
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    // Auto-response "ping"/"pong" never reaches here (edge handles it).
    let meta = this.sessions.get(ws);
    if (!meta) {
      const att = ws.deserializeAttachment();
      if (att && typeof att === "object") {
        meta = att;
        this.sessions.set(ws, meta);
      } else {
        return;
      }
    }

    // Raw text ping fallback (if auto-response not available)
    if (typeof message === "string" && message === "ping") {
      try {
        ws.send("pong");
      } catch {
        /* ignore */
      }
      return;
    }

    let data;
    try {
      data = JSON.parse(typeof message === "string" ? message : "");
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "invalid_json" }));
      return;
    }
    if (data.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", at: now() }));
      return;
    }

    // Sparse presence over visitor socket (preferred path — no HTTP Worker hit)
    if (meta.kind === "visitor" && data.type === "presence") {
      if (data.staff === true || data.role === "staff" || data.role === "agent") {
        try {
          ws.send(JSON.stringify({ type: "presence_ack", ignored: true }));
        } catch {
          /* ignore */
        }
        return;
      }
      const result = this.upsertPresence({
        visitorId: meta.visitorId,
        pagePath: data.pagePath,
        displayName: data.displayName,
        email: data.email,
        ua: data.userAgent,
        profile: data.profile || null,
        enrichment: data.enrichment || null,
        edge: null,
      });
      try {
        ws.send(
          JSON.stringify({
            type: "presence_ack",
            visitorId: result.visitorId,
            created: result.created,
            returned: result.returned,
            at: now(),
          }),
        );
      } catch {
        /* ignore */
      }
      return;
    }

    if (meta.kind === "chat" && data.type === "message") {
      const body = String(data.body || "").trim();
      if (!body) return;
      const ts = now();
      const messageId = id();
      const role = meta.role || "visitor";
      const authorLogin =
        role === "agent"
          ? String(data.authorLogin || data.author_login || "").trim() || null
          : null;
      const authorName =
        role === "agent"
          ? String(data.authorName || data.author_name || "").trim().slice(0, 80) ||
            null
          : null;
      this.ctx.storage.sql.exec(
        `INSERT INTO chat_messages (id, chat_id, role, body, created_at, author_login, author_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        messageId,
        meta.chatId,
        role,
        body.slice(0, 8000),
        ts,
        authorLogin,
        authorName,
      );
      this.ctx.storage.sql.exec(
        `UPDATE chats SET updated_at = ? WHERE id = ?`,
        ts,
        meta.chatId,
      );
      const payload = {
        type: "message",
        id: messageId,
        chatId: meta.chatId,
        role,
        body: body.slice(0, 8000),
        created_at: ts,
        author_login: authorLogin,
        author_name: authorName,
      };
      this.broadcastChat(meta.chatId, payload);
      // Agent replies go over chat WS — also nudge visitor socket so the
      // site widget/tab can notify even if chat WS isn't open yet.
      if (role === "agent") {
        const chats = this.ctx.storage.sql
          .exec(
            `SELECT visitor_id FROM chats WHERE id = ? LIMIT 1`,
            meta.chatId,
          )
          .toArray();
        if (chats.length) {
          // OLD CODE - KEEP UNTIL CONFIRMED WORKING: ...payload after type overwrote chat_message
          // this.broadcastVisitor(..., { type: "chat_message", chatId, ...payload })
          // NEW CODE - TESTING: type must win over payload.type ("message")
          this.broadcastVisitor(chats[0].visitor_id, {
            ...payload,
            type: "chat_message",
            chatId: meta.chatId,
          });
        }
      }
      return;
    }
    if (meta.kind === "ticket" && data.type === "message") {
      const body = String(data.body || "").trim();
      if (!body) return;
      const ts = now();
      const messageId = id();
      const role = meta.role || "visitor";
      this.ctx.storage.sql.exec(
        `INSERT INTO messages (id, ticket_id, role, body, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        messageId,
        meta.ticketId,
        role,
        body.slice(0, 8000),
        ts,
      );
      this.ctx.storage.sql.exec(
        `UPDATE tickets SET updated_at = ? WHERE id = ?`,
        ts,
        meta.ticketId,
      );
      this.broadcastTicket(meta.ticketId, {
        type: "message",
        id: messageId,
        ticketId: meta.ticketId,
        role,
        body: body.slice(0, 8000),
        created_at: ts,
      });
    }
  }

  async webSocketClose(ws) {
    this.sessions.delete(ws);
  }

  async webSocketError(ws) {
    this.sessions.delete(ws);
  }

  broadcastAgents(payload) {
    const text = JSON.stringify(payload);
    for (const [ws, meta] of this.sessions) {
      if (meta.kind !== "agent") continue;
      try {
        ws.send(text);
      } catch {
        this.sessions.delete(ws);
      }
    }
    // NEW CODE - TESTING: also Web Push for background agents
    this.ctx.waitUntil(this.pushAgentsFromEvent(payload));
  }

  broadcastVisitor(visitorId, payload) {
    const text = JSON.stringify(payload);
    for (const [ws, meta] of this.sessions) {
      if (meta.kind === "visitor" && meta.visitorId === visitorId) {
        try {
          ws.send(text);
        } catch {
          this.sessions.delete(ws);
        }
      }
    }
  }

  broadcastChat(chatId, payload) {
    const text = JSON.stringify(payload);
    for (const [ws, meta] of this.sessions) {
      if (meta.kind === "chat" && meta.chatId === chatId) {
        try {
          ws.send(text);
        } catch {
          this.sessions.delete(ws);
        }
      }
      if (meta.kind === "agent") {
        try {
          ws.send(text);
        } catch {
          this.sessions.delete(ws);
        }
      }
    }
    // Messages reach agents via chat broadcast — push when CRM is closed
    this.ctx.waitUntil(this.pushAgentsFromEvent(payload));
  }

  broadcastTicket(ticketId, payload) {
    const text = JSON.stringify(payload);
    for (const [ws, meta] of this.sessions) {
      if (meta.kind === "ticket" && meta.ticketId === ticketId) {
        try {
          ws.send(text);
        } catch {
          this.sessions.delete(ws);
        }
      }
      if (meta.kind === "agent") {
        try {
          ws.send(text);
        } catch {
          this.sessions.delete(ws);
        }
      }
    }
  }

  // NEW CODE - TESTING: share-link visual e-sign (Worker-attested audit; not QES)
  async handleCreateSignSession(request) {
    const user = await assertCrmSession(request, this.env);
    if (!user) return json({ error: "unauthorized" }, 401);
    if (!gitStoreConfigured(this.env)) {
      return json(
        {
          error: "git_store_not_configured",
          hint: "Set GITHUB_TOKEN and CRM_DATA_PASSPHRASE on the Worker",
        },
        503,
      );
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const pdfBase64 = String(body.pdfBase64 || "").replace(/\s+/g, "");
    const fields = Array.isArray(body.fields) ? body.fields : [];
    const ticketId = String(body.ticketId || "").trim();
    const contactEmail = String(body.contactEmail || "")
      .trim()
      .toLowerCase();
    if (!pdfBase64 || !ticketId || !contactEmail || !fields.length) {
      return json(
        {
          error: "pdf_fields_ticket_contact_required",
          hint: "Need PDF bytes, at least one field, ticket id, and contact email",
        },
        400,
      );
    }
    const approxBytes = Math.floor((pdfBase64.length * 3) / 4);
    if (approxBytes > Math.floor(2.5 * 1024 * 1024)) {
      return json({ error: "pdf_too_large", hint: "Soft max ~2.5 MB" }, 413);
    }
    const tokenBytes = crypto.getRandomValues(new Uint8Array(24));
    const token = [...tokenBytes]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const ts = now();
    const hours = Math.min(
      168,
      Math.max(1, Number(body.expiresInHours) || 72),
    );
    const expiresAt = new Date(Date.now() + hours * 3600_000).toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO sign_sessions (
        token, ticket_id, contact_id, contact_email, contact_name,
        document_id, filename, fields_json, pdf_b64, unsigned_sha256,
        status, created_at, expires_at, created_by_login
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      token,
      ticketId,
      String(body.contactId || "").trim() || null,
      contactEmail,
      String(body.contactName || "").trim().slice(0, 120) || null,
      String(body.documentId || "").trim() || null,
      String(body.filename || "document.pdf").slice(0, 160),
      JSON.stringify(fields).slice(0, 50_000),
      pdfBase64,
      String(body.unsignedSha256 || "").slice(0, 128) || null,
      ts,
      expiresAt,
      user.login || null,
    );
    const origin = new URL(request.url).origin;
    const site = this.ctx.id.name;
    const shareUrl = `${origin}/v1/${site}/sign/${token}`;
    return json({ ok: true, token, shareUrl, expiresAt });
  }

  // NEW CODE - TESTING: invalidate pending session (agent)
  async handleRevokeSignSession(token, request) {
    const user = await assertCrmSession(request, this.env);
    if (!user) return json({ error: "unauthorized" }, 401);
    const tok = String(token || "").trim();
    if (!tok) return json({ error: "token_required" }, 400);
    const row = this.ctx.storage.sql
      .exec(
        `SELECT status FROM sign_sessions WHERE token = ?`,
        tok,
      )
      .toArray()[0];
    if (!row) return json({ error: "not_found" }, 404);
    if (row.status === "completed") {
      return json(
        {
          error: "already_completed",
          hint: "Cannot revoke a completed signing session",
        },
        409,
      );
    }
    if (row.status === "revoked") {
      return json({ ok: true, already: true });
    }
    this.ctx.storage.sql.exec(
      `UPDATE sign_sessions
       SET status = 'revoked', pdf_b64 = NULL
       WHERE token = ?`,
      tok,
    );
    return json({ ok: true });
  }

  handleSignPage(token, request) {
    const row = this.ctx.storage.sql
      .exec(`SELECT status, expires_at FROM sign_sessions WHERE token = ?`, token)
      .toArray()[0];
    if (!row) {
      return new Response("Signing link not found or already used.", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    if (row.status !== "pending" || row.expires_at < now()) {
      // NEW CODE - TESTING: clearer message when agent revoked
      const msg =
        row.status === "revoked"
          ? "This signing link was revoked."
          : "This signing link has expired or was already used.";
      return new Response(msg, {
        status: 410,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    const origin = new URL(request.url).origin;
    const html = buildSignPageHtml({
      siteKey: this.ctx.id.name,
      token,
      apiBase: origin,
    });
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  handleSignEnvelope(token) {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT status, expires_at, filename, fields_json, pdf_b64,
                contact_email, contact_name, unsigned_sha256
         FROM sign_sessions WHERE token = ?`,
        token,
      )
      .toArray()[0];
    if (!row) return json({ error: "not_found" }, 404);
    if (row.status !== "pending" || row.expires_at < now()) {
      return json({ error: "expired_or_used" }, 410);
    }
    let fields = [];
    try {
      fields = JSON.parse(row.fields_json || "[]");
    } catch {
      fields = [];
    }
    return json({
      ok: true,
      filename: row.filename,
      fields,
      pdfBase64: row.pdf_b64,
      contactEmail: row.contact_email,
      contactName: row.contact_name,
      unsignedSha256: row.unsigned_sha256,
    });
  }

  async handleSignComplete(token, request) {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT * FROM sign_sessions WHERE token = ?`,
        token,
      )
      .toArray()[0];
    if (!row) return json({ error: "not_found" }, 404);
    if (row.status !== "pending") {
      return json({ error: "already_used" }, 409);
    }
    if (row.expires_at < now()) {
      this.ctx.storage.sql.exec(
        `UPDATE sign_sessions SET status = 'expired' WHERE token = ?`,
        token,
      );
      return json({ error: "expired" }, 410);
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const signedPdfBase64 = String(body.signedPdfBase64 || "").replace(
      /\s+/g,
      "",
    );
    if (!signedPdfBase64) return json({ error: "signed_pdf_required" }, 400);
    const approxBytes = Math.floor((signedPdfBase64.length * 3) / 4);
    if (approxBytes > Math.floor(3 * 1024 * 1024)) {
      return json({ error: "signed_pdf_too_large" }, 413);
    }
    const edge = readEdgeVisitorMeta(request);
    const signerIp =
      (edge && edge.ip) ||
      request.headers.get("cf-connecting-ip") ||
      "";
    const signerUa = (request.headers.get("user-agent") || "").slice(0, 300);
    const signerName = String(body.signerName || row.contact_name || "")
      .trim()
      .slice(0, 120);
    const signedSha256 = String(body.signedSha256 || "").slice(0, 128);
    const ts = now();
    const baseName = String(row.filename || "document.pdf").replace(
      /\.pdf$/i,
      "",
    );
    try {
      await appendSignedPdfToTicket(this.env, this.ctx.id.name, {
        ticketId: row.ticket_id,
        filename: `${baseName}-signed.pdf`,
        dataBase64: signedPdfBase64,
        contactEmail: row.contact_email,
        contactName: signerName || row.contact_name,
        unsignedSha256: row.unsigned_sha256,
        signedSha256,
        token,
        signerIp,
        signerUa,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "attach_failed";
      return json({ error: msg }, msg === "ticket_not_found" ? 404 : 502);
    }
    this.ctx.storage.sql.exec(
      `UPDATE sign_sessions SET
        status = 'completed',
        completed_at = ?,
        signed_sha256 = ?,
        signer_name = ?,
        signer_ip = ?,
        signer_ua = ?,
        pdf_b64 = ''
       WHERE token = ?`,
      ts,
      signedSha256 || null,
      signerName || null,
      String(signerIp).slice(0, 64) || null,
      signerUa || null,
      token,
    );
    this.broadcastTicket(row.ticket_id, {
      type: "ticket_signed",
      ticketId: row.ticket_id,
      token: token.slice(0, 8),
    });
    return json({ ok: true, ticketId: row.ticket_id });
  }
}
