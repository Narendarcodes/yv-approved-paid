/**
 * yv. frontend API client.
 *
 * Talks to the Node/Express backend. The base URL is fixed at BUILD time via
 * `VITE_API_BASE_URL` (Vite inlines `import.meta.env.VITE_*`). When it is not
 * set, the client uses the same-origin path `/api/v1`, which works behind a
 * reverse proxy in production and through the Vite dev proxy locally.
 *
 * All requests include the Bearer access token obtained from the session.
 */
import type { DealView, DealLedgerView, DealChangeOrder } from '../contracts/types'

export const API_BASE: string = (import.meta.env.VITE_API_BASE_URL || '/api/v1').replace(/\/+$/, '')

/**
 * Origin of the backend (API_BASE without the /api/v1 path). Empty string when
 * the API is same-origin, so `${API_ORIGIN}/api/v1/users/<id>/photo` stays relative.
 */
export const API_ORIGIN: string = API_BASE.replace(/\/api\/v1$/, '')

/**
 * Session (ADR-0017). Tokens never touch JS: the API keeps the access and
 * refresh tokens in httpOnly cookies, sent automatically with
 * `credentials: 'include'`. JS only holds:
 *   - the signed-in user's profile (localStorage 'yv.session', no secrets) as
 *     a UI hint, re-validated with /auth/me;
 *   - the CSRF token, echoed in X-CSRF-Token on unsafe requests (from the
 *     login/refresh response, the readable csrfToken cookie, or /auth/csrf).
 */
const SESSION_KEY = 'yv.session'
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

let csrfToken: string | null = null

function readCookie(name: string): string | null {
  const hit = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`))
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null
}

/** CSRF token for unsafe requests (memory, then cookie, then the API). */
async function getCsrfToken(forceFetch = false): Promise<string | null> {
  if (!forceFetch) {
    csrfToken = csrfToken || readCookie('csrfToken')
    if (csrfToken) return csrfToken
  }
  try {
    const res = await fetch(`${API_BASE}/auth/csrf`, { credentials: 'include' })
    if (!res.ok) return null
    csrfToken = (await res.json())?.data?.csrfToken ?? null
  } catch {
    csrfToken = null
  }
  return csrfToken
}

/** Forget the local session hint and CSRF token (the cookies are the server's). */
function clearLocalSession() {
  csrfToken = null
  try {
    localStorage.removeItem(SESSION_KEY)
    // same-tab listeners (useAuth) do not get native storage events
    window.dispatchEvent(new StorageEvent('storage', { key: SESSION_KEY }))
  } catch {
    /* storage unavailable: nothing to clear */
  }
}

/**
 * Renew the session via the httpOnly refresh cookie (single flight). The API
 * rotates the refresh token and re-sets the access cookie, so <video>/<img>
 * keep working too. False = session is over (revoked, expired or reused).
 */
let refreshInFlight: Promise<boolean> | null = null
export async function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    try {
      const csrf = await getCsrfToken()
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
        body: '{}',
        credentials: 'include',
      })
      if (!res.ok) {
        if (res.status === 401) clearLocalSession() // RequireAuth sends the user to /login
        return false
      }
      csrfToken = (await res.json())?.data?.csrfToken ?? csrfToken
      return true
    } catch {
      return false
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

/**
 * fetch for the API: cookies always included, X-CSRF-Token on unsafe methods,
 * one transparent retry after refreshing an expired session (401) or a stale
 * CSRF token (403 csrf_failed).
 */
async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const method = (options.method || 'GET').toUpperCase()
  const send = async (): Promise<Response> => {
    const headers = new Headers(options.headers)
    if (!headers.has('Content-Type') && options.body && !(options.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json')
    }
    if (UNSAFE.has(method)) {
      const csrf = await getCsrfToken()
      if (csrf) headers.set('X-CSRF-Token', csrf)
    }
    return fetch(url, { ...options, headers, credentials: 'include' })
  }
  let res = await send()
  if (res.status === 401 && (await refreshSession())) {
    res = await send()
  } else if (res.status === 403 && UNSAFE.has(method)) {
    const code = (
      await res
        .clone()
        .json()
        .catch(() => null)
    )?.error?.code
    if (code === 'csrf_failed' && (await getCsrfToken(true))) res = await send()
  }
  return res
}

function normalize<T extends Record<string, any>>(doc: T): T & { id: string } {
  if (!doc || typeof doc !== 'object') return doc as T & { id: string }
  const { _id, ...rest } = doc as any
  return { ...rest, id: String(_id ?? rest.id) } as T & { id: string }
}

function normalizeList<T extends Record<string, any>>(
  arr: T[] | undefined,
): (T & { id: string })[] {
  return Array.isArray(arr) ? arr.map(normalize) : []
}

export interface SessionUser {
  id: string
  name: string
  email: string
  role: string
  title?: string
  organization?: string
  photoUrl?: string | null
  profileImage?: string | null
}

export interface Session {
  user: SessionUser
  loggedInAt: string
}

/** Check whether an organization name/slug is already registered (public). */
export async function checkOrgAvailability(
  slug: string,
  name: string,
): Promise<{ slugTaken: boolean; nameTaken: boolean }> {
  const qs = new URLSearchParams({ slug, name })
  const res = await fetch(`${API_BASE}/organizations/availability?${qs}`)
  if (!res.ok) throw new Error('Availability check failed')
  const body = await res.json()
  return body.data ?? { slugTaken: false, nameTaken: false }
}

/** Register a new user with name+email+password */
export async function register(
  name: string,
  email: string,
  password: string,
): Promise<SessionUser> {
  const res = await fetch(`${API_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error?.message || 'Registration failed')
  }
  const body = await res.json()
  const u = (body.data ?? {}) as SessionUser & { _id?: string }
  return { ...u, id: u.id ?? u._id ?? '' } as SessionUser
}

/**
 * Why a sign-in failed, so the login screen never shows "wrong password" for a
 * backend that is down or misrouted. Ported from postiz-absorption d25400d.
 */
export type LoginFailure =
  'unreachable' | 'not_found' | 'invalid_credentials' | 'rate_limited' | 'server'

export class LoginError extends Error {
  readonly kind: LoginFailure
  readonly status?: number
  constructor(kind: LoginFailure, message: string, status?: number) {
    super(message)
    this.name = 'LoginError'
    this.kind = kind
    this.status = status
  }
}

