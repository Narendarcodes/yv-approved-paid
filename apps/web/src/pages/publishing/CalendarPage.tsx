import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  CalendarDays,
  CalendarRange,
  Film,
  GripVertical,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  PenLine,
  RefreshCw,
  Send,
  XCircle,
  Clock,
  BarChart3,
  Link2,
  RotateCcw,
  AlertTriangle,
} from 'lucide-react'
import Chip, { Modal, EmptyState } from '../../components/primitives'
import { PageHeader } from '../../components/ui'
import { ErrorBanner } from '../../components/states'
import { useToast } from '../../components/toast'
import { useViewer } from '../../lib/viewer'
import { invalidateProjectData } from '../../lib/data'
import {
  PLATFORMS,
  POST_STATUS,
  PlatformGlyph,
  compact,
  fmtDateTime,
  fmtTime,
  postTime,
  toLocalInput,
  usePosts,
  usePublishing,
  canPublish,
} from '../../lib/publishing'
import {
  markPostPublished,
  postAction,
  reschedulePost,
  retryPost,
  versionFileUrl,
  type ScheduledPost,
} from '../../services/api'
import { StatusChip, StatusDot, PlatformIcon, stageOf } from '../../components/status'

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function startOfGrid(month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const offset = (first.getDay() + 6) % 7 // Monday first
  return new Date(first.getFullYear(), first.getMonth(), 1 - offset)
}
function startOfWeek(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)) // Monday
  return x
}
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate()

function pillClass(status: ScheduledPost['status']) {
  if (status === 'published') return 'bg-st-live-bg text-st-live ring-1 ring-st-live/25'
  if (status === 'failed') return 'bg-st-failed-bg text-st-failed ring-1 ring-st-failed/30'
  return 'bg-surface text-st-scheduled ring-1 ring-st-scheduled/40'
}

