/**
 * Frontend session management for yv..
 *
 * The session is the API's httpOnly cookies (ADR-0017); this module keeps only
 * the signed-in user's profile in localStorage as a UI hint.
 *
 * The `useAuth()` hook returns `{ session, authenticated }` where `session.user`
 * is a `SessionUser` shape imported from services/api.ts (single source of truth).
 */
import { useEffect, useState } from 'react'

import { login as apiLogin, logout as apiLogout, getMe } from '../services/api'
import { clearDataCaches } from './data'
import type { SessionUser } from '../services/api'

/** Legacy TeamMember shape - kept for components that still import it. */
export interface TeamMember {
  id: string
  name: string
  email: string
  role: string
  title?: string
  initials: string
}

/** Mapped from SessionUser → TeamMember (used by the fallback path). */
function mapUserToTeamMember(user: SessionUser): TeamMember {
  const initials = user.name.split(' ').reduce((a, b) => a + b[0], '')
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    title: user.title,
    initials,
  }
}

/**
 * The signed-in user's PROFILE, persisted in localStorage as a UI hint. It
 * holds no tokens: the session itself is the API's httpOnly cookies (ADR-0017)
 * and is re-validated with /auth/me on load.
 */
export interface BackendSession {
  user: SessionUser
  loggedInAt: string
}

/** Read the session from the persisted store. */
function readPersistedSession(): BackendSession | null {
  try {
    const raw = localStorage.getItem('yv.session')
    if (!raw) return null
    const parsed = JSON.parse(raw) as BackendSession & { user?: SessionUser & { _id?: string } }
    const uid = parsed.user?.id ?? parsed.user?._id
    if (parsed.user && uid) return parsed as BackendSession
    return null
  } catch {
    return null
  }
}

/** Write the session to localStorage (kept in sync with the backend cookie). */
function writePersistedSession(session: BackendSession): void {
  try {
    localStorage.setItem('yv.session', JSON.stringify(session))
  } catch {
    /* storage unavailable - in-memory only */
  }
}

/** ------------------------------------------------------------------- */
/** Log in using the real backend. Returns the session or null. */
async function loginBackend(email: string, password: string): Promise<BackendSession | null> {
  try {
    const data = await apiLogin(email, password)
    // The API set the session cookies; keep only the profile.
    const session: BackendSession = { user: data.user, loggedInAt: data.loggedInAt }
    writePersistedSession(session)
    return session
  } catch {
    return null
  }
}

/** ------------------------------------------------------------------- */
/** Sign out - revokes the token on the backend and clears localStorage. */
async function logoutBackend(): Promise<void> {
  try {
    // Revokes the session server-side and clears the cookies + local profile.
    await apiLogout()
  } catch {
    /* ignore logout errors */
  }
  try {
    localStorage.removeItem('yv.session')
  } catch {
    /* noop */
  }
  clearDataCaches()
}

/** ------------------------------------------------------------------- */
/** Core auth hook - priority: backend session → demo fallback. */
export function useAuth() {
  // Initialize from the persisted session once (lazy initializer) so we never
  // call setState during render - that would cause an infinite re-render loop.
  const [session, setSession] = useState<BackendSession | null>(() => readPersistedSession())
  const [authenticated, setAuthenticated] = useState<boolean>(() => {
    const s = readPersistedSession() as
      (BackendSession & { user?: SessionUser & { _id?: string } }) | null
    return !!(s?.user?.id ?? s?.user?._id)
  })

  // 2️⃣ Re-validate the cookie session once per page load. getMe() refreshes an
  // expired access cookie transparently; if the session is over (refresh
  // revoked/expired), the API client clears the local profile and we sign out.
  useEffect(() => {
    // No persisted profile means nobody signed in on this browser: skip the
    // /auth/me probe so the login page does not log a 401 on every visit.
    if (!readPersistedSession()) return
    let cancelled = false
    getMe()
      .then((data) => {
        if (cancelled) return
        const prev = readPersistedSession()
        const user = {
          ...data,
          id:
            (data as SessionUser & { _id?: string }).id ??
            (data as SessionUser & { _id?: string })._id,
        }
        const next: BackendSession = {
          user,
          loggedInAt: prev?.loggedInAt ?? new Date().toISOString(),
        }
        setSession(next)
        setAuthenticated(true)
        writePersistedSession(next)
      })
      .catch(() => {
        // network error: keep the hint; session over: the profile is gone
        if (!cancelled && !readPersistedSession()) {
          setSession(null)
          setAuthenticated(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 3️⃣ Listen for storage events (e.g. another tab signing out)
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === 'yv.session') {
        const s = readPersistedSession()
        setSession(s)
        setAuthenticated(!!s?.user?.id)
      }
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [session])

  return { session, authenticated }
}

/** ------------------------------------------------------------------- */
/** Log in with email+password - tries backend first. */
export async function login(email: string, password: string): Promise<BackendSession | null> {
  return await loginBackend(email, password)
}

/** ------------------------------------------------------------------- */
/** Update the persisted session's user fields (e.g. after a profile edit). */
export function updateSessionUser(patch: Partial<SessionUser>): void {
  const session = readPersistedSession()
  if (!session) return
  const next = { ...session, user: { ...session.user, ...patch } }
  writePersistedSession(next)
  // Notify every hook (same-tab storage writes don't fire native events).
  try {
    window.dispatchEvent(new StorageEvent('storage', { key: 'yv.session' }))
  } catch {
    /* noop */
  }
}

/** ------------------------------------------------------------------- */
/** Sign out - backend first, then cleanup. */
export async function logout(): Promise<void> {
  await logoutBackend()
  // Close the chat socket so it doesn't hold a stale session
  try {
    const { closeChatSocket } = await import('./chat')
    closeChatSocket()
  } catch {
    /* chat module may not be loaded yet */
  }
}

/** ------------------------------------------------------------------- */
/** Check authentication status. */
export function isAuthenticated(): boolean {
  const s = readPersistedSession()
  return !!s?.user?.id
}

/** ------------------------------------------------------------------- */
/** Get the current session. */
export function getSession(): BackendSession | null {
  return readPersistedSession()
}

/** ------------------------------------------------------------------- */
/** Map backend session user to the legacy TeamMember shape. */
export function mapUser(user: SessionUser): TeamMember {
  return mapUserToTeamMember(user)
}

/** ------------------------------------------------------------------- */
/** Subscribe to auth state changes. */
export function useAuthState() {
  const { session, authenticated } = useAuth()
  return { session, authenticated }
}
