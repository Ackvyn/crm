/**
 * Google Place reviews → per-site public git JSON + DO cache.
 * Places API is polled at most ~2×/day (12h floor).
 *
 * Places API (New): GET https://places.googleapis.com/v1/places/{placeId}
 * Field mask: id,displayName,rating,userRatingCount,googleMapsUri,reviews
 * Google returns at most ~5 reviews sorted by relevance.
 */

import { decryptJson, deriveCrmDataKey, encryptJson } from "./crmCrypto.js";
import { commitPublicJsonFile, gitStoreConfigured } from "./gitStore.js";

const REVIEWS_CONFIG_KEY = "google_reviews_enc";
const REVIEWS_CACHE_KEY = "google_reviews_cache";
const REVIEWS_LAST_FETCH_KEY = "google_reviews_last_fetch_ms";
/** ~2 Places calls / day with plenty of headroom under the ~1k free tier. */
const MIN_FETCH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const MAX_API_KEY_LEN = 256;
// OLD CODE - KEEP UNTIL CONFIRMED WORKING: single CMS path for Web Studio only
// const PUBLIC_REVIEWS_PATH = "content/reviews.json";
/** Legacy Web Studio homepage path — still dual-written for siteKey webstudio */
const LEGACY_WEBSTUDIO_REVIEWS_PATH = "content/reviews.json";

/** Portable public path: crm-data/{site}/reviews.json */
export function publicReviewsPathForSite(siteKey) {
  const key = String(siteKey || "")
    .replace(/[^a-z0-9_-]/gi, "")
    .toLowerCase();
  return `crm-data/${key || "site"}/reviews.json`;
}

/**
 * @param {unknown} raw
 * @param {{ allowMissingKey?: boolean }} [opts]
 * @returns {{ placeId: string, apiKey: string | null }}
 */
