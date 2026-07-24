/**
 * Ackvyn CRM Worker — API + Durable Object router + full-page admin app (assets).
 *
 * Portable multi-site CRM: each site key → its own Durable Object.
 * Hub registry at /hub/sites. Admin UI is Workers assets (not embedded in a site).
 */

import { CrmSite } from "./crm.js";
import { assertCrmSession } from "./crmAuth.js";
import { handleInboundEmail } from "./emailInbound.js";
import { withEdgeVisitorMeta } from "./edgeMeta.js";
import { HUB_SITE_KEY } from "./hub.js";

export { CrmSite };

function corsHeaders(env, request, opts = {}) {
  // NEW CODE - TESTING: public reviews JSON + public e-sign pages
  if (opts.public) {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    };
  }
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_SITE_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ok = allowed.some((o) => o === origin || o === "*");
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed[0] || "null",
    // OLD CODE - KEEP UNTIL CONFIRMED WORKING:
    // "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    // NEW CODE - TESTING: DELETE for GA config disconnect
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/** Public signer UI + complete — NOT agent `sign/sessions` (needs Authorization). */
function isPublicSignPath(pathname) {
  // OLD: /^\/v1\/[^/]+\/sign\/[^/]+(\/(envelope|complete))?\/?$/ also matched sign/sessions
  // NEW CODE - TESTING: any sign/sessions* needs Authorization (create + revoke)
  if (/^\/v1\/[^/]+\/sign\/sessions(\/|$)/.test(pathname)) return false;
  return /^\/v1\/[^/]+\/sign\/[^/]+(\/(envelope|complete))?\/?$/.test(pathname);
}

/**
 * After GitHub CRM login, client pulls the shared encryption passphrase for
 * this session (same secret Worker uses for form/email git commits).
 */