export default function CalendarPage() {
  const toast = useToast()
  const viewer = useViewer()
  const canManage = canPublish(viewer)
  const [params, setParams] = useSearchParams()
  const [month, setMonth] = useState(() => {
    const m = params.get('month')
    if (m) {
      const [y, mm] = m.split('-').map(Number)
      if (y && mm) return new Date(y, mm - 1, 1)
    }
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const [view, setView] = useState<'month' | 'week'>(() =>
    params.get('view') === 'week' ? 'week' : 'month',
  )
  const [week, setWeek] = useState(() => {
    const w = params.get('week')
    const d = w ? new Date(`${w}T00:00:00`) : new Date()
    return startOfWeek(isNaN(d.getTime()) ? new Date() : d)
  })
  const projectFilter = params.get('project') || undefined
  const gridStart = useMemo(() => startOfGrid(month), [month])
  const gridEnd = useMemo(
    () => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + 42),
    [gridStart],
  )
  const weekEnd = useMemo(
    () => new Date(week.getFullYear(), week.getMonth(), week.getDate() + 7),
    [week],
  )
  const range =
    view === 'week'
      ? { from: week.toISOString(), to: weekEnd.toISOString() }
      : { from: gridStart.toISOString(), to: gridEnd.toISOString() }
  const { orgId, status, channels, error: pubError } = usePublishing()
  const { posts: allPosts, loading: postsLoading, error, reload, setPosts } = usePosts(orgId, range)
  const posts = projectFilter ? allPosts.filter((p) => p.projectId === projectFilter) : allPosts
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropDay, setDropDay] = useState<string | null>(null)

  const switchView = (v: 'month' | 'week') => {
    setView(v)
    const next = new URLSearchParams(params)
    next.set('view', v)
    if (v === 'week') next.set('week', ymd(week))
    setParams(next, { replace: true })
  }
  const goWeek = (delta: number) => {
    const next = new Date(week.getFullYear(), week.getMonth(), week.getDate() + delta * 7)
    setWeek(next)
    const q = new URLSearchParams(params)
    q.set('view', 'week')
    q.set('week', ymd(next))
    setParams(q, { replace: true })
  }

  /** Drag a scheduled post onto another day: same time of day, new date. */
  const dropOn = async (day: Date) => {
    const post = posts.find((p) => p.id === dragId)
    setDragId(null)
    setDropDay(null)
    if (!post || !orgId || post.status !== 'scheduled' || !post.scheduledFor) return
    const old = new Date(post.scheduledFor)
    const when = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      old.getHours(),
      old.getMinutes(),
    )
    if (sameDay(old, when)) return
    if (when.getTime() < Date.now()) {
      toast('danger', 'Cannot move into the past', 'Pick today or a later day')
      return
    }
    // optimistic move, then confirm with the server
    setPosts((list) =>
      list.map((p) => (p.id === post.id ? { ...p, scheduledFor: when.toISOString() } : p)),
    )
    try {
      await reschedulePost(orgId, post.id, when.toISOString())
      toast('success', 'Post moved', `${post.project?.title ?? 'Post'} · ${fmtDateTime(when)}`)
      invalidateProjectData(post.projectId)
    } catch (err: any) {
      toast('danger', 'Could not move the post', err?.message)
    } finally {
      await reload()
    }
  }
  const [openId, setOpenId] = useState<string | null>(null)
  const open = posts.find((p) => p.id === openId) || null

  // keep the calendar live so scheduled posts flip to Published on screen
  useEffect(() => {
    const t = setInterval(() => void reload(), 10000)
    return () => clearInterval(t)
  }, [reload])

  const go = (delta: number) => {
    const next = new Date(month.getFullYear(), month.getMonth() + delta, 1)
    setMonth(next)
    setParams({ month: `${next.getFullYear()}-${next.getMonth() + 1}` }, { replace: true })
  }
  const today = new Date()
  const days = Array.from(
    { length: 42 },
    (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i),
  )
  const byDay = (d: Date) =>
    posts
      .filter((p) => sameDay(postTime(p), d))
      .sort((a, b) => postTime(a).getTime() - postTime(b).getTime())

  const upcoming = posts
    .filter((p) => p.status === 'scheduled')
    .sort((a, b) => postTime(a).getTime() - postTime(b).getTime())
  const published = posts
    .filter((p) => p.status === 'published')
    .sort((a, b) => postTime(b).getTime() - postTime(a).getTime())
  const failed = posts.filter((p) => p.status === 'failed')

  return (
    <div className="fade-in space-y-6">
      <PageHeader
        title="Publishing calendar"
        actions={
          <>
            <Link to="/publishing/channels" className="btn-secondary">
              Channels <span className="font-mono text-[11px] text-umber">{channels.length}</span>
            </Link>
            {canManage && (
              <Link to="/publishing/compose" className="btn-primary" data-testid="calendar-compose">
                <Send size={14} strokeWidth={1.75} /> Schedule post
              </Link>
            )}
          </>
        }
      />
      {(error || pubError) && (
        <ErrorBanner message={error || pubError || ''} onRetry={() => void reload()} />
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px] [&>*]:min-w-0">
        <section className="card overflow-hidden p-0" data-testid="calendar-grid">
          <header className="card-head flex-wrap gap-y-2 py-2.5">
            <h2 className="card-title whitespace-nowrap !text-base">
              {view === 'week'
                ? `${week.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${new Date(weekEnd.getTime() - 86400000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
                : month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
            </h2>
            <div className="seg ml-2" role="group" aria-label="Calendar view">
              <button
                className="flex items-center gap-1"
                onClick={() => switchView('month')}
                aria-pressed={view === 'month'}
                data-testid="view-month"
              >
                <CalendarDays size={13} strokeWidth={1.75} /> Month
              </button>
              <button
                className="flex items-center gap-1"
                onClick={() => switchView('week')}
                aria-pressed={view === 'week'}
                data-testid="view-week"
              >
                <CalendarRange size={13} strokeWidth={1.75} /> Week
              </button>
            </div>
            {status && (
              <Chip
                label={status.mode === 'postiz' ? 'Postiz' : 'Demo scheduler'}
                tone={status.mode === 'postiz' ? 'teal' : 'warning'}
              />
            )}
            <div className="ml-auto flex items-center gap-1">
              <button
                className="icon-btn icon-btn-sm"
                onClick={() => (view === 'week' ? goWeek(-1) : go(-1))}
                aria-label={view === 'week' ? 'Previous week' : 'Previous month'}
              >
                <ChevronLeft size={16} strokeWidth={1.75} />
              </button>
              <button
                className="btn-ghost !h-8 text-xs"
                onClick={() => {
                  if (view === 'week') {
                    setWeek(startOfWeek(new Date()))
                    setParams({ view: 'week' }, { replace: true })
                    return
                  }
                  const d = new Date(today.getFullYear(), today.getMonth(), 1)
                  setMonth(d)
                  setParams({}, { replace: true })
                }}
              >
                Today
              </button>
              <button
                className="icon-btn icon-btn-sm"
                onClick={() => (view === 'week' ? goWeek(1) : go(1))}
                aria-label={view === 'week' ? 'Next week' : 'Next month'}
              >
                <ChevronRight size={16} strokeWidth={1.75} />
              </button>
            </div>
          </header>
          <div
            className={`h-0.5 ${postsLoading ? 'skeleton !rounded-none' : ''}`}
            aria-hidden="true"
          />
          {view === 'week' ? (
            <div className="relative overflow-x-auto">
              <div className="min-w-[700px]">
                <WeekGrid
                  week={week}
                  posts={posts}
                  today={today}
                  canManage={canManage}
                  dragId={dragId}
                  dropDay={dropDay}
                  onOpen={setOpenId}
                  onDragStart={setDragId}
                  onDragOverDay={setDropDay}
                  onDrop={(d) => void dropOn(d)}
                />
              </div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-7 border-b border-line bg-canvas/60">
                {WEEKDAYS.map((w) => (
                  <div key={w} className="micro-label px-2 py-2 text-center">
                    {w}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7">
                {days.map((d, i) => {
                  const list = byDay(d)
                  const inMonth = d.getMonth() === month.getMonth()
                  const isToday = sameDay(d, today)
                  return (
                    <div
                      key={i}
                      className={`min-h-[104px] border-b border-r border-line p-1.5 ${i % 7 === 6 ? 'border-r-0' : ''} ${inMonth ? '' : 'bg-canvas/50'}`}
                      data-testid={isToday ? 'calendar-today' : undefined}
                    >
                      <div className="mb-1 flex justify-end">
                        <span
                          className={`flex h-6 min-w-6 items-center justify-center rounded-full px-1 font-mono text-[11px] ${
                            isToday
                              ? 'bg-[#171310] text-white'
                              : inMonth
                                ? 'text-ink'
                                : 'text-label'
                          }`}
                        >
                          {d.getDate()}
                        </span>
                      </div>
                      <div className="space-y-1">
                        {list.slice(0, 3).map((p) => (
                          <button
                            key={p.id}
                            onClick={() => setOpenId(p.id)}
                            className={`block w-full rounded-md px-1.5 py-1 text-left text-[11px] leading-tight transition-opacity hover:opacity-85 ${pillClass(p.status)}`}
                            data-testid="calendar-post"
                            data-status={p.status}
                            title={`${p.project?.title ?? ''} · ${p.channel?.name ?? p.platform}`}
                          >
                            <span className="flex items-center gap-1 font-mono text-[10px] opacity-90">
                              <PlatformGlyph
                                platform={p.channel?.platform || p.platform.toLowerCase()}
                                size={10}
                                className="shrink-0"
                              />
                              {fmtTime(postTime(p))}
                            </span>
                            <span className="mt-0.5 block truncate font-medium">
                              {p.project?.title}
                            </span>
                          </button>
                        ))}
                        {list.length > 3 && (
                          <p className="px-1 font-mono text-[10px] text-umber">
                            +{list.length - 3} more
                          </p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
          <footer className="flex flex-wrap items-center gap-4 border-t border-line px-5 py-3 text-xs text-umber">
            <span className="flex items-center gap-1.5">
              <StatusDot stage="scheduled" className="!h-2 !w-2" /> Scheduled
            </span>
            <span className="flex items-center gap-1.5">
              <StatusDot stage="live" className="!h-2 !w-2" /> Published
            </span>
            <span className="flex items-center gap-1.5">
              <StatusDot stage="failed" className="!h-2 !w-2" /> Failed
            </span>
            {view === 'week' && canManage && (
              <span className="ml-auto flex items-center gap-1">
                <GripVertical size={12} /> Drag a scheduled post to another day to reschedule
              </span>
            )}
            {projectFilter && (
              <button
                className="ml-auto text-xs font-medium text-teal hover:underline"
                onClick={() => {
                  const q = new URLSearchParams(params)
                  q.delete('project')
                  setParams(q, { replace: true })
                }}
              >
                Showing one project · show all
              </button>
            )}
          </footer>
        </section>

        <aside className="space-y-4">
          <SideList
            title="Up next"
            empty="Nothing scheduled this month."
            posts={upcoming}
            onOpen={setOpenId}
            testId="upcoming-list"
          />
          {failed.length > 0 && (
            <SideList
              title="Needs attention"
              empty=""
              posts={failed}
              onOpen={setOpenId}
              testId="failed-list"
            />
          )}
          <SideList
            title="Recently published"
            empty="No posts live yet."
            posts={published.slice(0, 6)}
            onOpen={setOpenId}
            showMetrics
            testId="published-list"
          />
        </aside>
      </div>

      {!posts.length && !error && (
        <EmptyState
          icon={<Clock size={22} strokeWidth={1.5} />}
          title={
            view === 'week'
              ? 'Nothing on the calendar this week'
              : 'Nothing on the calendar this month'
          }
          description="Next step: schedule an approved project from the composer - it shows up here and goes live on time."
          action={
            canManage ? (
              <Link to="/publishing/compose" className="btn-primary">
                Schedule a post
              </Link>
            ) : undefined
          }
        />
      )}

      <PostModal
        post={open}
        orgId={orgId}
        canManage={canManage}
        onClose={() => setOpenId(null)}
        onChanged={async (msg, projectId) => {
          if (msg) toast('success', msg)
          if (projectId) invalidateProjectData(projectId)
          await reload()
        }}
        onError={(title, err) => toast('danger', title, err?.message)}
      />
    </div>
  )
}

function Thumb({ post }: { post: ScheduledPost }) {
  const [failed, setFailed] = useState(false)
  const platform = post.channel?.platform || post.platform.toLowerCase()
  const src =
    post.versionId && post.fileId
      ? versionFileUrl(post.projectId, String(post.versionId), String(post.fileId))
      : null
  const kind = post.file?.mimeType
  return (
    <span className="relative block h-14 w-full overflow-hidden rounded-md bg-cream">
      {src && !failed ? (
        kind?.startsWith('video/') ? (
          <video
            src={`${src}#t=1`}
            muted
            preload="metadata"
            className="h-full w-full object-cover"
            onError={() => setFailed(true)}
          />
        ) : (
          <img
            src={src}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
            onError={() => setFailed(true)}
          />
        )
      ) : (
        <span className="flex h-full items-center justify-center text-umber">
          <Film size={16} strokeWidth={1.5} />
        </span>
      )}
      <span className="absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded bg-[#171310] text-white">
        <PlatformGlyph platform={platform} size={11} />
      </span>
    </span>
  )
}