/** Login with email+password; the API sets the session cookies. Returns { user }. Throws LoginError. */
export async function login(email: string, password: string): Promise<Session> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      credentials: 'include', // the API sets httpOnly session cookies
    })
  } catch {
    throw new LoginError('unreachable', 'The yv. API is not responding.')
  }
  if (!res.ok) {
    const errBody = await res.json().catch(() => null)
    const code: string = errBody?.error?.code || ''
    const msg: string = errBody?.error?.message || ''
    if (code === 'invalid_credentials' || res.status === 401) {
      throw new LoginError('invalid_credentials', msg || 'Invalid credentials', res.status)
    }
    if (res.status === 404)
      throw new LoginError('not_found', `Sign-in endpoint not found at ${API_BASE}`, 404)
    if (res.status === 429) throw new LoginError('rate_limited', msg || 'Too many attempts', 429)
    if (res.status >= 502 && res.status <= 504)
      throw new LoginError('unreachable', 'The yv. API is not responding.', res.status)
    throw new LoginError('server', msg || `Sign-in failed (HTTP ${res.status})`, res.status)
  }
  const body = (await res.json()) as { data?: { user: SessionUser; csrfToken?: string } }
  csrfToken = body.data?.csrfToken ?? readCookie('csrfToken')
  // Backend users use `_id`; normalize to `id` so readPersistedSession() recognizes it.
  const u = (body.data?.user ?? {}) as SessionUser & { _id?: string }
  const session: Session = {
    user: { ...u, id: u.id ?? u._id ?? '' },
    loggedInAt: new Date().toISOString(),
  }
  // Persist the PROFILE only (no tokens: those are httpOnly cookies) so
  // useAuth() picks it up (mirrors lib/auth.writePersistedSession).
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    // Same-tab sessions never receive native storage events, so notify the
    // auth hook explicitly - otherwise RequireAuth bounces the user back
    // to /login even though sign-in succeeded.
    window.dispatchEvent(new StorageEvent('storage', { key: SESSION_KEY }))
  } catch {
    /* storage unavailable - in-memory only */
  }
  return session
}

/** Update the signed-in user's profile (name and/or email). */
export async function updateMe(patch: { name?: string; email?: string }): Promise<SessionUser> {
  const res = await authFetch(`${API_BASE}/users/me`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    credentials: 'include',
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error?.message || 'Profile update failed')
  }
  const body = await res.json()
  const u = (body.data ?? {}) as SessionUser & { _id?: string }
  return { ...u, id: u.id ?? u._id ?? '' } as SessionUser
}

/** Upload profile photo (multipart). Returns updated user. Handles 401 via refresh. */
export async function uploadProfilePhoto(
  file: File,
): Promise<SessionUser & { photoUrl?: string; profileImage?: string }> {
  const form = new FormData()
  form.append('file', file)
  // For FormData, do NOT set Content-Type — browser sets multipart boundary
  const res = await authFetch(`${API_BASE}/users/me/photo`, { method: 'PATCH', body: form })
  if (!res.ok) {
    const b = await res.json().catch(() => null)
    throw new Error(b?.error?.message || b?.error?.code || 'Photo upload failed')
  }
  const body = await res.json()
  const u = (body.data ?? {}) as any
  return { ...u, id: u.id ?? u._id ?? '' }
}

/** Remove profile photo. Returns updated user. */
export async function removeProfilePhoto(): Promise<
  SessionUser & { photoUrl?: string; profileImage?: string }
> {
  const res = await authFetch(`${API_BASE}/users/me/photo`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!res.ok) {
    const b = await res.json().catch(() => null)
    throw new Error(b?.error?.message || 'Remove photo failed')
  }
  const body = await res.json()
  const u = (body.data ?? {}) as any
  return { ...u, id: u.id ?? u._id ?? '' }
}

/** Log out: the API revokes the whole session and clears the cookies. */
export async function logout(): Promise<{ loggedOut: boolean }> {
  try {
    const res = await authFetch(`${API_BASE}/auth/logout`, { method: 'POST', body: '{}' })
    return (
      (await res.json().catch(() => ({ data: { loggedOut: res.ok } })))?.data ?? {
        loggedOut: res.ok,
      }
    )
  } finally {
    clearLocalSession()
  }
}

/** Get the current user's profile (me endpoint) */
export async function getMe(): Promise<SessionUser> {
  const res = await authFetch(`${API_BASE}/auth/me`, {
    credentials: 'include',
  })
  if (!res.ok) throw new Error('Failed to fetch profile')
  const body = (await res.json()) as { data?: SessionUser }
  const u = body.data ?? (body as SessionUser)
  // Backend users use `_id`; normalize to `id`.
  return {
    ...u,
    id: (u as SessionUser & { _id?: string }).id ?? (u as SessionUser & { _id?: string })._id,
  }
}

/** ------------------------------------------------------------------- */
/* Organizations */
export interface Org {
  id: string
  name: string
  slug: string
  createdAt: string
}

export interface OrgMember {
  id: string
  name: string
  email: string
  role: string
  title?: string
  lastActive?: string
  /** Invited (demo) and not signed up yet. */
  pending?: boolean
  disabled?: boolean
}

export async function listOrgs(): Promise<Org[]> {
  const res = await authFetch(`${API_BASE}/organizations`, { credentials: 'include' })
  if (!res.ok) throw new Error('Failed to list organizations')
  const body = await res.json()
  return normalizeList(body.data)
}

export async function createOrg(name: string, slug: string): Promise<Org> {
  const res = await authFetch(`${API_BASE}/organizations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, slug }),
    credentials: 'include',
  })
  if (!res.ok) throw new Error('Failed to create organization')
  return res.json()
}

export async function listMembers(orgId: string): Promise<OrgMember[]> {
  const res = await authFetch(`${API_BASE}/organizations/${orgId}/members`, {
    credentials: 'include',
  })
  if (!res.ok) throw new Error('Failed to list members')
  const body = await res.json()
  const items = Array.isArray(body.data) ? body.data : []
  // Membership docs carry the user under `userId` (populated). Projects
  // reference the *user* id, so expose that as `id` (not the membership id).
  return items.map((m: any) => ({
    id: String(m.userId?._id ?? m._id ?? m.id),
    name: m.name || m.userId?.name || '',
    email: m.email || m.userId?.email || '',
    role: m.role || m.userId?.role || 'member',
    title: m.title || m.userId?.title || '',
    lastActive: m.lastActive || '-',
    pending: m.pending === true,
    disabled: m.disabled === true || m.userId?.disabled === true,
  }))
}

/**
 * Add a member by email (manage_members). No email is ever sent. On the public
 * demo (DEMO_MODE=1) only example.com addresses are accepted, and one with no
 * account yet is added as a pending member.
 */
export async function addMember(
  orgId: string,
  email: string,
  role: string,
): Promise<{ pending?: boolean; emailSent?: boolean; role: string; user?: { _id: string; name: string; email: string } }> {
  return sendJson('POST', `/organizations/${encodeURIComponent(orgId)}/members`, { email, role })
}

/** ------------------------------------------------------------------- */
/* Projects */
// Project type is defined in lib/types.ts (single source of truth).
// This interface mirrors the API response shape; callers should use
// normalizeProject() from data.ts to get the domain Project type.
export interface Project {
  id: string
  title: string
  type: string
  status: string
  assignee: string
  creator: string
  reviewers: string[]
  updated: string
  approvedVersion?: string
}

export async function listProjects(organizationId: string): Promise<Project[]> {
  const res = await authFetch(
    `${API_BASE}/projects?organizationId=${encodeURIComponent(organizationId)}`,
    { credentials: 'include' },
  )
  if (!res.ok) throw new Error('Failed to list projects')
  const body = await res.json()
  // Backend returns { data: [...] } or { data: { items, total } }
  const arr = Array.isArray(body.data) ? body.data : (body.data?.items ?? [])
  return normalizeList(arr)
}

export async function getProject(id: string, organizationId?: string): Promise<any> {
  const qs = organizationId ? `?organizationId=${encodeURIComponent(organizationId)}` : ''
  const res = await authFetch(`${API_BASE}/projects/${id}${qs}`, { credentials: 'include' })
  if (!res.ok) throw new Error('Failed to fetch project')
  const body = await res.json()
  return body.data
}

export async function createProject(input: {
  title: string
  type?: string
  organizationId?: string
}): Promise<Project> {
  const res = await authFetch(`${API_BASE}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    credentials: 'include',
  })
  if (!res.ok) throw new Error('Failed to create project')
  const body = await res.json()
  return normalize(body.data)
}

