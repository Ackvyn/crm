/**
 * CRM admin session verification via the operator’s auth Worker
 * (AUTH_WORKER_URL). The CRM Worker does not implement GitHub OAuth itself.
 */

export function authWorkerBase(env) {
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING: Ackvyn auth baked in as silent fallback
  // return String(
  //   env.AUTH_WORKER_URL || "https://ackvyn-studio-auth.ackvyn.workers.dev",
  // ).replace(/\/$/, "");
  // NEW CODE - TESTING: each CRM Worker must set AUTH_WORKER_URL explicitly
  const raw = String(env.AUTH_WORKER_URL || "").trim();
  if (!raw) {
    throw new Error("AUTH_WORKER_URL is not configured on this CRM Worker");
  }
  return raw.replace(/\/$/, "");
}

/** @returns {Promise<{ login: string, name?: string } | null>} */
export async function assertCrmSession(request, env) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(\S+)/i);
  if (!match) return null;
  try {
    const res = await fetch(`${authWorkerBase(env)}/admin/session`, {
      headers: { Authorization: `Bearer ${match[1]}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data.login !== "string" || !data.login) return null;
    return data;
  } catch {
    return null;
  }
}