async function handleDataPassphrase(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(env, request) });
  }
  if (request.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  const user = await assertCrmSession(request, env);
  if (!user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const passphrase = String(env.CRM_DATA_PASSPHRASE || "").trim();
  if (!passphrase) {
    return Response.json(
      { error: "passphrase_not_configured", hint: "Set CRM_DATA_PASSPHRASE secret" },
      { status: 503 },
    );
  }
  return Response.json({
    ok: true,
    passphrase,
    login: user.login,
  });
}

function withCors(env, request, response) {
  const headers = new Headers(response.headers);
  const url = new URL(request.url);
  const publicReviews =
    request.method === "GET" &&
    /^\/v1\/[^/]+\/reviews\/?$/.test(url.pathname);
  // NEW CODE - TESTING: public sign page + envelope + complete (not sign/sessions)
  const cors = corsHeaders(env, request, {
    public: publicReviews || isPublicSignPath(url.pathname),
  });
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * @param {string} site
 * @param {Env} env
 */
function siteStub(site, env) {
  const id = env.CRM.idFromName(site);
  return env.CRM.get(id);
}

/**
 * @param {Request} request
 * @param {Env} env
 * @param {string} siteKey
 * @param {string} restPath
 */
async function forwardToSite(request, env, siteKey, restPath) {
  const stub = siteStub(siteKey, env);
  const dest = new URL(request.url);
  dest.pathname = "/" + restPath.replace(/^\/+/, "");
  dest.search = new URL(request.url).search;

  const stamped = withEdgeVisitorMeta(request);

  if (stamped.headers.get("Upgrade") === "websocket") {
    return stub.fetch(dest.toString(), stamped);
  }

  const init = {
    method: stamped.method,
    headers: stamped.headers,
  };
  if (stamped.method !== "GET" && stamped.method !== "HEAD") {
    init.body = stamped.body;
  }

  const response = await stub.fetch(dest.toString(), init);
  return withCors(env, request, response);
}

/**
 * @param {Request} request
 * @param {Env} env
 */
async function handleApi(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    return withCors(
      env,
      request,
      Response.json({
        ok: true,
        service: "ackvyn-crm",
        portable: true,
        roles: {
          durableObject: "live_chat_presence_stats_per_site",
          hub: "multi_site_registry",
          gitCommits: "contacts_tickets_encrypted_github",
          ui: "https://crm.ackvyn.org/console/",
          edgeMeta: "ip_country_city_from_cloudflare",
          inboundEmail: "cloudflare_email_routing_to_worker",
        },
        storage: "github_encrypted_blobs_plus_do_chat",
        realtime: "do_websocket_hibernation",
        archive: "client_and_worker_git_commits",
        cryptoIterations: 100000,
      }),
    );
  }

  // Session bootstrap — encryption passphrase for git blobs (Bearer session)
  if (
    url.pathname === "/session/data-passphrase" ||
    url.pathname === "/session/data-passphrase/"
  ) {
    return withCors(env, request, await handleDataPassphrase(request, env));
  }

  // /hub/sites — portable multi-site registry
  if (url.pathname === "/hub" || url.pathname.startsWith("/hub/")) {
    const rest = url.pathname.replace(/^\/hub\/?/, "") || "sites";
    return forwardToSite(request, env, HUB_SITE_KEY, rest);
  }

  // /v1/:site/...
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "v1" || !parts[1]) {
    return null;
  }

  const site = parts[1].replace(/[^a-z0-9_-]/gi, "").toLowerCase();
  if (!site || site === HUB_SITE_KEY) {
    return withCors(env, request, Response.json({ error: "bad_site" }, 400));
  }

  const rest = parts.slice(2).join("/");
  return forwardToSite(request, env, site, rest);
}

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   */
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      const url = new URL(request.url);
      const publicReviews = /^\/v1\/[^/]+\/reviews\/?$/.test(url.pathname);
      return new Response(null, {
        status: 204,
        headers: corsHeaders(env, request, {
          public: publicReviews || isPublicSignPath(url.pathname),
        }),
      });
    }

    const url = new URL(request.url);
    const isApi =
      url.pathname === "/health" ||
      url.pathname.startsWith("/session/") ||
      url.pathname.startsWith("/v1/") ||
      url.pathname === "/hub" ||
      url.pathname.startsWith("/hub/") ||
      request.headers.get("Upgrade") === "websocket";

    if (isApi) {
      const apiResponse = await handleApi(request, env);
      if (apiResponse) return apiResponse;
      return withCors(
        env,
        request,
        Response.json({ error: "use /v1/:site/... or /hub/sites" }, 404),
      );
    }

    // OLD CODE - KEEP UNTIL CONFIRMED WORKING
    // Canonical CRM UI is on Pages: https://webstudio.ackvyn.org/crm/
    // ui: "https://ackvyn.github.io/crm/console/",
    // NEW CODE - TESTING: custom domain CDN console
    const CRM_UI = "https://crm.ackvyn.org/console/";
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      (url.pathname === "/" ||
        url.pathname === "/index.html" ||
        url.pathname.startsWith("/assets/"))
    ) {
      return Response.redirect(CRM_UI, 302);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return withCors(
      env,
      request,
      Response.json({
        ok: true,
        service: "ackvyn-crm",
        ui: CRM_UI,
        hint: "API Worker — open the CRM UI on the CDN console",
      }),
    );
  },

  /**
   * Email Worker entry — required for Cloudflare Email Routing “Send to a Worker”.
   * Safe when unused: consumes the message; tickets commit only if git secrets exist.
   *
   * @param {ForwardableEmailMessage} message
   * @param {Env} env
   * @param {ExecutionContext} _ctx
   */
  async email(message, env, _ctx) {
    await handleInboundEmail(message, env);
  },

  /**
   * Twice-daily Google reviews sync → crm-data/{site}/reviews.json for every hub site.
   * @param {ScheduledController} _controller
   * @param {Env} env
   * @param {ExecutionContext} ctx
   */
  async scheduled(_controller, env, ctx) {
    const passphrase = String(env.CRM_DATA_PASSPHRASE || "").trim();
    if (!passphrase) return;

    ctx.waitUntil(
      (async () => {
        // OLD CODE - KEEP UNTIL CONFIRMED WORKING: only webstudio
        // const siteKey = String(env.CRM_REVIEWS_SITE || env.CRM_INBOUND_EMAIL_SITE || "webstudio")
        // …
        const keys = new Set();
        try {
          const hub = env.CRM.get(env.CRM.idFromName(HUB_SITE_KEY));
          const listRes = await hub.fetch("https://do/sites");
          if (listRes.ok) {
            const data = await listRes.json();
            for (const row of data.sites || []) {
              const k = String(row.key || "")
                .replace(/[^a-z0-9_-]/gi, "")
                .toLowerCase();
              if (k && k !== HUB_SITE_KEY) keys.add(k);
            }
          }
        } catch {
          /* fall through */
        }
        if (!keys.size) {
          const fallback = String(
            env.CRM_REVIEWS_SITE || env.CRM_INBOUND_EMAIL_SITE || "webstudio",
          )
            .replace(/[^a-z0-9_-]/gi, "")
            .toLowerCase();
          if (fallback) keys.add(fallback);
        }
        for (const siteKey of keys) {
          try {
            const stub = env.CRM.get(env.CRM.idFromName(siteKey));
            await stub.fetch("https://do/reviews/cron-sync", {
              method: "POST",
              headers: { "X-Ackvyn-Cron": passphrase },
            });
          } catch {
            /* continue other sites */
          }
        }
      })(),
    );
  },
};
