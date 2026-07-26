/**
 * Attach Cloudflare edge visitor meta onto the request before it hits the DO.
 * Geo/IP come from CF — client never needs to send them (and can't spoof reliably).
 *
 * @param {Request} request
 * @returns {Request}
 */
export function withEdgeVisitorMeta(request) {
  const headers = new Headers(request.headers);
  const cf = /** @type {any} */ (request.cf) || {};
  const ip =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    "";
  const meta = {
    ip: String(ip).slice(0, 64),
    country: String(cf.country || request.headers.get("cf-ipcountry") || "").slice(
      0,
      8,
    ),
    city: String(cf.city || "").slice(0, 80),
    region: String(cf.region || "").slice(0, 80),
    timezone: String(cf.timezone || "").slice(0, 64),
    colo: String(cf.colo || "").slice(0, 8),
    asOrg: String(cf.asOrganization || "").slice(0, 120),
  };
  headers.set("x-ackvyn-edge", JSON.stringify(meta));
  return new Request(request, { headers });
}

/**
 * @param {Request} request
 */
export function readEdgeVisitorMeta(request) {
  try {
    const raw = request.headers.get("x-ackvyn-edge");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
