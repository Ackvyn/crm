/**
 * Inbound Email Routing → encrypted ticket commit on GitHub.
 *
 * Keeps full plain-text + HTML bodies (rich email), plus attachments
 * (images, PDF, common docs; inline CID rewritten to data URLs).
 */

import {
  appendInboundEmailToTicket,
  commitIntakeTicket,
  gitStoreConfigured,
  siteKeyFromInboundTo,
} from "./gitStore.js";
import { parseAckvynTicketRef } from "./ackvynTicketRef.js";

const BODY_TEXT_MAX = 100_000;
const BODY_HTML_MAX = 250_000;
/** Decoded bytes per attachment (git blob size budget). */
const ATTACH_MAX_BYTES = 900_000;
const ATTACH_MAX_COUNT = 5;

/**
 * Site allowlist of agent From addresses (Settings → Sites).
 * Empty list = never treat inbound as agent-outbound (fail closed).
 */
async function isAllowedAgentEmail(env, siteKey, fromEmail) {
  const email = String(fromEmail || "")
    .trim()
    .toLowerCase();
  if (!email || !email.includes("@")) return false;
  try {
    const stub = env.CRM.get(env.CRM.idFromName(siteKey));
    const res = await stub.fetch("https://do/internal/agent-emails", {
      method: "GET",
    });
    if (!res.ok) return false;
    const data = await res.json();
    const list = Array.isArray(data?.emails)
      ? data.emails.map((e) => String(e || "").trim().toLowerCase())
      : [];
    if (!list.length) return false;
    return list.includes(email);
  } catch {
    return false;
  }
}

function parseAngleEmail(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

function headerValue(headersBlock, name) {
  const re = new RegExp(
    `^${name}:\\s*([^\\r\\n]*(?:\\r?\\n[ \\t][^\\r\\n]*)*)`,
    "im",
  );
  const m = String(headersBlock || "").match(re);
  return m ? m[1].replace(/\r?\n[ \t]+/g, " ").trim() : "";
}

function parseContentType(ct) {
  const parts = String(ct || "")
    .split(";")
    .map((s) => s.trim());
  const type = (parts[0] || "").toLowerCase();
  const params = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim().toLowerCase();
    let v = p.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    params[k] = v;
  }
  return { type, params };
}

function decodeQuotedPrintable(input) {
  return String(input || "")
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    );
}