/** ------------------------------------------------------------------- */
/* Notifications */
export interface AppNotification {
  id: string
  type: 'review' | 'comment' | 'revision' | 'approval' | 'schedule' | 'published'
  title: string
  desc: string
  time: string
  unread: boolean
}

export async function listNotifications(unreadOnly = false): Promise<AppNotification[]> {
  const res = await authFetch(`${API_BASE}/notifications?unreadOnly=${unreadOnly}`, {
    credentials: 'include',
  })
  const body = await res.json()
  if (!res.ok) throw new Error('Failed to list notifications')
  const raw: any[] = body.data ?? []
  return raw.map((n: any) => ({
    id: String(n.id ?? n._id ?? ''),
    type: n.type,
    title: n.title || '',
    desc: n.body || n.desc || '',
    time: n.time || n.createdAt || '',
    unread: n.unread ?? !n.read,
  })) as AppNotification[]
}

export async function markRead(id: string): Promise<AppNotification> {
  const res = await authFetch(`${API_BASE}/notifications/${id}/read`, {
    method: 'PATCH',
    credentials: 'include',
  })
  if (!res.ok) throw new Error('Failed to mark notification read')
  const body = await res.json()
  const n = body.data
  return {
    id: n.id ?? n._id,
    type: n.type,
    title: n.title || '',
    desc: n.body || n.desc || '',
    time: n.createdAt,
    unread: false,
  }
}

export async function markAllRead(): Promise<{ marked: number }> {
  const res = await authFetch(`${API_BASE}/notifications/read-all`, {
    method: 'PATCH',
    credentials: 'include',
  })
  if (!res.ok) throw new Error('Failed to mark all read')
  return res.json()
}

export async function unreadCount(): Promise<{ unread: number }> {
  const res = await authFetch(`${API_BASE}/notifications/unread-count`, {
    credentials: 'include',
  })
  if (!res.ok) throw new Error('Failed to fetch unread count')
  return res.json()
}

/** ------------------------------------------------------------------- */
/* Chat (WhatsApp imports land here, hosted under a "Team Chat" project) */
export async function listProjectChannels(projectId: string) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/channels`, {
    credentials: 'include',
  })
  if (!res.ok) throw new Error('Failed to list channels')
  const body = await res.json()
  return normalizeList(body.data)
}

export async function listChannelMessages(projectId: string, channelId: string) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/channels/${channelId}/messages`, {
    credentials: 'include',
  })
  if (!res.ok) throw new Error('Failed to list messages')
  const body = await res.json()
  const items = body.data?.items ?? body.data ?? []
  return normalizeList(items)
}

/** ------------------------------------------------------------------- */
/* Version files (video drafts) */
export interface VersionFile {
  id: string
  filename: string
  mimeType: string
  size: number
}

export interface ProjectVersion {
  id: string
  versionNumber: number
  changeSummary: string
  createdAt: string
  files: VersionFile[]
}

/**
 * URL for streaming a version file (Range-aware). Plain URL, no token: the
 * <video> element sends the httpOnly access cookie itself (same site), and the
 * API no longer accepts tokens in URLs (ADR-0017).
 */
export function versionFileUrl(projectId: string, versionId: string, fileId: string): string {
  return `${API_BASE}/projects/${projectId}/versions/${versionId}/files/${fileId}`
}

async function authedJson<T>(url: string): Promise<T> {
  const res = await authFetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error('Request failed')
  const body = await res.json()
  const data = body?.data ?? body
  return (Array.isArray(data) ? data : (data?.items ?? [])) as T
}

export async function listVersions(projectId: string): Promise<ProjectVersion[]> {
  const raw = await authedJson<any[]>(`${API_BASE}/projects/${projectId}/versions`)
  return raw.map((v) => ({
    id: String(v._id ?? v.id),
    versionNumber: v.versionNumber,
    changeSummary: v.changeSummary ?? '',
    createdAt: v.createdAt,
    files: (v.files ?? []).map((f: any) => ({
      id: String(f._id),
      filename: f.filename,
      mimeType: f.mimeType,
      size: f.size,
    })),
  }))
}

/** Create a new version entry for a project. */
export async function createVersion(
  projectId: string,
  changeSummary: string,
): Promise<ProjectVersion> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/versions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changeSummary }),
    credentials: 'include',
  })
  if (!res.ok) throw new Error('Failed to create version')
  const body = await res.json()
  const v = body.data
  return {
    id: String(v._id ?? v.id),
    versionNumber: v.versionNumber,
    changeSummary: v.changeSummary ?? '',
    createdAt: v.createdAt,
    files: (v.files ?? []).map((f: any) => ({
      id: String(f._id),
      filename: f.filename,
      mimeType: f.mimeType,
      size: f.size,
    })),
  }
}

/** Upload a file to an existing version (multipart form). Retries once after a session refresh on 401. */
export async function uploadVersionFile(
  projectId: string,
  versionId: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<{ id: string; filename: string; mimeType: string; size: number }[]> {
  const doUpload = (csrf: string | null) =>
    new Promise<{ id: string; filename: string; mimeType: string; size: number }[]>(
      (resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', `${API_BASE}/projects/${projectId}/versions/${versionId}/files`)
        if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf)
        xhr.withCredentials = true // httpOnly session cookies
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100))
        })
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const body = JSON.parse(xhr.responseText)
              const files = (body.data?.files ?? body.files ?? []).map((f: any) => ({
                id: String(f._id),
                filename: f.filename,
                mimeType: f.mimeType,
                size: f.size,
              }))
              resolve(files)
            } catch {
              reject(new Error('Failed to parse upload response'))
            }
          } else {
            let msg = `Upload failed (${xhr.status})`
            try {
              const body = JSON.parse(xhr.responseText)
              msg = body?.error?.message || body?.error?.code || msg
            } catch {
              /* response was not JSON: keep the default upload message */
            }
            reject(new Error(msg))
          }
        }
        xhr.onerror = () => reject(new Error('Network error during upload'))
        const formData = new FormData()
        formData.append('file', file)
        xhr.send(formData)
      },
    )

  try {
    return await doUpload(await getCsrfToken())
  } catch (err: any) {
    const msg = String(err?.message || '')
    if (/401|Invalid token|invalid_token|expired/i.test(msg) && (await refreshSession())) {
      return await doUpload(await getCsrfToken())
    }
    if (/csrf/i.test(msg)) return await doUpload(await getCsrfToken(true))
    throw err
  }
}

/** ------------------------------------------------------------------- */
/* Concepts (idea pipeline before projects) */
export interface Concept {
  id: string
  title: string
  description: string
  type: 'New Concept' | 'Experiment' | 'Revision'
  status: 'IDEA' | 'APPROVED' | 'DECLINED'
  proposer?: string | null
  proposerName?: string | null
  approvedProjectId?: string | null
  createdAt?: string
}

