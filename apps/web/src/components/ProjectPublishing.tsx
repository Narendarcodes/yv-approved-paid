/**
 * "Publishing" card on the project page: every post of this project across
 * channels (scheduled / live / failed) with the live link and synced metrics.
 * The project record stays the source of truth; this is its publishing log.
 */
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, Send } from 'lucide-react'
import type { Viewer } from '../lib/viewer'
import { canPublish, compact, fmtDateTime, postTime } from '../lib/publishing'
import { primaryOrgId } from '../lib/data'
import { listScheduledPosts, type ScheduledPost } from '../services/api'
import { StatusChip, PlatformIcon } from './status'

export function ProjectPublishing({
  projectId,
  status,
  viewer,
}: {
  projectId: string
  status: string
  viewer: Viewer
}) {
  const [posts, setPosts] = useState<ScheduledPost[]>([])
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    const orgId = await primaryOrgId().catch(() => null)
    if (!orgId) {
      setLoaded(true)
      return
    }
    try {
      setPosts(await listScheduledPosts(orgId, { projectId }))
    } catch {
      /* card stays empty */
    } finally {
      setLoaded(true)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load, status])

  // refresh while something is waiting to go live
  const pending = posts.some((p) => p.status === 'scheduled')
  useEffect(() => {
    if (!pending) return
    const t = setInterval(() => void load(), 15000)
    return () => clearInterval(t)
  }, [pending, load])

  const canSchedule = canPublish(viewer) && ['APPROVED', 'SCHEDULED'].includes(status)
  if (!loaded) return null
  if (!posts.length && !canSchedule) return null

  return (
    <section className="card p-0" data-testid="project-publishing">
      <header className="card-head justify-between">
        <h2 className="card-title">Publishing</h2>
        {canSchedule && (
          <Link
            to={`/publishing/compose?project=${projectId}`}
            className="btn-secondary !h-8 text-xs"
            data-testid="project-schedule-post"
          >
            <Send size={13} strokeWidth={1.75} /> Schedule post
          </Link>
        )}
      </header>
      <ul className="divide-y divide-line">
        {posts.map((p) => {
          const m = p.metrics || {}
          return (
            <li key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
              <PlatformIcon platform={p.channel?.platform || p.platform.toLowerCase()} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">
                  {p.channel?.name ?? p.platform}
                </p>
                <p className="truncate font-mono text-xs text-umber">
                  {p.status === 'published'
                    ? 'Live '
                    : p.status === 'scheduled'
                      ? 'Goes live '
                      : ''}
                  {fmtDateTime(postTime(p))}
                  {m.views !== undefined
                    ? ` · ${compact(m.views)} views · ${compact(m.likes)} likes${p.metricsSimulated ? ' (sim.)' : ''}`
                    : ''}
                </p>
              </div>
              {p.postUrl && (
                <a
                  href={p.postUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="icon-btn icon-btn-sm"
                  aria-label="Open live post"
                  title={p.postUrl}
                >
                  <ExternalLink size={14} strokeWidth={1.75} />
                </a>
              )}
              <StatusChip status={p.status} />
            </li>
          )
        })}
        {!posts.length && (
          <li className="px-5 py-6 text-center text-sm text-umber">
            Approved and ready - schedule it to your channels.
          </li>
        )}
      </ul>
      {posts.length > 0 && (
        <footer className="border-t border-line px-5 py-2.5 text-right">
          <Link to="/publishing/calendar" className="text-xs font-medium text-teal hover:underline">
            Open publishing calendar
          </Link>
        </footer>
      )}
    </section>
  )
}