function WeekGrid({
  week,
  posts,
  today,
  canManage,
  dragId,
  dropDay,
  onOpen,
  onDragStart,
  onDragOverDay,
  onDrop,
}: {
  week: Date
  posts: ScheduledPost[]
  today: Date
  canManage: boolean
  dragId: string | null
  dropDay: string | null
  onOpen: (id: string) => void
  onDragStart: (id: string | null) => void
  onDragOverDay: (key: string | null) => void
  onDrop: (day: Date) => void
}) {
  const days = Array.from(
    { length: 7 },
    (_, i) => new Date(week.getFullYear(), week.getMonth(), week.getDate() + i),
  )
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  return (
    <div className="grid grid-cols-7 divide-x divide-line" data-testid="week-grid">
      {days.map((d) => {
        const key = ymd(d)
        const list = posts
          .filter((p) => sameDay(postTime(p), d))
          .sort((a, b) => postTime(a).getTime() - postTime(b).getTime())
        const past = d < startToday
        const isToday = sameDay(d, today)
        return (
          <div
            key={key}
            className={`min-h-[420px] p-2 transition-colors ${dropDay === key && dragId ? (past ? 'bg-danger/5' : 'bg-tint') : ''} ${past ? 'bg-canvas/50' : ''}`}
            onDragOver={(e) => {
              if (!dragId) return
              e.preventDefault()
              if (dropDay !== key) onDragOverDay(key)
            }}
            onDragLeave={() => dropDay === key && onDragOverDay(null)}
            onDrop={(e) => {
              e.preventDefault()
              onDrop(d)
            }}
            data-testid={`week-day-${key}`}
          >
            <div className="mb-2 flex items-baseline justify-between">
              <span className="micro-label">
                {d.toLocaleDateString(undefined, { weekday: 'short' })}
              </span>
              <span
                className={`flex h-6 min-w-6 items-center justify-center rounded-full px-1 font-mono text-xs ${isToday ? 'bg-[#171310] text-white' : 'text-ink'}`}
              >
                {d.getDate()}
              </span>
            </div>
            <div className="space-y-2">
              {list.map((p) => {
                const movable = canManage && p.status === 'scheduled'
                return (
                  <button
                    key={p.id}
                    draggable={movable}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', p.id)
                      e.dataTransfer.effectAllowed = 'move'
                      onDragStart(p.id)
                    }}
                    onDragEnd={() => {
                      onDragStart(null)
                      onDragOverDay(null)
                    }}
                    onClick={() => onOpen(p.id)}
                    className={`block w-full overflow-hidden rounded-lg border text-left transition-shadow hover:border-line-strong hover:shadow-card-hover ${
                      p.status === 'failed'
                        ? 'border-st-failed/40'
                        : p.status === 'published'
                          ? 'border-st-live/30'
                          : 'border-line'
                    } ${movable ? 'cursor-grab active:cursor-grabbing' : ''} ${dragId === p.id ? 'opacity-50' : ''}`}
                    data-testid="week-post"
                    data-status={p.status}
                    title={movable ? 'Drag to another day to reschedule' : undefined}
                  >
                    <Thumb post={p} />
                    <span className="block px-2 py-1.5">
                      <span
                        className="flex items-center gap-1.5 whitespace-nowrap font-mono text-[11px] text-umber"
                        title={POST_STATUS[p.status].label}
                      >
                        <StatusDot stage={stageOf(p.status)} className="!h-2 !w-2" />
                        {fmtTime(postTime(p))}
                        <span className="sr-only">{POST_STATUS[p.status].label}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs font-medium text-ink">
                        {p.project?.title}
                      </span>
                    </span>
                  </button>
                )
              })}
              {!list.length && (
                <p className="pt-4 text-center text-[11px] text-label">{past ? '' : '—'}</p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function SideList({
  title,
  posts,
  empty,
  onOpen,
  showMetrics,
  testId,
}: {
  title: string
  posts: ScheduledPost[]
  empty: string
  onOpen: (id: string) => void
  showMetrics?: boolean
  testId: string
}) {
  return (
    <section className="card p-0" data-testid={testId}>
      <header className="flex items-center justify-between border-b border-line px-4 py-3">
        <h3 className="font-headline text-sm font-semibold tracking-tight text-[#171310]">
          {title}
        </h3>
        <span className="font-mono text-[11px] text-label">{posts.length}</span>
      </header>
      <ul className="divide-y divide-line">
        {posts.map((p) => (
          <li key={p.id}>
            <button
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-ink/[0.03]"
              onClick={() => onOpen(p.id)}
            >
              <PlatformIcon platform={p.channel?.platform || p.platform.toLowerCase()} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">
                  {p.project?.title}
                </span>
                <span className="block truncate font-mono text-[10.5px] text-umber">
                  {fmtDateTime(postTime(p))}
                  {showMetrics && p.metrics?.views !== undefined
                    ? ` · ${compact(p.metrics.views)} views`
                    : ''}
                </span>
              </span>
              <StatusChip status={p.status} />
            </button>
          </li>
        ))}
        {!posts.length && <li className="px-4 py-6 text-center text-xs text-umber">{empty}</li>}
      </ul>
    </section>
  )
}

function PostModal({
  post,
  orgId,
  canManage,
  onClose,
  onChanged,
  onError,
}: {
  post: ScheduledPost | null
  orgId: string | null
  canManage: boolean
  onClose: () => void
  onChanged: (msg: string, projectId?: string) => Promise<void>
  onError: (title: string, err: any) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [when, setWhen] = useState('')
  const [url, setUrl] = useState('')
  const [mode, setMode] = useState<'view' | 'reschedule' | 'manual'>('view')

  useEffect(() => {
    setMode('view')
    setUrl('')
    setWhen(post?.scheduledFor ? toLocalInput(new Date(post.scheduledFor)) : '')
  }, [post?.id, post?.scheduledFor])

  if (!post)
    return (
      <Modal open={false} onClose={onClose} title="">
        {null}
      </Modal>
    )

  const run = async (key: string, fn: () => Promise<unknown>, msg: string) => {
    if (!orgId) return
    setBusy(key)
    try {
      await fn()
      setMode('view')
      await onChanged(msg, post.projectId)
    } catch (err) {
      onError('Action failed', err)
    } finally {
      setBusy(null)
    }
  }

  const platform = post.channel?.platform || post.platform.toLowerCase()
  const metrics = Object.entries(post.metrics || {})

  return (
    <Modal
      open={!!post}
      onClose={onClose}
      title={post.status === 'scheduled' ? 'Scheduled post' : 'Post details'}
      width="max-w-xl"
    >
      <div className="space-y-4" data-testid="post-modal">
        <div className="flex items-start gap-3">
          <PlatformIcon platform={platform} size="lg" />
          <div className="min-w-0 flex-1">
            <Link
              to={`/projects/${post.projectId}`}
              className="block truncate font-headline text-base font-semibold text-[#171310] hover:text-[#035E5E]"
            >
              {post.project?.title}
            </Link>
            <p className="truncate text-xs text-umber">
              {post.channel?.name ?? post.platform} ·{' '}
              {PLATFORMS[platform as keyof typeof PLATFORMS]?.label ?? post.platform} ·{' '}
              {post.provider === 'postiz'
                ? 'via Postiz'
                : post.provider === 'local'
                  ? 'demo scheduler'
                  : 'recorded manually'}
            </p>
          </div>
          <StatusChip status={post.status} />
        </div>

        <dl className="grid grid-cols-2 gap-3 rounded-[10px] bg-canvas/70 p-3 text-sm">
          <div>
            <dt className="micro-label">
              {post.status === 'published' ? 'Published' : 'Goes live'}
            </dt>
            <dd className="mt-0.5 text-ink">{fmtDateTime(postTime(post))}</dd>
          </div>
          <div>
            <dt className="micro-label">Project status</dt>
            <dd className="mt-0.5 text-ink">
              {post.project?.status
                ? post.project.status.charAt(0) + post.project.status.slice(1).toLowerCase()
                : '-'}
            </dd>
          </div>
        </dl>

        {post.caption && (
          <p className="whitespace-pre-wrap rounded-[10px] border border-line p-3 text-sm leading-relaxed text-ink/85">
            {post.caption}
          </p>
        )}

        {post.status === 'failed' && (
          <div
            className="flex items-start gap-2 rounded-[10px] bg-danger/10 px-3 py-2 text-sm text-danger"
            data-testid="post-failure"
          >
            <AlertTriangle size={15} strokeWidth={2} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">Did not publish</p>
              <p>{post.failureReason || 'The platform rejected this post.'}</p>
              {!!post.retryCount && (
                <p className="mt-0.5 text-xs opacity-80">Retried {post.retryCount}×</p>
              )}
            </div>
          </div>
        )}

        {post.postUrl && (
          <a
            href={post.postUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 truncate text-sm font-medium text-[#035E5E] hover:underline"
            data-testid="post-url"
          >
            <ExternalLink size={14} strokeWidth={1.75} />{' '}
            <span className="truncate">{post.postUrl}</span>
            {post.provider === 'local' && <Chip label="Demo link" tone="warning" />}
          </a>
        )}

        {post.status === 'published' && (
          <div data-testid="post-metrics">
            <div className="mb-2 flex items-center justify-between">
              <p className="micro-label">
                Metrics {post.metricsSimulated ? '(simulated in demo mode)' : ''}
              </p>
              {post.lastSyncedAt && (
                <p className="font-mono text-[10px] text-label">
                  synced {fmtTime(post.lastSyncedAt)}
                </p>
              )}
            </div>
            {metrics.length ? (
              <div className="grid grid-cols-4 gap-2">
                {metrics.map(([k, v]) => (
                  <div key={k} className="rounded-[10px] border border-line px-3 py-2">
                    <p className="font-headline text-lg font-semibold text-[#171310]">
                      {compact(v)}
                    </p>
                    <p className="text-[11px] capitalize text-umber">{k}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-umber">
                {post.provider === 'manual'
                  ? 'Recorded by hand - add metrics on the project.'
                  : 'No metrics yet.'}
              </p>
            )}
          </div>
        )}

        {mode === 'reschedule' && (
          <div className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line p-3">
            <input
              type="datetime-local"
              className="input w-auto"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              aria-label="New date and time"
            />
            <button
              className="btn-primary"
              disabled={!!busy || !when}
              onClick={() =>
                void run(
                  'move',
                  () => reschedulePost(orgId!, post.id, new Date(when).toISOString()),
                  'Post moved',
                )
              }
            >
              Save time
            </button>
            <button className="btn-ghost" onClick={() => setMode('view')}>
              Back
            </button>
          </div>
        )}
        {mode === 'manual' && (
          <div className="space-y-2 rounded-[10px] border border-line p-3">
            <p className="text-xs text-umber">Paste the live link</p>
            <div className="flex gap-2">
              <input
                className="input flex-1"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://www.instagram.com/p/…"
                data-testid="manual-url"
              />
              <button
                className="btn-primary"
                disabled={!!busy || !/^https?:\/\/\S+$/.test(url.trim())}
                onClick={() =>
                  void run(
                    'manual',
                    () => markPostPublished(orgId!, post.id, url.trim()),
                    'Marked as published',
                  )
                }
                data-testid="manual-submit"
              >
                Save link
              </button>
            </div>
          </div>
        )}

        {canManage && mode === 'view' && (
          <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
            {post.status === 'scheduled' && (
              <>
                <button
                  className="btn-ghost text-danger"
                  disabled={!!busy}
                  onClick={() =>
                    void run(
                      'cancel',
                      () => postAction(orgId!, post.id, 'cancel'),
                      'Post cancelled',
                    )
                  }
                  data-testid="post-cancel"
                >
                  <XCircle size={14} strokeWidth={1.75} /> Cancel post
                </button>
                <button
                  className="btn-secondary"
                  disabled={!!busy}
                  onClick={() => setMode('reschedule')}
                >
                  <Clock size={14} strokeWidth={1.75} /> Reschedule
                </button>
              </>
            )}
            {post.status === 'failed' && (
              <>
                <button
                  className="btn-ghost text-danger"
                  disabled={!!busy}
                  onClick={() =>
                    void run(
                      'cancel',
                      () => postAction(orgId!, post.id, 'cancel'),
                      'Post discarded',
                    )
                  }
                  data-testid="post-discard"
                >
                  <XCircle size={14} strokeWidth={1.75} /> Discard
                </button>
                <button
                  className="btn-secondary"
                  disabled={!!busy}
                  onClick={() => setMode('manual')}
                >
                  <Link2 size={14} strokeWidth={1.75} /> Posted by hand
                </button>
                <button
                  className="btn-primary"
                  disabled={!!busy}
                  onClick={() =>
                    void run(
                      'retry',
                      () => retryPost(orgId!, post.id),
                      'Retrying - post queued again',
                    )
                  }
                  data-testid="post-retry"
                >
                  <RotateCcw size={14} strokeWidth={1.75} />{' '}
                  {busy === 'retry' ? 'Retrying…' : 'Retry'}
                </button>
              </>
            )}
            {post.status === 'scheduled' && (
              <>
                <button
                  className="btn-secondary"
                  disabled={!!busy}
                  onClick={() => setMode('manual')}
                  data-testid="post-manual"
                >
                  <Link2 size={14} strokeWidth={1.75} /> Mark published
                </button>
                <button
                  className="btn-primary"
                  disabled={!!busy}
                  onClick={() =>
                    void run('now', () => postAction(orgId!, post.id, 'publish-now'), 'Published')
                  }
                  data-testid="post-publish-now"
                >
                  <Send size={14} strokeWidth={1.75} />{' '}
                  {busy === 'now' ? 'Publishing…' : 'Publish now'}
                </button>
              </>
            )}
            {post.status === 'published' && post.provider !== 'manual' && (
              <button
                className="btn-secondary"
                disabled={!!busy}
                onClick={() =>
                  void run('sync', () => postAction(orgId!, post.id, 'sync'), 'Metrics synced')
                }
                data-testid="post-sync"
              >
                <RefreshCw size={14} strokeWidth={1.75} /> Sync metrics
              </button>
            )}
            {post.status === 'published' && post.provider === 'manual' && (
              <button className="btn-secondary" onClick={() => setMode('manual')}>
                <PenLine size={14} strokeWidth={1.75} /> Edit link
              </button>
            )}
            <Link to={`/projects/${post.projectId}`} className="btn-ghost">
              <BarChart3 size={14} strokeWidth={1.75} /> Open project
            </Link>
          </div>
        )}
      </div>
    </Modal>
  )
}