export async function listConcepts(orgId: string): Promise<Concept[]> {
  const res = await authFetch(`${API_BASE}/organizations/${orgId}/concepts`)
  if (!res.ok) throw new Error(`listConcepts failed (${res.status})`)
  const json = await res.json()
  return json.data ?? []
}

export async function createConcept(
  orgId: string,
  input: { title: string; description: string; type: Concept['type'] },
): Promise<Concept> {
  const res = await authFetch(`${API_BASE}/organizations/${orgId}/concepts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`createConcept failed (${res.status})`)
  return (await res.json()).data
}

export interface ConceptConversion {
  client?: string
  campaign?: string
  brief?: {
    goal?: string
    targetAudience?: string
    deliverables?: string[]
    deadline?: string | null
    references?: string[]
  }
}
export async function approveConcept(
  orgId: string,
  conceptId: string,
  conversion: ConceptConversion = {},
): Promise<{ projectId: string }> {
  const res = await authFetch(`${API_BASE}/organizations/${orgId}/concepts/${conceptId}/approve`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(conversion),
    credentials: 'include',
  })
  if (!res.ok) throw new Error(`approveConcept failed (${res.status})`)
  const json = await res.json()
  return { projectId: json.data.projectId }
}

export async function declineConcept(orgId: string, conceptId: string): Promise<void> {
  const res = await authFetch(`${API_BASE}/organizations/${orgId}/concepts/${conceptId}/decline`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
  })
  if (!res.ok) throw new Error(`declineConcept failed (${res.status})`)
}

/** Send a chat message to a channel (persisted server-side). */
export async function sendChannelMessage(projectId: string, channelId: string, body: string) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
    credentials: 'include',
  })
  if (!res.ok) {
    const err = await res.json().catch(() => null)
    throw new Error(err?.error?.message || 'Failed to send message')
  }
  const payload = await res.json()
  return normalize(payload.data)
}

/** Create a channel under the Team Chat project. */
export async function createChannel(projectId: string, name: string) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
    credentials: 'include',
  })
  if (!res.ok) {
    const err = await res.json().catch(() => null)
    throw new Error(err?.error?.message || 'Failed to create channel')
  }
  const payload = await res.json()
  return normalize(payload.data)
}

/** ------------------------------------------------------------------- */
/* Tasks (kanban) */
export interface TaskItem {
  id: string
  projectId: string
  title: string
  description?: string
  status: 'todo' | 'in_progress' | 'in_review' | 'done'
  priority: 'low' | 'medium' | 'high'
  assignee: string
  dueDate?: string | null
}

export async function listTasks(projectId: string): Promise<TaskItem[]> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/tasks`, { credentials: 'include' })
  if (!res.ok) throw new Error('Failed to list tasks')
  const body = await res.json()
  const items = Array.isArray(body.data) ? body.data : (body.data?.items ?? [])
  return normalizeList(items) as TaskItem[]
}

/** Move a task to a new status (kanban drag-and-drop persistence). */
export async function setTaskStatus(
  projectId: string,
  taskId: string,
  status: TaskItem['status'],
): Promise<TaskItem> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/tasks/${taskId}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
    credentials: 'include',
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error?.message || 'Failed to move task')
  }
  const body = await res.json()
  return normalize(body.data) as TaskItem
}

/** ------------------------------------------------------------------- */
/* Comments / reviews */
export interface CommentItem {
  id: string
  projectId: string
  author: string
  body: string
  resolved: boolean
  createdAt?: string
}

export async function listComments(projectId: string): Promise<CommentItem[]> {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/comments`, {
    credentials: 'include',
  })
  if (!res.ok) throw new Error('Failed to list comments')
  const body = await res.json()
  const items = Array.isArray(body.data) ? body.data : (body.data?.items ?? [])
  return normalizeList(items) as CommentItem[]
}

/** ------------------------------------------------------------------- */
/* Project sub-resources (inputs, metrics, publications, activity) */
export async function listInputs(projectId: string) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/inputs`, {
    credentials: 'include',
  })
  if (!res.ok) throw new Error('Failed to list inputs')
  const body = await res.json()
  return normalizeList(Array.isArray(body.data) ? body.data : (body.data?.items ?? []))
}

export async function listMetrics(projectId: string) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/metrics`, {
    credentials: 'include',
  })
  if (!res.ok) throw new Error('Failed to list metrics')
  const body = await res.json()
  return normalizeList(Array.isArray(body.data) ? body.data : (body.data?.items ?? []))
}

export async function listPublications(projectId: string) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/publications`, {
    credentials: 'include',
  })
  if (!res.ok) throw new Error('Failed to list publications')
  const body = await res.json()
  return normalizeList(Array.isArray(body.data) ? body.data : (body.data?.items ?? []))
}

export async function listActivity(projectId: string) {
  const res = await authFetch(`${API_BASE}/projects/${projectId}/activity`, {
    credentials: 'include',
  })
  if (!res.ok) throw new Error('Failed to list activity')
  const body = await res.json()
  return normalizeList(Array.isArray(body.data) ? body.data : (body.data?.items ?? []))
}

/** Org-wide activity feed (dashboard "Recent activity") — events across all org projects. */
export async function listOrgActivity(orgId: string, limit = 20) {
  const res = await authFetch(`${API_BASE}/organizations/${orgId}/activity?limit=${limit}`, {
    credentials: 'include',
  })
  if (!res.ok) throw new Error('Failed to list org activity')
  const body = await res.json()
  return normalizeList(Array.isArray(body.data) ? body.data : (body.data?.items ?? []))
}

/** ------------------------------------------------------------------- */
/* Write helpers shared by the lifecycle, review, brief, contract and invoice screens */
async function sendJson<T>(method: string, path: string, payload?: unknown): Promise<T> {
  const res = await authFetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    credentials: 'include',
  })
  const body = await res.json().catch(() => null)
  if (!res.ok)
    throw new ApiError(
      body?.error?.message || `Request failed (${res.status})`,
      body?.error?.code,
      body?.error?.details,
    )
  return body?.data as T
}
/** Error carrying the API's code + per-field details (e.g. platform settings validation). */
export class ApiError extends Error {
  code?: string
  details?: { platform?: string; field: string; message: string }[]
  constructor(message: string, code?: string, details?: ApiError['details']) {
    super(message)
    this.code = code
    this.details = details
  }
}
async function getJson<T>(path: string): Promise<T> {
  const res = await authFetch(`${API_BASE}${path}`, { credentials: 'include' })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.error?.message || `Request failed (${res.status})`)
  return body?.data as T
}

/* Project lifecycle */
export async function transitionProject(projectId: string, status: string) {
  return normalize(await sendJson<any>('POST', `/projects/${projectId}/transition`, { status }))
}
export async function approveVersion(projectId: string, versionId: string) {
  return normalize(await sendJson<any>('POST', `/projects/${projectId}/approve`, { versionId }))
}
export async function scheduleProject(projectId: string, scheduledAt: string) {
  return normalize(await sendJson<any>('POST', `/projects/${projectId}/schedule`, { scheduledAt }))
}
export async function recordPublication(projectId: string, platform: string, postUrl?: string) {
  return normalize(
    await sendJson<any>('POST', `/projects/${projectId}/publications`, {
      platform,
      postUrl: postUrl || null,
    }),
  )
}

