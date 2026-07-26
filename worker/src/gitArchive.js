/**
 * Planned: persist contacts + form tickets (+ closed chat transcripts) as Git commits.
 * Durable Object stays the live layer for presence + open chats only.
 *
 * Form intake flow (target):
 * 1) Client or Worker receives form POST (one request)
 * 2) Worker commits JSON under e.g. crm/<site>/contacts|tickets/
 * 3) Admin UI reads from git / static content — not DO polls
 *
 * This stub is intentionally empty until a GitHub token + repo path are wired.
 */

/**
 * @param {{ site: string, kind: 'contact' | 'ticket' | 'chat', payload: unknown }} _entry
 * @returns {Promise<{ ok: boolean, skipped: boolean, reason?: string }>}
 */
export async function commitCrmRecord(_entry) {
  return {
    ok: true,
    skipped: true,
    reason: "github_archive_not_wired",
  };
}
