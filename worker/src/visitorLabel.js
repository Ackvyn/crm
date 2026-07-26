/**
 * Lightweight UA → browser / OS / device (no npm dependency).
 * Same class of fields Intercom/Tawk show agents for anonymous visitors.
 *
 * @param {string} ua
 * @returns {{ browser: string, os: string, device: string }}
 */
export function parseUserAgent(ua) {
  const s = String(ua || "");
  let browser = "Browser";
  if (/Edg\//i.test(s)) browser = "Edge";
  else if (/OPR\/|Opera/i.test(s)) browser = "Opera";
  else if (/Chrome\//i.test(s) && !/Chromium/i.test(s)) browser = "Chrome";
  else if (/Firefox\//i.test(s)) browser = "Firefox";
  else if (/Safari\//i.test(s) && !/Chrome/i.test(s)) browser = "Safari";
  else if (/MSIE|Trident/i.test(s)) browser = "IE";

  let os = "Unknown OS";
  if (/Windows NT/i.test(s)) os = "Windows";
  else if (/Mac OS X|Macintosh/i.test(s)) os = "macOS";
  else if (/iPhone|iPad|iPod/i.test(s)) os = "iOS";
  else if (/Android/i.test(s)) os = "Android";
  else if (/CrOS/i.test(s)) os = "ChromeOS";
  else if (/Linux/i.test(s)) os = "Linux";

  let device = "Desktop";
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(s)) device = "Tablet";
  else if (/Mobi|iPhone|Android.*Mobile/i.test(s)) device = "Mobile";

  return { browser, os, device };
}

/**
 * Agent-facing label when name/email unknown.
 * e.g. "Chrome · macOS · Austin, US" or "Visitor a1b2c3"
 *
 * @param {{
 *   display_name?: string | null,
 *   email?: string | null,
 *   browser?: string | null,
 *   os?: string | null,
 *   city?: string | null,
 *   country?: string | null,
 *   device?: string | null,
 *   id?: string,
 * }} v
 */
export function formatVisitorLabel(v) {
  const name = String(v.display_name || "").trim();
  if (name) return name;
  const email = String(v.email || "").trim();
  if (email) return email;

  const parts = [];
  if (v.browser) parts.push(v.browser);
  if (v.os) parts.push(v.os);
  const place = [v.city, v.country].filter(Boolean).join(", ");
  if (place) parts.push(place);
  else if (v.device && v.device !== "Desktop") parts.push(v.device);

  if (parts.length) return parts.join(" · ");
  const short = String(v.id || "").replace(/-/g, "").slice(0, 6);
  return short ? `Visitor ${short}` : "Visitor";
}