/* Review */
export async function addComment(
  projectId: string,
  input: {
    body: string
    versionId?: string | null
    parentId?: string | null
    timecode?: number | null
  },
) {
  return normalize(await sendJson<any>('POST', `/projects/${projectId}/comments`, input))
}
export async function setCommentResolved(projectId: string, commentId: string, resolved: boolean) {
  return normalize(
    await sendJson<any>('PATCH', `/projects/${projectId}/comments/${commentId}`, { resolved }),
  )
}
export async function requestRevision(
  projectId: string,
  reason: string,
  sourceVersionId?: string | null,
) {
  return normalize(
    await sendJson<any>('POST', `/projects/${projectId}/revisions`, {
      reason,
      sourceVersionId: sourceVersionId || null,
    }),
  )
}
export interface ReviewSummary {
  totalComments: number
  actionItems: { commentId: string; body: string; requestedBy: string | null }[]
}
export async function summarizeReview(
  projectId: string,
  versionId?: string | null,
): Promise<ReviewSummary> {
  return sendJson<ReviewSummary>('POST', `/projects/${projectId}/reviews/summarize`, {
    versionId: versionId || null,
  })
}
export async function lockReview(
  projectId: string,
  versionId: string,
): Promise<{ lockedCommentCount: number; revision: any }> {
  return sendJson('POST', `/projects/${projectId}/reviews/lock`, { versionId })
}

/* Brief */
export interface Brief {
  goal?: string | null
  targetAudience?: string | null
  videoType?: string | null
  references?: string[]
  deliverables?: string[]
  deadline?: string | null
  brandGuidelines?: string | null
  specialInstructions?: string | null
}
export async function getBrief(projectId: string): Promise<Brief | null> {
  try {
    return await getJson<Brief | null>(`/projects/${projectId}/brief`)
  } catch {
    return null
  }
}
export async function saveBrief(projectId: string, brief: Brief): Promise<Brief> {
  return sendJson<Brief>('PUT', `/projects/${projectId}/brief`, brief)
}

/* Tasks */
export async function createTask(
  projectId: string,
  input: {
    title: string
    priority?: 'low' | 'medium' | 'high'
    assignee?: string | null
    dueDate?: string | null
  },
) {
  return normalize(await sendJson<any>('POST', `/projects/${projectId}/tasks`, input)) as TaskItem
}

/** Assign a project to an org member (needs project.assign). Returns the project with the populated assignee. */
export async function assignProject(projectId: string, assigneeId: string) {
  return normalize(await sendJson<any>('POST', `/projects/${projectId}/assign`, { assigneeId }))
}
/** Reassign a task (needs task.update); the assignee must be an active member of the org. */
export async function assignTask(projectId: string, taskId: string, assignee: string | null) {
  return normalize(await sendJson<any>('PATCH', `/projects/${projectId}/tasks/${taskId}`, { assignee })) as TaskItem
}

/* Contracts */
export interface Contract {
  id: string
  projectId?: string | null
  title: string
  terms?: string
  amount: number
  currency: string
  status: 'draft' | 'sent' | 'viewed' | 'signed'
  sentTo?: string
  sentAt?: string | null
  signedAt?: string | null
  signerName?: string | null
  signerEmail?: string | null
  createdAt?: string
}
export async function listContracts(orgId: string): Promise<Contract[]> {
  const data = await getJson<any>(`/organizations/${orgId}/contracts`)
  return normalizeList(Array.isArray(data) ? data : (data?.items ?? [])) as Contract[]
}
export async function createContract(
  orgId: string,
  input: {
    title: string
    amount?: number
    currency?: string
    terms?: string
    sentTo?: string
    projectId?: string | null
  },
) {
  return normalize(
    await sendJson<any>('POST', `/organizations/${orgId}/contracts`, input),
  ) as Contract
}
export async function contractAction(orgId: string, contractId: string, action: 'send' | 'view') {
  return normalize(
    await sendJson<any>('POST', `/organizations/${orgId}/contracts/${contractId}/${action}`),
  ) as Contract
}
export async function signContract(
  orgId: string,
  contractId: string,
  signerName: string,
  signerEmail: string,
) {
  return normalize(
    await sendJson<any>('POST', `/organizations/${orgId}/contracts/${contractId}/sign`, {
      signerName,
      signerEmail,
    }),
  ) as Contract
}

/* Invoices */
export interface Invoice {
  id: string
  projectId?: string | null
  number: string
  amount: number
  currency: string
  status: 'draft' | 'sent' | 'paid' | 'overdue' | 'void'
  issuedAt?: string
  dueDate?: string | null
  paidAt?: string | null
  paymentMethod?: string
  note?: string
}
export interface OutstandingSummary {
  totalOutstanding: number
  byCurrency: Record<string, number>
  invoiceCount: number
  overdue: { count: number; amount: number }
}
export async function listInvoices(orgId: string): Promise<Invoice[]> {
  const data = await getJson<any>(`/organizations/${orgId}/invoices`)
  return normalizeList(Array.isArray(data) ? data : (data?.items ?? [])) as Invoice[]
}
export async function outstandingInvoices(orgId: string): Promise<OutstandingSummary> {
  return getJson<OutstandingSummary>(`/organizations/${orgId}/invoices/outstanding`)
}
export async function createInvoice(
  orgId: string,
  input: {
    number: string
    amount: number
    currency?: string
    dueDate?: string | null
    note?: string
    projectId?: string | null
  },
) {
  return normalize(
    await sendJson<any>('POST', `/organizations/${orgId}/invoices`, input),
  ) as Invoice
}
export async function invoiceAction(
  orgId: string,
  invoiceId: string,
  action: 'send' | 'pay' | 'void',
  payload?: Record<string, unknown>,
) {
  return normalize(
    await sendJson<any>(
      'POST',
      `/organizations/${orgId}/invoices/${invoiceId}/${action}`,
      payload ?? {},
    ),
  ) as Invoice
}

/** ------------------------------------------------------------------- */
/* Social publishing (Postiz adapter / local scheduler) */
export type PlatformKey = 'instagram' | 'youtube' | 'linkedin' | 'x'
export interface SchedulingStatus {
  mode: 'local' | 'postiz'
  postizConfigured: boolean
  platforms: { key: PlatformKey; label: string }[]
  webhookPath: string
}
export interface SocialChannel {
  id: string
  platform: PlatformKey
  name: string
  handle: string
  picture?: string
  mode: 'demo' | 'postiz'
  externalId?: string
  status: 'connected' | 'expired' | 'disconnected'
  statusReason?: string
  lastCheckedAt?: string | null
  postizIdentifier?: string
  createdAt?: string
}
export interface PostizIntegration {
  id: string
  name: string
  picture: string
  providerIdentifier: string
  platform: PlatformKey | null
  disabled: boolean
}
export interface EligibleProject {
  id: string
  title: string
  description?: string
  status: string
  scheduledAt?: string | null
  approvedVersion: {
    id: string
    versionNumber: number
    label: string
    changeSummary?: string
    files: { id: string; filename: string; mimeType: string; size: number }[]
  } | null
}
export interface ScheduledPost {
  id: string
  projectId: string
  platform: string
  status: 'scheduled' | 'published' | 'failed' | 'cancelled'
  provider: 'manual' | 'local' | 'postiz'
  caption: string
  scheduledFor: string | null
  publishedAt: string | null
  postUrl: string
  externalPostId?: string
  failureReason?: string
  failedAt?: string | null
  retryCount?: number
  settings?: Record<string, unknown>
  versionId?: string | null
  fileId?: string | null
  metrics?: Record<string, number>
  metricsSimulated?: boolean
  lastSyncedAt?: string | null
  project: {
    _id: string
    title: string
    status: string
    publishProgress?: { published: number; total: number }
  } | null
  file?: { _id: string; filename: string; mimeType: string } | null
  channel: {
    _id: string
    platform: PlatformKey
    name: string
    handle: string
    mode: 'demo' | 'postiz'
  } | null
}

