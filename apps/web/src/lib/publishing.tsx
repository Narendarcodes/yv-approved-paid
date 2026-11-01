/**
 * Shared bits for the Publish screens (Channels, Compose, Calendar):
 * platform metadata + glyphs, the scheduling status hook, date helpers.
 * yv. brand: ink #171310, teal #035E5E.
 */
import { useCallback, useEffect, useState } from 'react'
import { primaryOrgId } from './data'
import {
  getSchedulingStatus,
  listScheduledPosts,
  listSocialChannels,
  type PlatformKey,
  type ScheduledPost,
  type SchedulingStatus,
  type SocialChannel,
} from '../services/api'

/**
 * Who may connect channels and schedule/cancel posts. Mirrors the backend's
 * project.schedule permission (admins + publishers by default) - stricter than
 * the generic can(viewer, 'schedule') whose frontend role table also lists editors.
 */
export function canPublish(viewer: { role?: string } | null): boolean {
  return viewer?.role === 'admin' || viewer?.role === 'publisher'
}

export const BRAND_INK = '#171310'
export const BRAND_TEAL = '#035E5E'

export const PLATFORMS: Record<PlatformKey, { label: string; hint: string; placeholder: string }> = {
  instagram: { label: 'Instagram', hint: 'Reels, posts and stories', placeholder: 'littlesteps.workshops' },
  youtube: { label: 'YouTube', hint: 'Videos and Shorts', placeholder: 'littlesteps' },
  linkedin: { label: 'LinkedIn', hint: 'Company page posts', placeholder: 'littlesteps-workshops' },
  x: { label: 'X', hint: 'Posts and threads', placeholder: 'littlesteps' },
}
export const PLATFORM_ORDER: PlatformKey[] = ['instagram', 'youtube', 'linkedin', 'x']

/** Monochrome platform glyphs (lucide dropped brand icons). */
export function PlatformGlyph({ platform, size = 16, className = '' }: { platform: string; size?: number; className?: string }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', className, 'aria-hidden': true as const }
  switch (platform) {
    case 'instagram':
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth={1.9}>
          <rect x="3" y="3" width="18" height="18" rx="5" />
          <circle cx="12" cy="12" r="4.2" />
          <circle cx="17.4" cy="6.6" r="1.1" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'youtube':
      return (
        <svg {...common} fill="currentColor">
          <path d="M21.6 7.2a2.7 2.7 0 0 0-1.9-1.9C18 4.8 12 4.8 12 4.8s-6 0-7.7.5A2.7 2.7 0 0 0 2.4 7.2 28 28 0 0 0 2 12a28 28 0 0 0 .4 4.8 2.7 2.7 0 0 0 1.9 1.9c1.7.5 7.7.5 7.7.5s6 0 7.7-.5a2.7 2.7 0 0 0 1.9-1.9A28 28 0 0 0 22 12a28 28 0 0 0-.4-4.8ZM10 15.1V8.9l5.2 3.1L10 15.1Z" />
        </svg>
      )
    case 'linkedin':
      return (
        <svg {...common} fill="currentColor">
          <path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM3 9.75h4v11H3v-11Zm6.5 0h3.8v1.5h.06c.53-1 1.83-2.06 3.77-2.06 4.03 0 4.77 2.65 4.77 6.1v5.46h-4v-4.84c0-1.16-.02-2.64-1.6-2.64-1.62 0-1.86 1.26-1.86 2.56v4.92h-4v-11Z" />
        </svg>
      )
    case 'x':
      return (
        <svg {...common} fill="currentColor">
          <path d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.78L17.75 3Zm-1.08 16.17h1.7L7.4 4.74H5.58l11.09 14.43Z" />
        </svg>
      )
    default:
      return <span className={className}>•</span>
  }
}

/** Resolves the org id once and exposes status + channels with a reload. */
export function usePublishing() {
  const [orgId, setOrgId] = useState<string | null>(null)
  const [status, setStatus] = useState<SchedulingStatus | null>(null)
  const [channels, setChannels] = useState<SocialChannel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setError(null)
    try {
      const id = orgId ?? (await primaryOrgId())
      if (!id) throw new Error('No workspace found for this account')
      setOrgId(id)
      const [s, c] = await Promise.all([getSchedulingStatus(id), listSocialChannels(id)])
      setStatus(s)
      setChannels([...c].sort((a, b) => PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform)))
    } catch (err: any) {
      setError(err?.message || 'Could not load publishing settings')
    } finally {
      setLoading(false)
    }
  }, [orgId])

  useEffect(() => {
    void reload()
  }, [reload])

  return { orgId, status, channels, loading, error, reload }
}

export function usePosts(orgId: string | null, range: { from?: string; to?: string; projectId?: string }) {
  const [posts, setPosts] = useState<ScheduledPost[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { from, to, projectId } = range
  const reload = useCallback(async () => {
    if (!orgId) return
    try {
      setError(null)
      setPosts(await listScheduledPosts(orgId, { from, to, projectId }))
    } catch (err: any) {
      setError(err?.message || 'Could not load posts')
    } finally {
      setLoading(false)
    }
  }, [orgId, from, to, projectId])
  useEffect(() => {
    void reload()
  }, [reload])
  return { posts, loading, error, reload, setPosts }
}

export function postTime(p: ScheduledPost): Date {
  return new Date(p.status === 'published' && p.publishedAt ? p.publishedAt : p.scheduledFor || p.publishedAt || Date.now())
}

export function fmtDateTime(iso?: string | Date | null) {
  if (!iso) return '-'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '-'
  return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}

export function fmtTime(iso?: string | Date | null) {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/** value for <input type="datetime-local"> in local time */
export function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function compact(n?: number) {
  if (n === undefined || n === null) return '-'
  return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

export const POST_STATUS: Record<ScheduledPost['status'], { label: string; tone: 'teal' | 'warning' | 'success' | 'danger' | 'neutral' }> = {
  scheduled: { label: 'Scheduled', tone: 'warning' },
  published: { label: 'Published', tone: 'teal' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
}