export function parseReviewsConfigInput(raw, opts = {}) {
  if (!raw || typeof raw !== "object") {
    throw new Error("invalid_body");
  }
  let placeId = String(raw.placeId || "")
    .trim()
    .replace(/^places\//, "");
  if (!placeId || placeId.length < 8 || placeId.length > 256) {
    throw new Error("invalid_place_id");
  }
  if (/[\s<>"']/.test(placeId)) {
    throw new Error("invalid_place_id");
  }

  let apiKey = raw.apiKey;
  const keyEmpty =
    apiKey == null || (typeof apiKey === "string" && !String(apiKey).trim());
  if (keyEmpty) {
    if (opts.allowMissingKey) {
      return { placeId, apiKey: null };
    }
    throw new Error("invalid_api_key");
  }
  apiKey = String(apiKey).trim();
  if (apiKey.length < 20 || apiKey.length > MAX_API_KEY_LEN) {
    throw new Error("invalid_api_key");
  }
  return { placeId, apiKey };
}

/**
 * @param {DurableObjectStorage} storage
 * @param {Env} env
 * @param {string} siteKey
 * @param {{ placeId: string, apiKey: string | null }} parsed
 */
export async function saveReviewsConfig(storage, env, siteKey, parsed) {
  const passphrase = String(env.CRM_DATA_PASSPHRASE || "").trim();
  if (!passphrase) throw new Error("passphrase_not_configured");
  const key = await deriveCrmDataKey(passphrase, siteKey);
  let apiKey = parsed.apiKey;
  if (!apiKey) {
    const existing = await loadReviewsConfigSecret(storage, env, siteKey);
    if (!existing?.apiKey) throw new Error("invalid_api_key");
    apiKey = existing.apiKey;
  }
  const payload = {
    placeId: parsed.placeId,
    apiKey,
    updated_at: new Date().toISOString(),
  };
  const enc = await encryptJson(payload, key);
  await storage.put(REVIEWS_CONFIG_KEY, enc);
  // Allow an immediate sync after reconnecting
  await storage.delete(REVIEWS_LAST_FETCH_KEY);
  return {
    configured: true,
    placeId: payload.placeId,
    updated_at: payload.updated_at,
    publicPath: publicReviewsPathForSite(siteKey),
  };
}

/** @param {DurableObjectStorage} storage */
export async function clearReviewsConfig(storage) {
  await storage.delete(REVIEWS_CONFIG_KEY);
  await storage.delete(REVIEWS_CACHE_KEY);
  await storage.delete(REVIEWS_LAST_FETCH_KEY);
}

/**
 * @param {DurableObjectStorage} storage
 * @param {Env} env
 * @param {string} siteKey
 */
export async function getReviewsConfigPublic(storage, env, siteKey) {
  const secret = await loadReviewsConfigSecret(storage, env, siteKey);
  if (!secret?.placeId || !secret?.apiKey) {
    return { configured: false, publicPath: publicReviewsPathForSite(siteKey) };
  }
  const lastFetch = Number((await storage.get(REVIEWS_LAST_FETCH_KEY)) || 0);
  return {
    configured: true,
    placeId: secret.placeId,
    updated_at: secret.updated_at || null,
    publicPath: publicReviewsPathForSite(siteKey),
    lastFetchedAt: lastFetch > 0 ? new Date(lastFetch).toISOString() : null,
  };
}

/**
 * @param {DurableObjectStorage} storage
 * @param {Env} env
 * @param {string} siteKey
 * @returns {Promise<{ placeId: string, apiKey: string, updated_at?: string } | null>}
 */
async function loadReviewsConfigSecret(storage, env, siteKey) {
  const enc = await storage.get(REVIEWS_CONFIG_KEY);
  if (!enc || typeof enc !== "string") return null;
  const passphrase = String(env.CRM_DATA_PASSPHRASE || "").trim();
  if (!passphrase) throw new Error("passphrase_not_configured");
  const key = await deriveCrmDataKey(passphrase, siteKey);
  try {
    const data = await decryptJson(enc, key);
    if (!data || typeof data !== "object") return null;
    const placeId = String(data.placeId || "").trim();
    const apiKey = String(data.apiKey || "").trim();
    if (!placeId || !apiKey) return null;
    return {
      placeId,
      apiKey,
      updated_at: data.updated_at ? String(data.updated_at) : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * @param {unknown} place
 */
function normalizePlacePayload(place) {
  const reviewsIn = Array.isArray(place?.reviews) ? place.reviews : [];
  const reviews = reviewsIn.slice(0, 5).map((r) => {
    const author = r?.authorAttribution || {};
    const text =
      (r?.text && (r.text.text || r.text)) ||
      (r?.originalText && (r.originalText.text || r.originalText)) ||
      "";
    return {
      rating: typeof r?.rating === "number" ? r.rating : null,
      text: String(text || "").slice(0, 4000),
      relativeTime: r?.relativePublishTimeDescription
        ? String(r.relativePublishTimeDescription)
        : null,
      publishTime: r?.publishTime ? String(r.publishTime) : null,
      authorName: author?.displayName ? String(author.displayName) : null,
      authorUri: author?.uri ? String(author.uri) : null,
      authorPhotoUri: author?.photoUri ? String(author.photoUri) : null,
      googleMapsUri: r?.googleMapsUri ? String(r.googleMapsUri) : null,
    };
  });

  const displayName =
    place?.displayName?.text ||
    (typeof place?.displayName === "string" ? place.displayName : null);

  return {
    ok: true,
    source: "google_places",
    placeId: place?.id ? String(place.id) : null,
    displayName: displayName ? String(displayName) : null,
    rating: typeof place?.rating === "number" ? place.rating : null,
    userRatingCount:
      typeof place?.userRatingCount === "number" ? place.userRatingCount : null,
    googleMapsUri: place?.googleMapsUri ? String(place.googleMapsUri) : null,
    reviews,
    fetched_at: new Date().toISOString(),
  };
}

/**
 * Last synced payload only — never calls Places.
 * @param {DurableObjectStorage} storage
 */
export async function readCachedReviews(storage) {
  const cached = await storage.get(REVIEWS_CACHE_KEY);
  if (cached && typeof cached === "object" && cached.payload) {
    return { ...cached.payload, cached: true };
  }
  return null;
}

/**
 * Pull from Places (if interval allows) and commit per-site reviews.json.
 * @param {DurableObjectStorage} storage
 * @param {Env} env
 * @param {string} siteKey
 * @param {{ force?: boolean }} [opts]
 */
export async function syncReviewsToGit(storage, env, siteKey, opts = {}) {
  const secret = await loadReviewsConfigSecret(storage, env, siteKey);
  if (!secret) throw new Error("reviews_not_configured");
  if (!gitStoreConfigured(env)) throw new Error("git_store_not_configured");

  const force = Boolean(opts.force);
  const lastFetch = Number((await storage.get(REVIEWS_LAST_FETCH_KEY)) || 0);
  const due = force || Date.now() - lastFetch >= MIN_FETCH_INTERVAL_MS;

  let payload = null;
  let fetched = false;

  if (due) {
    const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(secret.placeId)}`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "X-Goog-Api-Key": secret.apiKey,
        "X-Goog-FieldMask":
          "id,displayName,rating,userRatingCount,googleMapsUri,reviews",
      },
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 240);
      throw new Error(`places_api_${res.status}:${detail}`);
    }
    const place = await res.json();
    payload = normalizePlacePayload(place);
    payload.placeId = payload.placeId || secret.placeId;
    await storage.put(REVIEWS_CACHE_KEY, { payload });
    await storage.put(REVIEWS_LAST_FETCH_KEY, Date.now());
    fetched = true;
  } else {
    payload = (await readCachedReviews(storage)) || null;
    if (!payload) {
      // No cache yet but interval blocked — still force one Places call
      return syncReviewsToGit(storage, env, siteKey, { force: true });
    }
  }

  const publicPath = publicReviewsPathForSite(siteKey);
  const filePayload = {
    ...payload,
    cached: !fetched,
    siteKey,
    publicPath,
  };
  delete filePayload.note;

  await commitPublicJsonFile(
    env,
    publicPath,
    filePayload,
    `Sync Google reviews for ${siteKey} (${new Date().toISOString()})`,
  );

  // OLD CODE - KEEP UNTIL CONFIRMED WORKING: also write Studio CMS path for webstudio
  // NEW CODE - TESTING: dual-write legacy path so existing homepage keeps working
  if (String(siteKey).toLowerCase() === "webstudio") {
    await commitPublicJsonFile(
      env,
      LEGACY_WEBSTUDIO_REVIEWS_PATH,
      { ...filePayload, publicPath: LEGACY_WEBSTUDIO_REVIEWS_PATH },
      `Sync Google reviews (legacy content path) ${new Date().toISOString()}`,
    );
  }

  return {
    ok: true,
    fetched,
    skippedFetch: !fetched,
    publicPath,
    reviewCount: Array.isArray(payload.reviews) ? payload.reviews.length : 0,
    fetched_at: payload.fetched_at,
  };
}

/**
 * Cached DO payload only (also available via GET /v1/:site/reviews).
 * @param {DurableObjectStorage} storage
 * @param {Env} env
 * @param {string} siteKey
 */
export async function fetchPublicReviews(storage, env, siteKey) {
  const secret = await loadReviewsConfigSecret(storage, env, siteKey);
  if (!secret) throw new Error("reviews_not_configured");
  const cached = await readCachedReviews(storage);
  if (cached) {
    return {
      ...cached,
      publicPath: publicReviewsPathForSite(siteKey),
    };
  }
  throw new Error("reviews_not_synced");
}

export {
  publicReviewsPathForSite as PUBLIC_REVIEWS_PATH_FN,
  MIN_FETCH_INTERVAL_MS,
};
// OLD CODE - KEEP UNTIL CONFIRMED WORKING
// export { PUBLIC_REVIEWS_PATH, MIN_FETCH_INTERVAL_MS };