const sched = (orgId: string, path: string) => `/organizations/${orgId}/scheduling${path}`
function normEligible(p: any): EligibleProject {
  const n = normalize(p) as any
  if (n.approvedVersion) {
    n.approvedVersion = normalize(n.approvedVersion)
    n.approvedVersion.files = normalizeList(n.approvedVersion.files)
  }
  return n as EligibleProject
}

export async function getSchedulingStatus(orgId: string): Promise<SchedulingStatus> {
  return getJson<SchedulingStatus>(sched(orgId, '/status'))
}
export async function listSocialChannels(orgId: string): Promise<SocialChannel[]> {
  return normalizeList(await getJson<any[]>(sched(orgId, '/channels'))) as SocialChannel[]
}
export async function connectDemoChannel(
  orgId: string,
  input: { platform: PlatformKey; handle?: string; name?: string },
) {
  return normalize(await sendJson<any>('POST', sched(orgId, '/channels'), input)) as SocialChannel
}
export async function disconnectChannel(orgId: string, channelId: string) {
  return normalize(
    await sendJson<any>('DELETE', sched(orgId, `/channels/${channelId}`)),
  ) as SocialChannel
}
export async function listPostizIntegrations(orgId: string): Promise<PostizIntegration[]> {
  return getJson<PostizIntegration[]>(sched(orgId, '/postiz/integrations'))
}
export async function importPostizChannels(orgId: string): Promise<SocialChannel[]> {
  return normalizeList(
    await sendJson<any[]>('POST', sched(orgId, '/postiz/import')),
  ) as SocialChannel[]
}
export async function listEligibleProjects(orgId: string): Promise<EligibleProject[]> {
  return ((await getJson<any[]>(sched(orgId, '/eligible-projects'))) || []).map(normEligible)
}
export async function listScheduledPosts(
  orgId: string,
  range: { from?: string; to?: string; projectId?: string } = {},
): Promise<ScheduledPost[]> {
  const qs = new URLSearchParams()
  if (range.from) qs.set('from', range.from)
  if (range.to) qs.set('to', range.to)
  if (range.projectId) qs.set('projectId', range.projectId)
  const q = qs.toString()
  return normalizeList(
    await getJson<any[]>(sched(orgId, `/posts${q ? `?${q}` : ''}`)),
  ) as unknown as ScheduledPost[]
}
export interface PlatformSettings {
  instagram?: { format: 'post' | 'reel' | 'story'; collaborators: string[] }
  youtube?: {
    title: string
    visibility: 'public' | 'unlisted' | 'private'
    madeForKids?: boolean
    tags: string[]
    thumbnailFileId?: string | null
  }
  x?: { whoCanReply: 'everyone' | 'following' | 'mentionedUsers' | 'subscribers' | 'verified' }
  linkedin?: { carousel: boolean; carouselName?: string }
}
export interface ConnectStart {
  mode: 'postiz' | 'demo'
  url?: string
  simulated?: boolean
  reconnect?: boolean
  channel?: SocialChannel
}
export interface TimeSuggestion {
  suggestedAt: string
  source: 'postiz' | 'history' | 'heuristic' | 'mixed'
  reason: string
  timezone: string
  perChannel: { channelId: string; platform: PlatformKey; at: string; source: string }[]
}
export async function startChannelConnect(
  orgId: string,
  input: { platform: PlatformKey; handle?: string; identifier?: string },
) {
  const d = await sendJson<any>('POST', sched(orgId, '/channels/connect'), input)
  if (d?.channel) d.channel = normalize(d.channel)
  return d as ConnectStart
}
export async function reconnectChannel(orgId: string, channelId: string) {
  const d = await sendJson<any>('POST', sched(orgId, `/channels/${channelId}/reconnect`))
  if (d?.channel) d.channel = normalize(d.channel)
  return d as ConnectStart
}
export async function completeChannelConnect(orgId: string) {
  const d = await sendJson<any>('POST', sched(orgId, '/channels/connect/complete'))
  return normalizeList(d?.channels || []) as SocialChannel[]
}
export async function checkChannels(orgId: string) {
  return sendJson<{ mode: string; apiKeyValid: boolean | null; checked: number; expired: number }>(
    'POST',
    sched(orgId, '/channels/check'),
  )
}
export async function suggestPostTime(orgId: string, channelIds: string[]) {
  return getJson<TimeSuggestion>(
    sched(orgId, `/suggest-time?channelIds=${channelIds.map(encodeURIComponent).join(',')}`),
  )
}
export async function retryPost(orgId: string, postId: string, scheduledAt?: string) {
  return normalize(
    await sendJson<any>(
      'POST',
      sched(orgId, `/posts/${postId}/retry`),
      scheduledAt ? { scheduledAt } : {},
    ),
  ) as unknown as ScheduledPost
}
export async function schedulePost(
  orgId: string,
  input: {
    projectId: string
    channelIds: string[]
    caption: string
    scheduledAt: string
    fileId?: string | null
    settings?: PlatformSettings
  },
) {
  return normalizeList(
    await sendJson<any[]>('POST', sched(orgId, '/posts'), input),
  ) as unknown as ScheduledPost[]
}
export async function reschedulePost(orgId: string, postId: string, scheduledAt: string) {
  return normalize(
    await sendJson<any>('PATCH', sched(orgId, `/posts/${postId}`), { scheduledAt }),
  ) as unknown as ScheduledPost
}
export async function postAction(
  orgId: string,
  postId: string,
  action: 'cancel' | 'publish-now' | 'sync',
) {
  return normalize(
    await sendJson<any>('POST', sched(orgId, `/posts/${postId}/${action}`)),
  ) as unknown as ScheduledPost
}
export async function markPostPublished(orgId: string, postId: string, postUrl: string) {
  return normalize(
    await sendJson<any>('POST', sched(orgId, `/posts/${postId}/mark-published`), { postUrl }),
  ) as unknown as ScheduledPost
}

