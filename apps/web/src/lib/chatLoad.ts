/** Pure helpers for the team chat load (lib/chat.ts); no React, no socket, so node tests import them. */

/** The hidden per-org chat container project. */
export const TEAM_CHAT_TITLE = 'Team Chat'

/** The whole chat load (org, project, channels, messages) gives up after this, so the page never sticks on "Loading…". */
export const CHAT_LOAD_TIMEOUT_MS = 30_000

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((ok, fail) => {
    const t = setTimeout(() => fail(new Error('timeout')), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        ok(v)
      },
      (e) => {
        clearTimeout(t)
        fail(e)
      },
    )
  })
}

/** The oldest project titled exactly "Team Chat" (a workspace may hold old duplicates; the first one wins). */
export function pickChatProject<T extends { title?: string; createdAt?: string }>(
  projects: T[],
): T | undefined {
  return projects
    .filter((p) => p.title === TEAM_CHAT_TITLE)
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))[0]
}
