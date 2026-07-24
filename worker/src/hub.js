/**
 * Hub Durable Object helpers — multi-site registry for portable Ackvyn CRM.
 * Each customer site still gets its own CrmSite DO via idFromName(siteKey).
 */

export const HUB_SITE_KEY = "_hub";

const HUB_SCHEMA = `
CREATE TABLE IF NOT EXISTS hub_sites (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  allowed_origins TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/**
 * @param {import("./crm.js").CrmSite} siteDo
 */
export function ensureHubSchema(siteDo) {
  siteDo.ctx.storage.sql.exec(HUB_SCHEMA);
}

/**
 * @param {import("./crm.js").CrmSite} siteDo
 * @param {Request} request
 * @param {string} path
 */
export async function handleHubFetch(siteDo, request, path) {
  ensureHubSchema(siteDo);
  const method = request.method;

  if (method === "GET" && (path === "" || path === "sites")) {
    let rows = siteDo.ctx.storage.sql
      .exec(`SELECT * FROM hub_sites ORDER BY name ASC`)
      .toArray();
    // Seed guinea-pig site so the portable app is never empty on first boot
    if (!rows.length) {
      const ts = new Date().toISOString();
      siteDo.ctx.storage.sql.exec(
        `INSERT INTO hub_sites (key, name, allowed_origins, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        "webstudio",
        "Ackvyn Web Studio",
        JSON.stringify(["https://webstudio.ackvyn.org", "http://localhost:5173"]),
        ts,
        ts,
      );
      rows = siteDo.ctx.storage.sql
        .exec(`SELECT * FROM hub_sites ORDER BY name ASC`)
        .toArray();
    }
    return Response.json({
      sites: rows.map((r) => ({
        key: r.key,
        name: r.name,
        allowedOrigins: safeJsonArray(r.allowed_origins),
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
    });
  }

  if (method === "POST" && (path === "" || path === "sites")) {
    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    const key = String(body.key || "")
      .replace(/[^a-z0-9_-]/gi, "")
      .toLowerCase();
    const name = String(body.name || key).trim().slice(0, 120);
    if (!key || key === HUB_SITE_KEY) {
      return Response.json({ error: "bad_site_key" }, { status: 400 });
    }
    const origins = normalizeOrigins(body.allowedOrigins || body.origins || []);
    const ts = new Date().toISOString();
    const existing = siteDo.ctx.storage.sql
      .exec(`SELECT key FROM hub_sites WHERE key = ? LIMIT 1`, key)
      .toArray();
    if (existing.length) {
      siteDo.ctx.storage.sql.exec(
        `UPDATE hub_sites SET name = ?, allowed_origins = ?, updated_at = ? WHERE key = ?`,
        name,
        JSON.stringify(origins),
        ts,
        key,
      );
    } else {
      siteDo.ctx.storage.sql.exec(
        `INSERT INTO hub_sites (key, name, allowed_origins, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        key,
        name,
        JSON.stringify(origins),
        ts,
        ts,
      );
    }
    return Response.json({
      ok: true,
      site: { key, name, allowedOrigins: origins },
    });
  }

  const m = path.match(/^sites\/([^/]+)$/);
  if (m && method === "PATCH") {
    const key = m[1];
    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }
    const rows = siteDo.ctx.storage.sql
      .exec(`SELECT * FROM hub_sites WHERE key = ? LIMIT 1`, key)
      .toArray();
    if (!rows.length) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const name =
      body.name != null
        ? String(body.name).trim().slice(0, 120)
        : rows[0].name;
    const origins =
      body.allowedOrigins != null || body.origins != null
        ? normalizeOrigins(body.allowedOrigins || body.origins)
        : safeJsonArray(rows[0].allowed_origins);
    const ts = new Date().toISOString();
    siteDo.ctx.storage.sql.exec(
      `UPDATE hub_sites SET name = ?, allowed_origins = ?, updated_at = ? WHERE key = ?`,
      name,
      JSON.stringify(origins),
      ts,
      key,
    );
    return Response.json({
      ok: true,
      site: { key, name, allowedOrigins: origins },
    });
  }

  return Response.json({ error: "not_found", path }, { status: 404 });
}

function safeJsonArray(raw) {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function normalizeOrigins(input) {
  const list = Array.isArray(input) ? input : String(input || "").split(",");
  return [
    ...new Set(
      list
        .map((s) => String(s).trim().replace(/\/$/, ""))
        .filter((s) => /^https?:\/\//i.test(s)),
    ),
  ].slice(0, 40);
}