/** ------------------------------------------------------------------- */
/* Fallback to demo mock data when the backend is unavailable */
export interface MockResponse<T> {
  data: T
  fallback: true
}
/* ------------------------------------------------------------------- */
/* Analytics (Phase 2) - /organizations/:orgId/analytics/...           */
export type MetricTotals = {
  views: number
  likes: number
  comments: number
  shares: number
  saves: number
  watchTime: number
}
export interface AnalyticsSummary {
  days: number
  from: string
  to: string
  simulated: boolean
  totals: MetricTotals & {
    engagements: number
    engagementRate: number
    followersGained: number
    posts: number
  }
  change: {
    views: number | null
    engagements: number | null
    engagementRate: number | null
    followersGained: number | null
    watchTime: number | null
  }
  trend: { date: string; views: number; engagements: number }[]
  topContent: {
    projectId: string
    title: string
    client: string
    platforms: PlatformKey[]
    views: number
    engagements: number
    engagementRate: number
  }[]
  platforms: (MetricTotals & {
    platform: PlatformKey
    label: string
    posts: number
    engagementRate: number
    followersGained: number
    followers: number | null
  })[]
  rollups: { client: RollupRow[]; campaign: RollupRow[] }
}
export interface RollupRow {
  name: string
  projects: number
  views: number
  engagements: number
  engagementRate: number
}
export interface Heatmap {
  timezone: string
  posts: number
  simulated: boolean
  cells: { weekday: number; day: string; hour: number; posts: number; engagementRate: number }[]
  byDay: { weekday: number; day: string; posts: number; engagementRate: number }[]
  best: { day: string; hour: number; posts: number; engagementRate: number } | null
}
export interface ProjectPerformance {
  projectId: string
  days: number
  simulated: boolean
  pending: number
  totals: MetricTotals & { engagementRate: number }
  channels: {
    publicationId: string
    platform: PlatformKey
    channel: { _id: string; name: string; handle: string } | null
    postUrl: string
    provider: string
    publishedAt: string
    metrics: MetricTotals
    engagementRate: number
    sparkline: { date: string; views: number }[]
    change: { window: string; views: number | null }
    simulated: boolean
    lastSyncedAt: string | null
  }[]
}
export interface TopPerformers {
  month: string
  label: string
  simulated?: boolean
  items: {
    projectId: string
    title: string
    type: string
    client: string
    publishedAt: string
    platforms: PlatformKey[]
    views: number
    engagementRate: number
    concept: { _id: string; title: string } | null
  }[]
}
export interface PerformanceReport {
  generatedAt: string
  period: { kind: 'project' | 'month'; label: string; month?: string; from: string; to: string }
  client: string
  simulated: boolean
  projects: { _id: string; title: string; client: string; campaign: string; publishedAt: string }[]
  totals: MetricTotals & { engagementRate: number; posts: number }
  platforms: {
    platform: PlatformKey
    label: string
    posts: number
    metrics: MetricTotals
    engagementRate: number
  }[]
  posts: {
    publicationId: string
    project: string
    projectId: string
    platform: PlatformKey
    channel: string
    publishedAt: string
    postUrl: string
    metrics: MetricTotals
    engagementRate: number
    simulated: boolean
  }[]
  highlights: string[]
}
const an = (orgId: string, path: string) => `/organizations/${orgId}/analytics${path}`
export const getAnalyticsSummary = (orgId: string, days: number) =>
  getJson<AnalyticsSummary>(an(orgId, `/summary?days=${days}`))
export const getAnalyticsHeatmap = (orgId: string) => getJson<Heatmap>(an(orgId, '/heatmap'))
export const getTopPerformers = (orgId: string, month?: string) =>
  getJson<TopPerformers>(an(orgId, `/top-performers${month ? `?month=${month}` : ''}`))
export const getProjectPerformance = (orgId: string, projectId: string, days = 30) =>
  getJson<ProjectPerformance>(an(orgId, `/projects/${projectId}/performance?days=${days}`))
export function getPerformanceReport(
  orgId: string,
  q: { projectId?: string; month?: string; client?: string },
) {
  const qs = new URLSearchParams()
  if (q.projectId) qs.set('projectId', q.projectId)
  if (q.month) qs.set('month', q.month)
  if (q.client) qs.set('client', q.client)
  return getJson<PerformanceReport>(an(orgId, `/report?${qs.toString()}`))
}
export const runAnalyticsIngest = (orgId: string) =>
  sendJson<{ posts: number; channels: number; rows: number }>('POST', an(orgId, '/ingest'))

/* Dashboard pipeline (Phase 3) */
export interface BlockedOn {
  kind: 'user' | 'role' | 'client' | 'unassigned' | 'system'
  id?: string
  name: string
  action?: string
}
export interface PipelineData {
  stages: {
    key: 'idea' | 'brief' | 'production' | 'review' | 'publish' | 'live'
    label: string
    count: number
    concepts?: number
    items: {
      _id: string
      title: string
      status: string
      client: string
      updatedAt: string
      publishProgress?: { published: number; total: number }
      failedPosts: number
      blockedOn: BlockedOn | null
    }[]
  }[]
  blocked: {
    kind: BlockedOn['kind']
    name: string
    count: number
    projects: { _id: string; title: string; action: string }[]
  }[]
  goingLiveToday: {
    _id: string
    projectId: string
    title: string
    status: 'scheduled' | 'published' | 'failed'
    at: string
    platform: PlatformKey
    channel: string
    failureReason: string
  }[]
  failedPosts: number
  lastWeekBest: (AnalyticsSummary['topContent'][number] & { simulated: boolean }) | null
  lastWeek: { views: number; engagementRate: number; change: number | null; simulated: boolean }
}
export const getPipeline = (orgId: string) =>
  getJson<PipelineData>(`/organizations/${orgId}/pipeline`)

// ---- Agent platform (Brand Brain). Node proxies the Python agent; the browser never calls it. ----
export interface AgentCitation {
  postId: string
  metric: string
  value: number | string
  note?: string
}
export interface AgentAnswer {
  flow: string
  answer: string
  citations: AgentCitation[]
  dataLimits: string[]
  model?: string
}
export interface AgentPost {
  id: string
  platform: string
  title: string
  format?: string
  durationSec?: number
  metrics: Record<string, number>
}
export interface AgentInsight {
  id: string
  postId: string
  kind: string
  summary: string
  atSecond?: number
  citations: AgentCitation[]
  dataLimits: string[]
  createdAt: string
}

async function agentJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(url, init)
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.error?.message || 'Request failed')
  return body.data as T
}
export const getAgentPosts = (orgId: string) =>
  agentJson<AgentPost[]>(`${API_BASE}/organizations/${orgId}/agent/posts`)
export const getAgentInsights = (orgId: string) =>
  agentJson<AgentInsight[]>(`${API_BASE}/organizations/${orgId}/agent/insights`)
export const enqueueAgentJob = (
  orgId: string,
  postId: string,
  kind: 'analyze' | 'review-digest' | 'transcribe',
) =>
  agentJson<{ jobId: string }>(`${API_BASE}/organizations/${orgId}/agent/posts/${postId}/${kind}`, {
    method: 'POST',
    body: '{}',
  })

/** POST a chat message and stream SSE events (meta/token/answer/error/done) from Node. */
export async function streamAgentChat(
  orgId: string,
  message: string,
  onEvent: (event: string, data: any) => void,
  signal?: AbortSignal,
) {
  const res = await authFetch(`${API_BASE}/organizations/${orgId}/agent/chat`, {
    method: 'POST',
    body: JSON.stringify({ message }),
    signal,
  })
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error?.message || 'Agent unavailable')
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const ev = /^event: (.*)$/m.exec(block)?.[1]
      const data = /^data: (.*)$/m.exec(block)?.[1]
      if (ev) onEvent(ev, data ? JSON.parse(data) : {})
    }
  }
}