function decodeBodyBytes(rawBody, transferEncoding, charset) {
  const enc = String(transferEncoding || "7bit").toLowerCase();
  let bytes;
  if (enc === "base64") {
    const cleaned = String(rawBody || "").replace(/\s+/g, "");
    try {
      const bin = atob(cleaned);
      bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    } catch {
      return String(rawBody || "");
    }
  } else if (enc === "quoted-printable") {
    const decoded = decodeQuotedPrintable(rawBody);
    bytes = new TextEncoder().encode(decoded);
  } else {
    return String(rawBody || "");
  }
  try {
    return new TextDecoder(charset || "utf-8", { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

/** Return cleaned base64 payload for binary parts. */
function decodeToBase64(rawBody, transferEncoding) {
  const enc = String(transferEncoding || "7bit").toLowerCase();
  if (enc === "base64") {
    return String(rawBody || "").replace(/\s+/g, "");
  }
  if (enc === "quoted-printable") {
    const decoded = decodeQuotedPrintable(rawBody);
    const bytes = new TextEncoder().encode(decoded);
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  const bytes = new TextEncoder().encode(String(rawBody || ""));
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function approxDecodedBytes(b64) {
  return Math.floor((String(b64 || "").length * 3) / 4);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAllowedAttachmentType(type, filename) {
  const t = String(type || "").toLowerCase();
  const name = String(filename || "").toLowerCase();
  if (t.startsWith("image/")) return true;
  if (t === "application/pdf" || name.endsWith(".pdf")) return true;
  if (
    t === "application/msword" ||
    t.includes("officedocument") ||
    t === "application/rtf" ||
    t === "text/plain" ||
    t === "application/octet-stream"
  ) {
    return true;
  }
  if (/\.(docx?|xlsx?|pptx?|txt|rtf)$/i.test(name)) return true;
  return false;
}

/**
 * Walk MIME tree; collect text + allowed attachments.
 * @returns {{ text: string, html: string, attachments: object[] }}
 */
export function extractEmailBodies(rawMime) {
  const found = { text: "", html: "", attachments: [] };

  function walk(raw) {
    const splitAt = raw.search(/\r?\n\r?\n/);
    if (splitAt < 0) return;
    const headers = raw.slice(0, splitAt);
    const body = raw.slice(splitAt).replace(/^\r?\n\r?\n/, "");
    const { type, params } = parseContentType(
      headerValue(headers, "Content-Type"),
    );
    const transfer = headerValue(headers, "Content-Transfer-Encoding");
    const charset = params.charset || "utf-8";
    const disposition = headerValue(headers, "Content-Disposition").toLowerCase();
    const contentId = headerValue(headers, "Content-ID")
      .replace(/^<|>$/g, "")
      .trim();
    const filename =
      params.name ||
      (disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i) || [])[1] ||
      (contentId ? `inline-${contentId.slice(0, 12)}` : "attachment");

    if (type.startsWith("multipart/") && params.boundary) {
      const boundary = params.boundary;
      const delim = `--${boundary}`;
      const chunks = body.split(delim);
      for (const chunk of chunks) {
        let part = chunk;
        if (part.startsWith("--")) break;
        part = part.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
        if (!part || !/content-type:/i.test(part)) continue;
        walk(part);
      }
      return;
    }

    if (type === "text/plain" && !found.text && !disposition.includes("attachment")) {
      found.text = decodeBodyBytes(body, transfer, charset).trim();
      return;
    }
    if (type === "text/html" && !found.html && !disposition.includes("attachment")) {
      found.html = decodeBodyBytes(body, transfer, charset).trim();
      return;
    }

    // OLD CODE - KEEP UNTIL CONFIRMED WORKING: images only
    // if (type.startsWith("image/") && found.attachments.length < ATTACH_MAX_COUNT)
    // NEW CODE - TESTING: images + PDF + common docs onto ticket attachments
    if (
      isAllowedAttachmentType(type, filename) &&
      found.attachments.length < ATTACH_MAX_COUNT &&
      (type.startsWith("image/") ||
        disposition.includes("attachment") ||
        type === "application/pdf" ||
        type.includes("officedocument") ||
        type === "application/msword" ||
        /\.(pdf|docx?|xlsx?|pptx?)$/i.test(String(filename)))
    ) {
      const b64 = decodeToBase64(body, transfer);
      const bytes = approxDecodedBytes(b64);
      if (b64 && bytes > 0 && bytes <= ATTACH_MAX_BYTES) {
        found.attachments.push({
          id: crypto.randomUUID(),
          filename: String(filename).replace(/[^\w.\-()+ ]/g, "_").slice(0, 120),
          content_type: type || "application/octet-stream",
          content_id: contentId || null,
          size: bytes,
          data_base64: b64,
        });
      }
      return;
    }

    if (!type || type === "text/plain") {
      if (!found.text && body) {
        found.text = decodeBodyBytes(body, transfer, charset).trim();
      }
    }
  }

  walk(String(rawMime || ""));

  if (!found.text && !found.html) {
    const parts = String(rawMime || "").split(/\r?\n\r?\n/);
    found.text = (parts.slice(1).join("\n\n") || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  if (!found.text && found.html) {
    found.text = found.html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  // Inline images referenced as cid:… → data URLs so HTML preview works offline
  let html = found.html;
  if (html && found.attachments.length) {
    for (const att of found.attachments) {
      if (!att.content_id) continue;
      const dataUrl = `data:${att.content_type};base64,${att.data_base64}`;
      const cid = att.content_id;
      html = html.replace(
        new RegExp(`cid:${escapeRegExp(cid)}`, "gi"),
        dataUrl,
      );
    }
  }

  return {
    text: found.text.slice(0, BODY_TEXT_MAX),
    html: html.slice(0, BODY_HTML_MAX),
    attachments: found.attachments,
  };
}

/**
 * @param {ForwardableEmailMessage} message
 * @param {Env} env
 */
export async function handleInboundEmail(message, env) {
  const raw = await new Response(message.raw).text();

  if (!gitStoreConfigured(env)) {
    console.log(
      "ackvyn-crm email: received but GITHUB_TOKEN / CRM_DATA_PASSPHRASE not set; dropping",
      message.from,
      "→",
      message.to,
    );
    return;
  }

  const from = parseAngleEmail(message.from);
  const to = parseAngleEmail(message.to);
  const subject = message.headers.get("subject") || `Email from ${from}`;
  const fromName =
    String(message.headers.get("from") || "")
      .replace(/<[^>]+>/, "")
      .replace(/"/g, "")
      .trim() || from;

  const bodies = extractEmailBodies(raw);
  const text =
    bodies.text ||
    (bodies.html
      ? "(HTML-only message — open HTML view)"
      : "(empty message body)");

  const siteKey = siteKeyFromInboundTo(env, to);
  if (!siteKey) {
    message.setReject("No CRM site mapped for this address");
    return;
  }

  const ref = parseAckvynTicketRef(subject, text, bodies.html);
  let result = null;
  let appendKind = null;

  // NEW CODE - TESTING: mailto CC / Reply-All → append to existing ticket.
  // Agent-outbound attribution requires From ∈ site agent email allowlist.
  if (ref.ticketIdHint || ref.shortId) {
    let kind =
      ref.kind === "agent-outbound" ? "agent-outbound" : "email-reply";
    if (kind === "agent-outbound") {
      const allowed = await isAllowedAgentEmail(env, siteKey, from);
      if (!allowed) {
        console.log(
          "ackvyn-crm email: agent-outbound marker ignored — From not on allowlist",
          from,
          siteKey,
        );
        kind = "email-reply";
      }
    }
    appendKind = kind;
    try {
      result = await appendInboundEmailToTicket(env, siteKey, {
        ticketIdHint: ref.ticketIdHint,
        shortId: ref.shortId,
        kind,
        from,
        fromName,
        subject: String(subject).slice(0, 500),
        message: text,
        // NEW CODE - TESTING: merge inbound attachments onto the ticket
        attachments: bodies.attachments || [],
      });
    } catch (err) {
      console.warn(
        "ackvyn-crm email: append to ticket failed",
        err instanceof Error ? err.message : err,
      );
      result = null;
    }
  }

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING: always create new ticket
  // result = await commitIntakeTicket(...)
  if (!result) {
    result = await commitIntakeTicket(env, siteKey, {
      name: fromName,
      email: from,
      subject: String(subject).slice(0, 500),
      message: text,
      messageHtml: bodies.html || null,
      attachments: bodies.attachments || [],
      source: "email",
    });
  }

  const forwardTo = String(env.CRM_EMAIL_FORWARD_TO || "").trim();
  if (forwardTo) {
    try {
      await message.forward(forwardTo);
    } catch {
      /* ticket already committed */
    }
  }

  try {
    const stub = env.CRM.get(env.CRM.idFromName(siteKey));
    await stub.fetch("https://do/internal/notify-ticket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticketId: result.ticketId,
        subject: String(subject).slice(0, 500),
        source: appendKind === "agent-outbound" ? "mailto-outbound" : "email",
      }),
    });
  } catch {
    /* non-fatal */
  }
}
