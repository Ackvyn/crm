/**
 * Shared Ackvyn ticket markers for mailto ↔ inbound email threading.
 * Never use `#` in subject tags — browsers truncate mailto at `#`.
 */

export const ACKVYN_TICKET_SUBJECT_RE = /\[Ackvyn:([a-f0-9]{8})\]/i;
export const ACKVYN_TICKET_SUBJECT_RE_LEGACY = /\[Ackvyn:#([a-f0-9]{8})\]/i;
export const ACKVYN_TICKET_BODY_RE =
  /Ackvyn-CRM:\s*ticket=([a-f0-9-]{36})\s+kind=(agent-outbound|client-reply)/i;

export function parseAckvynTicketRef(subject, text, html) {
  const hay = `${subject || ""}\n${text || ""}\n${html || ""}`;
  const bodyMatch = hay.match(ACKVYN_TICKET_BODY_RE);
  if (bodyMatch) {
    return {
      ticketIdHint: bodyMatch[1] || null,
      kind: bodyMatch[2] || null,
      shortId: String(bodyMatch[1] || "")
        .replace(/-/g, "")
        .slice(0, 8)
        .toLowerCase(),
    };
  }
  const sub =
    String(subject || "").match(ACKVYN_TICKET_SUBJECT_RE) ||
    String(subject || "").match(ACKVYN_TICKET_SUBJECT_RE_LEGACY);
  if (sub) {
    return {
      ticketIdHint: null,
      kind: null,
      shortId: String(sub[1] || "").toLowerCase(),
    };
  }
  return { ticketIdHint: null, kind: null, shortId: null };
}
