/**
 * Worker → GitHub Contents API for encrypted CRM blobs.
 * Used by form intake + inbound email. Admin UI reads the same files client-side.
 *
 * Secrets: GITHUB_TOKEN, CRM_DATA_PASSPHRASE
 * Vars: CRM_GIT_REPO, CRM_GIT_BRANCH, CRM_GIT_PATH_PREFIX
 */

import { decryptJson, deriveCrmDataKey, encryptJson } from "./crmCrypto.js";

function gitCfg(env) {
  return {
    token: env.GITHUB_TOKEN || "",
    passphrase: env.CRM_DATA_PASSPHRASE || "",
    repo: env.CRM_GIT_REPO || "Ackvyn/Web-Studio",
    branch: env.CRM_GIT_BRANCH || "main",
    pathPrefix: (env.CRM_GIT_PATH_PREFIX || "crm-data").replace(/^\/+|\/+$/g, ""),
  };
}

export function gitStoreConfigured(env) {
  const c = gitCfg(env);
  return Boolean(c.token && c.passphrase && c.repo.includes("/"));
}

function blobPath(cfg, siteKey, name) {
  return `${cfg.pathPrefix}/${siteKey}/${name}`;
}

async function githubGetFile(cfg, path) {
  const [owner, repo] = cfg.repo.split("/");
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(cfg.branch)}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${cfg.token}`,
      "User-Agent": "ackvyn-crm-worker",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub read ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const raw =
    data.encoding === "base64"
      ? atob(String(data.content || "").replace(/\n/g, ""))
      : data.content;
  return { sha: data.sha, content: raw };
}

async function githubPutFile(cfg, path, plainText, message, sha) {
  const [owner, repo] = cfg.repo.split("/");
  const body = {
    message,
    content: utf8ToBase64(plainText),
    branch: cfg.branch,
  };
  if (sha) body.sha = sha;
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
        "User-Agent": "ackvyn-crm-worker",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`GitHub put ${res.status}: ${text.slice(0, 240)}`);
    err.status = res.status;
    throw err;
  }
}

/** UTF-8-safe base64 for GitHub Contents API (reviews may include non-ASCII). */
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(String(str));
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Commit a public (plaintext) JSON file on the site repo — e.g. content/reviews.json.
 * @param {Env} env
 * @param {string} path repo-relative path
 * @param {unknown} data
 * @param {string} message
 */
export async function commitPublicJsonFile(env, path, data, message) {
  if (!gitStoreConfigured(env)) {
    throw new Error("git_store_not_configured");
  }
  const cfg = gitCfg(env);
  const cleanPath = String(path || "").replace(/^\/+/, "");
  if (!cleanPath || cleanPath.includes("..")) {
    throw new Error("invalid_git_path");
  }
  const plain = `${JSON.stringify(data, null, 2)}\n`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const remote = await githubGetFile(cfg, cleanPath);
    try {
      await githubPutFile(
        cfg,
        cleanPath,
        plain,
        message,
        remote?.sha,
      );
      return { ok: true, path: cleanPath };
    } catch (err) {
      if (err && err.status === 409 && attempt < 3) continue;
      throw err;
    }
  }
  throw new Error("git_put_conflict");
}

async function mutateEncryptedJson(env, siteKey, fileName, emptyFile, mutate, message) {
  if (!gitStoreConfigured(env)) {
    throw new Error("git_store_not_configured");
  }
  const cfg = gitCfg(env);
  const path = blobPath(cfg, siteKey, fileName);
  const key = await deriveCrmDataKey(cfg.passphrase, siteKey);

  for (let attempt = 0; attempt < 4; attempt++) {
    const remote = await githubGetFile(cfg, path);
    let file = emptyFile(siteKey);
    if (remote) {
      try {
        file = await decryptJson(remote.content, key);
      } catch {
        throw new Error("git_blob_decrypt_failed — check CRM_DATA_PASSPHRASE");
      }
    }
    mutate(file);
    file.updated_at = new Date().toISOString();
    file.site = siteKey;
    file.version = 1;
    const enc = await encryptJson(file, key);
    try {
      await githubPutFile(cfg, path, enc, message, remote?.sha);
      return file;
    } catch (err) {
      if (err.status === 409 && attempt < 3) continue;
      throw err;
    }
  }
  throw new Error("git_commit_conflict");
}

function emptyContacts(siteKey) {
  return {
    version: 1,
    site: siteKey,
    updated_at: new Date().toISOString(),
    contacts: [],
  };
}

function emptyTickets(siteKey) {
  return {
    version: 1,
    site: siteKey,
    updated_at: new Date().toISOString(),
    tickets: [],
  };
}

function newId() {
  return crypto.randomUUID();
}

/** BMS-style human number: YYYYMMDD-0001 (daily sequence). */
function allocateTicketNumber(tickets, createdAtIso) {
  const d = new Date(createdAtIso || Date.now());
  const prefix =
    String(d.getUTCFullYear()) +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0");
  let max = 0;
  const re = /^(\d{8})-(\d{1,6})$/;
  for (const t of tickets || []) {
    const raw = String(t?.ticket_number || "").trim();
    const m = raw.match(re);
    if (!m || m[1] !== prefix) continue;
    const n = parseInt(m[2] || "0", 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}

/**
 * Upsert contact by email, append ticket with body — one or two commits.
 * @returns {{ ticketId: string, contactId: string }}
 */
export async function commitIntakeTicket(env, siteKey, input) {
  const ts = new Date().toISOString();
  const email = String(input.email || "").trim().toLowerCase();
  const name = String(input.name || "").trim() || email || "Unknown";
  const message = String(input.message || "").trim();
  const messageHtml =
    input.messageHtml != null ? String(input.messageHtml).trim() : "";
  const attachments = Array.isArray(input.attachments)
    ? input.attachments.slice(0, 5)
    : [];
  const businessType = String(input.businessType || "").trim() || null;
  const source = String(input.source || "form").trim() || "form";
  const subject =
    String(input.subject || "").trim() ||
    `Message from ${name}${businessType ? ` (${businessType})` : ""}`;

  let contactId = newId();

  // Contacts blob may use a different passphrase until Settings match Worker secret.
  // Never block ticket intake on that — ticket still commits.
  try {
    await mutateEncryptedJson(
      env,
      siteKey,
      "contacts.json.enc",
      emptyContacts,
      (file) => {
        const idx = file.contacts.findIndex((c) => c.email === email);
        if (idx >= 0) {
          const prev = file.contacts[idx];
          contactId = prev.id;
          // Contact record is curated: intake must not overwrite an existing
          // display name. Ticket still stores its own sender snapshot below.
          const prevName = String(prev.name || "").trim();
          const hasCuratedName =
            Boolean(prevName) &&
            prevName.toLowerCase() !== email &&
            prevName.toLowerCase() !== "unknown";
          file.contacts[idx] = {
            ...prev,
            name: hasCuratedName ? prevName : name,
            business_type: businessType ?? prev.business_type,
            updated_at: ts,
          };
        } else {
          // OLD CODE - KEEP UNTIL CONFIRMED WORKING:
          // { id, name, email, business_type, notes, created_at, updated_at }
          file.contacts.unshift({
            id: contactId,
            name,
            email,
            business_type: businessType,
            notes: null,
            company: null,
            phone: null,
            website: null,
            photo_url: null,
            created_at: ts,
            updated_at: ts,
          });
        }
      },
      `crm(${siteKey}): intake contact ${email}`,
    );
  } catch (err) {
    console.warn(
      "ackvyn-crm: contacts blob skipped (passphrase mismatch?)",
      err instanceof Error ? err.message : err,
    );
  }

  const ticketId = newId();

  await mutateEncryptedJson(
    env,
    siteKey,
    "tickets.json.enc",
    emptyTickets,
    (file) => {
      file.tickets.unshift({
        id: ticketId,
        ticket_number: allocateTicketNumber(file.tickets || [], ts),
        subject,
        status: "open",
        source,
        contact_id: contactId,
        contact_name: name,
        contact_email: email,
        business_type: businessType,
        body: message.slice(0, 100000),
        body_text: message.slice(0, 100000),
        body_html: messageHtml ? messageHtml.slice(0, 250000) : null,
        attachments,
        notes: [],
        created_at: ts,
        updated_at: ts,
        closed_at: null,
      });
    },
    `crm(${siteKey}): intake ticket ${source} ${ticketId.slice(0, 8)}`,
  );

  return { ticketId, contactId };
}

/**
 * Upsert visitor analytics rows into encrypted git (Worker path).
 * Debounced from the Durable Object — not realtime-aggressive.
 */
function emptyVisitors(siteKey) {
  return {
    version: 1,
    site: siteKey,
    updated_at: new Date().toISOString(),
    visitors: [],
    deletedIds: [],
  };
}

/**
 * Upsert visitor analytics rows into encrypted git (Worker path).
 * Debounced from the Durable Object — not realtime-aggressive.
 *
 * Honors `deletedIds` tombstones written by the CRM admin UI so a flush
 * cannot resurrect rows the agent explicitly deleted/cleared.
 *
 * @param {Env} env
 * @param {string} siteKey
 * @param {object[]} visitors
 */
export async function commitVisitorsUpsert(env, siteKey, visitors) {
  if (!gitStoreConfigured(env)) {
    return { ok: false, reason: "git_store_not_configured" };
  }
  if (!Array.isArray(visitors) || visitors.length === 0) {
    return { ok: true, skipped: true };
  }
  const ts = new Date().toISOString();
  await mutateEncryptedJson(
    env,
    siteKey,
    "visitors.json.enc",
    emptyVisitors,
    (file) => {
      if (!Array.isArray(file.visitors)) file.visitors = [];
      // OLD CODE - KEEP UNTIL CONFIRMED WORKING:
      // const byId = new Map(file.visitors.map((v) => [v.id, v]));
      // for (const row of visitors) {
      //   if (!row || !row.id) continue;
      //   const prev = byId.get(row.id) || {};
      //   byId.set(row.id, { ...prev, ...row, enrichment: ..., synced_at: ts });
      // }
      // file.visitors = [...byId.values()].sort(...).slice(0, 500);
      // NEW CODE - TESTING: skip + strip tombstoned ids
      if (!Array.isArray(file.deletedIds)) file.deletedIds = [];
      const deleted = new Set(file.deletedIds.filter(Boolean));
      const byId = new Map(
        file.visitors
          .filter((v) => v && v.id && !deleted.has(v.id))
          .map((v) => [v.id, v]),
      );
      for (const row of visitors) {
        if (!row || !row.id || deleted.has(row.id)) continue;
        const prev = byId.get(row.id) || {};
        byId.set(row.id, {
          ...prev,
          ...row,
          enrichment: row.enrichment || prev.enrichment || null,
          synced_at: ts,
        });
      }
      file.visitors = [...byId.values()]
        .sort((a, b) =>
          String(b.last_seen_at || "").localeCompare(String(a.last_seen_at || "")),
        )
        .slice(0, 500);
      if (file.deletedIds.length > 2000) {
        file.deletedIds = file.deletedIds.slice(file.deletedIds.length - 2000);
      }
    },
    `crm(${siteKey}): upsert visitors (${visitors.length})`,
  );
  return { ok: true };
}

/**
 * Append an inbound email as a note on an existing ticket (mailto CC / reply threading).
 * @returns {{ ticketId: string } | null}
 */
export async function appendInboundEmailToTicket(env, siteKey, input) {
  const ts = new Date().toISOString();
  const ticketIdHint = String(input.ticketIdHint || "").trim();
  const shortId = String(input.shortId || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-f0-9]/g, "")
    .slice(0, 8);
  const kind = input.kind === "agent-outbound" ? "agent-outbound" : "email-reply";
  const from = String(input.from || "").trim().toLowerCase();
  const fromName = String(input.fromName || from).trim();
  const subject = String(input.subject || "").trim().slice(0, 500);
  const message = String(input.message || "").trim().slice(0, 100000);
  const inboundAttachments = Array.isArray(input.attachments)
    ? input.attachments.slice(0, 5)
    : [];

  let matchedId = null;
  let found = false;
  await mutateEncryptedJson(
    env,
    siteKey,
    "tickets.json.enc",
    emptyTickets,
    (file) => {
      if (!Array.isArray(file.tickets)) file.tickets = [];
      let ticket = null;
      if (ticketIdHint) {
        ticket = file.tickets.find((t) => t && t.id === ticketIdHint) || null;
      }
      if (!ticket && shortId) {
        ticket =
          file.tickets.find(
            (t) =>
              t &&
              String(t.id || "")
                .replace(/-/g, "")
                .toLowerCase()
                .startsWith(shortId),
          ) || null;
      }
      if (!ticket) return;
      found = true;
      matchedId = ticket.id;
      const label =
        kind === "agent-outbound"
          ? `Outbound email (agent) · from ${fromName} <${from}>`
          : `Email reply · from ${fromName} <${from}>`;
      const noteBody = [
        label,
        subject ? `Subject: ${subject}` : null,
        "",
        message || "(empty body)",
      ]
        .filter((line) => line != null)
        .join("\n")
        .slice(0, 100000);
      const notes = Array.isArray(ticket.notes) ? [...ticket.notes] : [];
      notes.push({
        id: newId(),
        body: noteBody,
        created_at: ts,
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING
        // author_login: kind === "agent-outbound" ? "mailto" : "email",
        // author_name: kind === "agent-outbound" ? "Agent (mail client)" : fromName
        // NEW CODE - TESTING: keep the verified From on agent notes
        author_login:
          kind === "agent-outbound" ? from.slice(0, 80) : "email",
        author_name:
          kind === "agent-outbound"
            ? fromName.slice(0, 80) || from.slice(0, 80)
            : fromName.slice(0, 80),
      });
      ticket.notes = notes;
      // NEW CODE - TESTING: merge inbound attachments onto ticket (cap 8 total)
      if (inboundAttachments.length) {
        const existing = Array.isArray(ticket.attachments)
          ? [...ticket.attachments]
          : [];
        for (const att of inboundAttachments) {
          if (!att || !att.data_base64) continue;
          if (existing.length >= 8) break;
          existing.push({
            id: att.id || newId(),
            filename: String(att.filename || "attachment")
              .replace(/[^\w.\-()+ ]/g, "_")
              .slice(0, 160),
            content_type: String(att.content_type || "application/octet-stream"),
            content_id: att.content_id || null,
            size: att.size || null,
            data_base64: att.data_base64,
          });
        }
        ticket.attachments = existing;
      }
      ticket.updated_at = ts;
      if (ticket.status === "closed") ticket.status = "open";
    },
    `crm(${siteKey}): email on ticket ${shortId || "ref"}`,
  );
  return found && matchedId ? { ticketId: matchedId } : null;
}

/**
 * Attach a completed signed PDF to a ticket (never Documents library).
 * Also appends an audit note.
 */
export async function appendSignedPdfToTicket(env, siteKey, input) {
  const ts = new Date().toISOString();
  const ticketId = String(input.ticketId || "").trim();
  if (!ticketId) throw new Error("ticket_id_required");
  const filename = String(input.filename || "signed.pdf")
    .replace(/[^\w.\-()+ ]/g, "_")
    .slice(0, 160);
  const dataBase64 = String(input.dataBase64 || "").replace(/\s+/g, "");
  if (!dataBase64) throw new Error("signed_pdf_required");
  const size = Math.floor((dataBase64.length * 3) / 4);
  const auditLines = [
    "Document signed",
    input.contactName || input.contactEmail
      ? `Contact: ${input.contactName || "Signer"}${
          input.contactEmail ? ` <${input.contactEmail}>` : ""
        }`
      : null,
    input.contactEmail && !input.contactName
      ? `Email: ${input.contactEmail}`
      : null,
    `Completed: ${ts}`,
    input.unsignedSha256 ? `Unsigned SHA-256: ${input.unsignedSha256}` : null,
    input.signedSha256 ? `Signed SHA-256: ${input.signedSha256}` : null,
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING: truncated session (hard to match revoke UI)
    // input.token ? `Session: ${String(input.token).slice(0, 12)}…` : null,
    // NEW CODE - TESTING: full session token so CRM can hide Revoke after complete
    input.token ? `Session: ${String(input.token)}` : null,
    input.signerIp ? `IP: ${input.signerIp}` : null,
    input.signerUa ? `UA: ${String(input.signerUa).slice(0, 200)}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  let found = false;
  await mutateEncryptedJson(
    env,
    siteKey,
    "tickets.json.enc",
    emptyTickets,
    (file) => {
      if (!Array.isArray(file.tickets)) file.tickets = [];
      const ticket = file.tickets.find((t) => t && t.id === ticketId);
      if (!ticket) return;
      found = true;
      const attachments = Array.isArray(ticket.attachments)
        ? [...ticket.attachments]
        : [];
      attachments.push({
        id: newId(),
        filename,
        content_type: "application/pdf",
        content_id: null,
        size,
        data_base64: dataBase64,
      });
      ticket.attachments = attachments.slice(0, 12);
      const notes = Array.isArray(ticket.notes) ? [...ticket.notes] : [];
      notes.push({
        id: newId(),
        body: auditLines.slice(0, 20000),
        created_at: ts,
        author_login: "e-sign",
        author_name: "E-sign",
        kind: "note",
      });
      ticket.notes = notes;
      ticket.updated_at = ts;
    },
    `crm(${siteKey}): signed PDF ticket ${ticketId.slice(0, 8)}`,
  );
  if (!found) throw new Error("ticket_not_found");
  return { ticketId, ok: true };
}

/**
 * Map inbound address → site key.
 * CRM_EMAIL_ALIASES = "info@ackvyn.org:webstudio,hello@…:neatnik"
 * Fallback: CRM_INBOUND_EMAIL_SITE or "webstudio"
 */
export function siteKeyFromInboundTo(env, toAddress) {
  const to = String(toAddress || "").trim().toLowerCase();
  const aliases = String(env.CRM_EMAIL_ALIASES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const entry of aliases) {
    const [addr, site] = entry.split(":").map((s) => s.trim().toLowerCase());
    if (addr && site && (addr === to || to.endsWith(`<${addr}>`))) {
      return site.replace(/[^a-z0-9_-]/g, "");
    }
  }
  return String(env.CRM_INBOUND_EMAIL_SITE || "webstudio")
    .replace(/[^a-z0-9_-]/gi, "")
    .toLowerCase();
}