/** ------------------------------------------------------------------- */
/* Deals (Approved = Paid). Amounts are minor units from the signed deal and the
 * ledger; no call here sends an amount the UI made up. The one number a person
 * sends (a dispute split) is the one the API proposed, echoed back on a tap. */

const dealsPath = (orgId: string, rest = '') =>
  `/organizations/${encodeURIComponent(orgId)}/deals${rest}`
const dealPath = (orgId: string, dealId: string, rest = '') =>
  dealsPath(orgId, `/${encodeURIComponent(dealId)}${rest}`)
const msPath = (orgId: string, dealId: string, key: string, rest: string) =>
  dealPath(orgId, dealId, `/milestones/${encodeURIComponent(key)}${rest}`)

export async function listDeals(orgId: string): Promise<DealView[]> {
  const d = await getJson<DealView[]>(dealsPath(orgId))
  return Array.isArray(d) ? d : []
}
export function getDeal(orgId: string, dealId: string): Promise<DealView> {
  return getJson<DealView>(dealPath(orgId, dealId))
}
export function getDealLedger(orgId: string, dealId: string): Promise<DealLedgerView> {
  return getJson<DealLedgerView>(dealPath(orgId, dealId, '/ledger'))
}
/** Screenshot URL for a check's evidence frame (served only for files this deal's checks reference). */
export function dealEvidenceUrl(orgId: string, dealId: string, file: string): string {
  return `${API_BASE}${dealPath(orgId, dealId, `/evidence/${encodeURIComponent(file)}`)}`
}
export function signDeal(orgId: string, dealId: string, termsHash: string): Promise<DealView> {
  return sendJson<DealView>('POST', dealPath(orgId, dealId, '/sign'), { termsHash })
}
export function fundMilestone(orgId: string, dealId: string, key: string): Promise<DealView> {
  return sendJson<DealView>('POST', msPath(orgId, dealId, key, '/fund'))
}
export function approveMilestone(orgId: string, dealId: string, key: string, versionId: string): Promise<DealView> {
  return sendJson<DealView>('POST', msPath(orgId, dealId, key, '/approve'), { versionId })
}
export function requestDealChanges(
  orgId: string,
  dealId: string,
  key: string,
  items: { text: string; tag: 'fix' | 'taste'; checklistId?: string; disputed?: boolean }[],
): Promise<DealView> {
  return sendJson<DealView>('POST', msPath(orgId, dealId, key, '/changes'), { items })
}
export function openDealDispute(orgId: string, dealId: string, key: string): Promise<DealView> {
  return sendJson<DealView>('POST', msPath(orgId, dealId, key, '/dispute'))
}
/** Accept the dispute split the API proposed (workerMinor is the proposal's number, never typed). */
export function acceptDealSplit(orgId: string, dealId: string, key: string, workerMinor: number): Promise<DealView> {
  return sendJson<DealView>('POST', msPath(orgId, dealId, key, '/split'), { workerMinor })
}
export function decideChangeOrder(
  orgId: string,
  dealId: string,
  coId: string,
  verb: 'accept' | 'decline',
): Promise<{ deal: DealView; result: { outcome?: string } | null }> {
  return sendJson('POST', dealPath(orgId, dealId, `/change-orders/${encodeURIComponent(coId)}/${verb}`))
}
export function approvePending(orgId: string, dealId: string, approvalKey: string): Promise<{ deal: DealView }> {
  return sendJson('POST', dealPath(orgId, dealId, `/approvals/${encodeURIComponent(approvalKey)}`))
}
/** Nudge the Money Agent (it also runs every minute on its own). */
export function tickDeal(orgId: string, dealId: string): Promise<{ deal: DealView }> {
  return sendJson('POST', dealPath(orgId, dealId, '/tick'))
}
/** Dry-run a proposal through policy. Read-only: nothing moves. */
export function dealPolicyCheck(orgId: string, dealId: string, body: unknown): Promise<any> {
  return sendJson('POST', dealPath(orgId, dealId, '/policy-check'), body)
}
/** A milestone's team as the server would save it (dry run; same rules as the save). */
export type DealTeamPlan = {
  allowed: boolean
  violations: { rule: string; message: string }[]
  milestoneKey: string
  currency: string
  amountMinor: number
  totalBp: number
  clearsSignatures: boolean
  payees: { userId: string; email: string; shareBp: number; displayName?: string; name: string; amountMinor: number }[]
}
export type DealTeamInput = { payees: { userId: string; shareBp: number; label?: string }[] }
export function checkDealTeam(orgId: string, dealId: string, key: string, input: DealTeamInput): Promise<DealTeamPlan> {
  return sendJson('POST', msPath(orgId, dealId, key, '/team/check'), input)
}
/** Client only, unsigned deals only (a signed deal answers 409 deal_locked). Clears signatures. */
export function setDealTeam(orgId: string, dealId: string, key: string, input: DealTeamInput): Promise<DealView> {
  return sendJson('PUT', msPath(orgId, dealId, key, '/team'), input)
}
export type { DealChangeOrder }

/** Live copilot answer from the API (POST .../copilot). `offline` means: use the local replay. */
export type DealCopilotReply =
  | {
      source: 'live'
      actions: { name: string; milestoneKey?: string; changeOrderId?: string }[]
      note: string | null
      provider: string | null
      model: string | null
      cached: boolean
      ms: number
    }
  | { source: 'offline'; reason: string }

/** Ask the live deal copilot. Never throws for "agent off": the API answers { source: 'offline' }. */
export function dealCopilot(orgId: string, dealId: string, question: string): Promise<DealCopilotReply> {
  return sendJson('POST', dealPath(orgId, dealId, '/copilot'), { question })
}

/**
 * One-tap judge login (DEMO_MODE=1 only). Resolves null when the API has no
 * demo (404) so the login page can hide the button; throws on other failures.
 */
export async function demoLogin(): Promise<{ session: Session; dealId: string; organizationId: string | null } | null> {
  const res = await fetch(`${API_BASE}/auth/demo-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    credentials: 'include',
  })
  if (res.status === 404) return null
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.error?.message || `Demo sign-in failed (HTTP ${res.status})`)
  csrfToken = body?.data?.csrfToken ?? readCookie('csrfToken')
  const u = (body?.data?.user ?? {}) as SessionUser & { _id?: string }
  const session: Session = { user: { ...u, id: u.id ?? u._id ?? '' }, loggedInAt: new Date().toISOString() }
  // Profile only (tokens are httpOnly cookies). No storage event here: the
  // caller navigates first, so the login page's redirect cannot race it.
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  } catch {
    /* storage unavailable */
  }
  return {
    session,
    dealId: String(body?.data?.demo?.dealId || 'deal_demo_diwali'),
    organizationId: body?.data?.demo?.organizationId ?? null,
  }
}
/** PayPal return: the buyer approved the hold; ask the API to place the authorization. */
export function confirmDealFunding(orgId: string, dealId: string, key: string): Promise<{ deal: DealView; result: { outcome?: string } }> {
  return sendJson('POST', msPath(orgId, dealId, key, '/fund/confirm'))
}
