/**
 * Optional Worker outbound email via Cloudflare Email Sending
 * (`[[send_email]]` binding → env.EMAIL.send).
 *
 * Off by default at the site-settings toggle. The Worker cannot detect paid
 * Email Sending entitlement on its own — enable Email Sending on the Cloudflare
 * account (Workers paid), keep the binding in wrangler.toml, then turn the CRM
 * toggle on. Free accounts keep mailto + CC/BCC.
 */

import { appendInboundEmailToTicket } from "./gitStore.js";

export function hasEmailSendBinding(env) {
  try {
    return Boolean(env && env.EMAIL && typeof env.EMAIL.send === "function");
  } catch {
    return false;
  }
}

/**
 * @param {unknown} err
 */
export function outboundEmailErrorPayload(err) {
  const code =
    err && typeof err === "object" && "code" in err
      ? String(/** @type {{ code?: string }} */ (err).code || "")
      : "";
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "Email send failed";
  let hint = null;
  if (code === "E_BINDING_MISSING" || /binding/i.test(message)) {
    hint =
      "Add [[send_email]] name = \"EMAIL\" to wrangler.toml, redeploy, and enable Cloudflare Email Sending on a Workers paid plan.";
  } else if (
    code === "E_SENDER_NOT_VERIFIED" ||
    code === "E_SENDER_DOMAIN_NOT_AVAILABLE"
  ) {
    hint =
      "Onboard and verify the sender domain for Cloudflare Email Sending. From must be your CRM inbound mailbox on that domain.";
  } else if (code === "E_RATE_LIMIT_EXCEEDED" || code === "E_DAILY_LIMIT_EXCEEDED") {
    hint = "Cloudflare Email Sending rate or daily limit reached — try again later.";
  } else {
    hint =
      "Confirm Email Sending is enabled on your Cloudflare account (Workers paid), the EMAIL binding is deployed, and the From domain is verified.";
  }
  return { error: "email_send_failed", code: code || "E_SEND_FAILED", message, hint };
}

/**
 * Send from the CRM inbound mailbox and record an agent-outbound note on the ticket.
 *
 * @param {Env} env
 * @param {string} siteKey
 * @param {{
 *   ticketId: string,
 *   to: string,
 *   from: string,
 *   subject: string,
 *   text: string,
 *   html?: string | null,
 *   agentLogin?: string,
 *   agentName?: string,
 * }} input
 */
export async function sendTicketOutboundEmail(env, siteKey, input) {
  if (!hasEmailSendBinding(env)) {
    const err = new Error(
      'Email send binding missing. Add [[send_email]] name = "EMAIL" to wrangler.toml and enable Cloudflare Email Sending.',
    );
    // @ts-expect-error code for API clients
    err.code = "E_BINDING_MISSING";
    throw err;
  }

  const to = String(input.to || "")
    .trim()
    .toLowerCase();
  const from = String(input.from || "")
    .trim()
    .toLowerCase();
  const subject = String(input.subject || "").trim().slice(0, 500);
  const text = String(input.text || "").trim().slice(0, 100000);
  const html = input.html != null ? String(input.html).trim().slice(0, 200000) : "";
  const ticketId = String(input.ticketId || "").trim();

  if (!to || !from || !subject || !ticketId) {
    const err = new Error("to, from, subject, and ticketId are required");
    // @ts-expect-error
    err.code = "E_FIELD_MISSING";
    throw err;
  }
  if (!text && !html) {
    const err = new Error("Message body is required (text or html)");
    // @ts-expect-error
    err.code = "E_FIELD_MISSING";
    throw err;
  }

  /** @type {Record<string, unknown>} */
  const message = {
    to,
    from,
    subject,
    replyTo: from,
  };
  if (text) message.text = text;
  if (html) message.html = html;

  const result = await env.EMAIL.send(message);
  const messageId =
    result && typeof result === "object" && "messageId" in result
      ? String(/** @type {{ messageId?: string }} */ (result).messageId || "")
      : "";

  const agentLogin = String(input.agentLogin || from)
    .trim()
    .toLowerCase()
    .slice(0, 80);
  const agentName = String(input.agentName || agentLogin).trim().slice(0, 120);
  const noteMessage = [
    text || "(html body)",
    "",
    `Ackvyn-CRM: ticket=${ticketId} kind=agent-outbound`,
    messageId ? `Cloudflare messageId: ${messageId}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  await appendInboundEmailToTicket(env, siteKey, {
    ticketIdHint: ticketId,
    shortId: ticketId.replace(/-/g, "").slice(0, 8),
    kind: "agent-outbound",
    from,
    fromName: `${agentName} (Worker send)`,
    subject,
    message: noteMessage,
  });

  return { ok: true, messageId: messageId || null };
}
