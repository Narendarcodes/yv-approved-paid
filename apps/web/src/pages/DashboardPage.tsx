import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  ArrowRight,
  BadgeCheck,
  Clapperboard,
  Eye,
  Inbox,
  Megaphone,
  MessageSquare,
} from 'lucide-react'
import Chip from '../components/primitives'
import { AssigneeAvatar } from '../components/ui'
import { ErrorBanner } from '../components/states'
import {
  GoingLive,
  LastWeekBest,
  PipelineOverview,
  PipelineSkeleton,
  StageStrip,
  WaitingOn,
  usePipeline,
  type ScheduledRow,
} from '../components/PipelineOverview'
import {
  AttentionStrip,
  useMoneyBoard,
  type MoneyBoard,
} from '../components/dashboard/AttentionStrip'
import { DashSection } from '../components/dashboard/Section'
import { awaitingReview, isOverdue } from '../lib/attention'
import { money } from '../lib/deals'
import { type Project } from '../lib/types'
import { projectStatusLabel, statusLabel } from '../lib/format'
import { useViewer } from '../lib/viewer'
import { useTeam, useProjects, primaryOrgId } from '../lib/data'
import { listOrgActivity, listScheduledPosts, type ScheduledPost } from '../services/api'
import { Skeleton } from '../components/states'
import Avatar from '../components/ui'
import { useEffect, useState } from 'react'
import { StatusChip, PlatformIcons } from '../components/status'
import { initialsOf } from '../lib/initials'
import { PAGE_LINE, EMPTY_LINE, DASH_LINE, DASH_EMPTY } from '../lib/copy'

const iconProps = { size: 18, strokeWidth: 1.75 }

// Shared team reference so module-level components (ProjectRow, WorkCard,
// ActivityCard) can resolve member ids even though the team is loaded async.
let teamRef: ReturnType<typeof useTeam>['team'] = []
export function setTeamRef(t: typeof teamRef) {
  teamRef = t
}
const memberOf = (id: string) => teamRef.find((m) => m.id === id)

const REVIEW = [
  'FIRST_DRAFT_SUBMITTED',
  'UNDER_REVIEW',
  'REVISION_SUBMITTED',
  'REVISION_IN_PROGRESS',
]
const inReview = (p: Project) => REVIEW.includes(p.status)

function CardHeader({
  title,
  to,
  action,
  icon,
  meta,
}: {
  title: string
  to?: string
  action?: string
  icon?: ReactNode
  meta?: ReactNode
}) {
  return (
    <header className="card-head">
      {icon && (
        <span className="text-umber" aria-hidden="true">
          {icon}
        </span>
      )}
      <h2 className="card-title">{title}</h2>
      {meta}
      {to ? (
        <Link to={to} className="card-link group ml-auto">
          {action ?? 'View all'}
          <ArrowRight
            size={13}
            strokeWidth={2}
            className="transition-transform group-hover:translate-x-0.5"
          />
        </Link>
      ) : null}
    </header>
  )
}

function ProjectRow({ p, icon }: { p: Project; icon: ReactNode }) {
  const assignee = memberOf(p.assignee)
  return (
    <li>
      <Link to={`/projects/${p.id}`} className="row-link group flex items-center gap-3.5 px-5 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-ink/[0.04] text-umber transition-colors group-hover:bg-tint group-hover:text-teal">
          {icon}
        </span>
        <p className="min-w-0 flex-1 truncate text-sm text-ink">{p.title}</p>
        <span className="hidden truncate text-[13px] text-umber sm:inline">
          {assignee?.name ?? 'Unassigned'}
        </span>
        <StatusChip status={p.status} label={projectStatusLabel(p)} />
        <ArrowRight
          size={15}
          strokeWidth={1.75}
          className="text-umber opacity-0 transition-[transform,opacity] group-hover:translate-x-0.5 group-hover:opacity-100"
        />
      </Link>
    </li>
  )
}

function ProjectListCard({
  title,
  to,
  action,
  icon,
  items,
  empty,
  className,
}: {
  title: string
  to?: string
  action?: string
  icon: ReactNode
  items: Project[]
  empty?: string
  className?: string
}) {
  return (
    <div className={`card flex flex-col overflow-hidden ${className ?? ''}`}>
      <CardHeader
        title={title}
        to={to}
        action={action}
        meta={
          items.length ? <span className="font-mono text-xs text-label">{items.length}</span> : null
        }
      />
      {items.length ? (
        <ul className="divide-y divide-line">
          {items.map((p) => (
            <ProjectRow key={p.id} p={p} icon={icon} />
          ))}
        </ul>
      ) : (
        <InlineEmpty text={empty ?? 'Nothing here yet.'} />
      )}
    </div>
  )
}

/** Quiet in-card empty state: centred, fills the card so side-by-side cards stay balanced. */
function InlineEmpty({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5 py-10 text-center">
      <span className="h-1.5 w-8 rounded-full bg-line-strong" aria-hidden="true" />
      <p className="t-meta max-w-[28ch]">{text}</p>
      {action}
    </div>
  )
}

function WorkCard({ p }: { p: Project }) {
  return (
    <Link to={`/projects/${p.id}`} className="card card-hover p-5">
      <div className="mb-3 flex items-center justify-between">
        <span className="micro-label">{p.type}</span>
        <StatusChip status={p.status} label={projectStatusLabel(p)} />
      </div>
      <h3 className="font-headline text-[15px] font-semibold leading-snug tracking-[-0.01em] text-ink">
        {p.title}
      </h3>
      <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-umber">{p.description}</p>
      <div className="mt-4 flex items-center justify-between">
        <AssigneeAvatar member={memberOf(p.assignee)} size="xs" />
        <span className="micro-label">{p.updated}</span>
      </div>
    </Link>
  )
}

function useUpcomingPosts() {
  // Scheduled + recently published posts so each scheduled project can show
  // its channels and the exact time it goes live.
  const [posts, setPosts] = useState<ScheduledPost[] | null>(null)
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const orgId = await primaryOrgId()
        if (!orgId) {
          if (active) setPosts([])
          return
        }
        const from = new Date(Date.now() - 2 * 864e5).toISOString()
        const list = await listScheduledPosts(orgId, { from })
        if (active) setPosts(list)
      } catch {
        if (active) setPosts([])
      }
    })()
    return () => {
      active = false
    }
  }, [])
  return posts
}

function ScheduledCard({ items, className }: { items: Project[]; className?: string }) {
  const posts = useUpcomingPosts()
  const rows = items
    .map((p) => {
      const mine = (posts ?? []).filter((x) => x.projectId === p.id && x.status !== 'cancelled')
      const next = mine
        .filter((x) => x.status === 'scheduled' && x.scheduledFor)
        .map((x) => new Date(x.scheduledFor as string))
        .sort((a, b) => a.getTime() - b.getTime())[0]
      return {
        p,
        platforms: mine.map((x) => x.channel?.platform || x.platform),
        next,
        failed: mine.some((x) => x.status === 'failed'),
      }
    })
    .sort((a, b) => (a.next?.getTime() ?? Infinity) - (b.next?.getTime() ?? Infinity))
  return (
    <div
      className={`card flex flex-col overflow-hidden ${className ?? ''}`}
      data-testid="scheduled-card"
    >
      <CardHeader
        title="Scheduled to publish"
        to="/publishing/calendar"
        action="Calendar"
        meta={
          items.length ? <span className="font-mono text-xs text-label">{items.length}</span> : null
        }
      />
      {posts === null && items.length > 0 ? (
        <div className="space-y-3 px-5 py-4" aria-busy="true">
          {items.slice(0, 3).map((p) => (
            <div key={p.id} className="flex items-center gap-3">
              <Skeleton className="h-6 w-14" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-2.5 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      ) : rows.length ? (
        <ul className="divide-y divide-line">
          {rows.map(({ p, platforms, next, failed }) => (
            <li key={p.id}>
              <Link
                to={`/projects/${p.id}`}
                className="row-link flex items-center gap-3 px-5 py-3"
                data-testid="scheduled-row"
              >
                <span className="flex w-[64px] shrink-0">
                  {platforms.length ? (
                    <PlatformIcons platforms={platforms} size="sm" />
                  ) : (
                    <span className="t-meta">-</span>
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{p.title}</p>
                  <p className="truncate text-xs text-umber">
                    {next
                      ? fmtWhen(next)
                      : p.scheduleDate
                        ? `Scheduled ${p.scheduleDate}`
                        : 'Time not set'}
                  </p>
                </div>
                {failed ? (
                  <StatusChip status="failed" />
                ) : (
                  <StatusChip status={p.status} label={projectStatusLabel(p)} />
                )}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <InlineEmpty
          text="Nothing scheduled"
          action={
            <Link to="/publishing/compose" className="card-link">
              Compose a post <ArrowRight size={13} strokeWidth={2} />
            </Link>
          }
        />
      )}
    </div>
  )
}

/** "Today · 6:30 PM", "Tomorrow · 9:00 AM", "Fri, Oct 16 · 6:30 PM" */
function fmtWhen(d: Date) {
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const diff = Math.floor((new Date(d).setHours(0, 0, 0, 0) - start.getTime()) / 864e5)
  const day =
    diff === 0
      ? 'Today'
      : diff === 1
        ? 'Tomorrow'
        : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  return `${day} · ${time}`
}

/** Human label for a backend activity action, shown on the dashboard feed. */
function describeAction(e: any): string {
  const m = e.metadata ?? {}
  switch (e.action) {
    case 'created':
      return 'created the project'
    case 'assigned':
      return 'assigned an owner'
    case 'transitioned':
      return m.to
        ? `moved it to ${statusLabel(String(m.to)).toLowerCase()}`
        : 'moved it to a new stage'
    case 'version_uploaded':
      return `uploaded ${m.label ?? 'a new version'}`
    case 'comment_added':
      return 'commented on the draft'
    case 'revision_requested':
      return 'requested a revision'
    case 'approved':
      return `approved ${m.label ?? 'the draft'}`
    case 'scheduled':
      return 'scheduled it for publishing'
    case 'published':
      return 'published the project'
    case 'metric_recorded':
      return 'recorded metrics'
    case 'message_sent':
      return 'sent a chat message'
    case 'channel_created':
      return 'created a channel'
    default:
      return String(e.action).replace(/_/g, ' ')
  }
}

const CHAT_ACTIONS = new Set([
  'message_sent',
  'channel_created',
  'channel_joined',
  'member_added_to_channel',
])
const ACTIVITY_CAP = 6

/** Collapse consecutive repeats (same person, same action, same project). */
function groupActivity(events: any[]) {
  const out: { e: any; count: number }[] = []
  for (const e of events) {
    const prev = out[out.length - 1]
    const key = (x: any) => `${x.actor?.name}|${x.action}|${x.projectId?.title ?? ''}`
    if (prev && key(prev.e) === key(e)) prev.count += 1
    else out.push({ e, count: 1 })
  }
  return out
}

function ActivityCard({
  className = '',
  hideEmpty = false,
}: {
  className?: string
  hideEmpty?: boolean
}) {
  // REAL events from the org-wide feed (/organizations/:id/activity), not
  // notifications. Team Chat chatter is excluded - this is a work log.
  const [events, setEvents] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const orgId = await primaryOrgId()
        if (!orgId) {
          if (active) setLoading(false)
          return
        }
        const evts = await listOrgActivity(orgId, 60)
        if (active) setEvents(evts)
      } catch {
        /* backend unreachable - empty state below */
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [])

  const work = events.filter(
    (e) => !CHAT_ACTIONS.has(e.action) && e.projectId?.title !== 'Team Chat',
  )
  const grouped = groupActivity(work)
  const shown = showAll ? grouped.slice(0, 30) : grouped.slice(0, ACTIVITY_CAP)
  if (hideEmpty && !loading && !shown.length) return null

  if (loading) {
    return (
      <div
        className={`card space-y-4 px-5 py-4 ${className}`}
        aria-busy="true"
        data-testid="activity-card"
      >
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="h-7 w-7 !rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-2.5 w-1/4" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <DashSection
      title="Recent activity"
      icon={<Activity size={16} strokeWidth={1.75} />}
      helper={DASH_LINE.activity}
      empty={DASH_EMPTY.activity}
      isEmpty={!shown.length}
      className={className}
      testId="activity-card"
    >
      <ul
        className="grid grid-cols-1 divide-y divide-line md:grid-cols-2 md:divide-y-0"
        data-testid="activity-list"
      >
        {shown.map(({ e, count }) => {
          const actor = e.actor?.name ?? 'Someone'
          const project = e.projectId?.title
          const pid = e.projectId?._id ?? e.projectId?.id
          const body = (
            <>
              <Avatar initials={initialsOf(actor)} size="xs" tone="tint" />
              <div className="min-w-0 flex-1">
                <p className="text-sm leading-snug text-ink">
                  <span className="font-medium">{actor}</span> {describeAction(e)}
                  {count > 1 && (
                    <span className="ml-1 rounded-full bg-ink/[0.05] px-1.5 text-xs text-umber">
                      ×{count}
                    </span>
                  )}
                </p>
                <p className="mt-0.5 truncate text-xs text-umber">
                  {project && <span className="text-ink/80">{project}</span>}
                  {project && ' · '}
                  {e.createdAt ? relTime(e.createdAt) : ''}
                </p>
              </div>
            </>
          )
          return (
            <li key={String(e.id)} className="md:border-b md:border-line md:odd:border-r">
              {pid ? (
                <Link to={`/projects/${pid}`} className="row-link flex gap-3 px-5 py-3">
                  {body}
                </Link>
              ) : (
                <div className="flex gap-3 px-5 py-3">{body}</div>
              )}
            </li>
          )
        })}
      </ul>
      {grouped.length > ACTIVITY_CAP && (
        <button
          className="card-link group justify-center border-t border-line py-2.5"
          onClick={() => setShowAll((v) => !v)}
          aria-expanded={showAll}
          data-testid="activity-view-all"
        >
          {showAll ? 'Show less' : `View all ${Math.min(grouped.length, 30)}`}
          <ArrowRight
            size={13}
            strokeWidth={2}
            className={`transition-transform ${showAll ? '-rotate-90' : 'rotate-90'}`}
          />
        </button>
      )}
    </DashSection>
  )
}

/** Awaiting review: reels whose cut waits on the brand (with their clock and held money), then projects in review. */
function AwaitingReviewCard({
  board,
  projects,
}: {
  board: MoneyBoard | null
  projects: Project[]
}) {
  const reels = board ? awaitingReview(board.payables) : []
  const total = reels.length + projects.length
  const clockText = (r: (typeof reels)[number]) =>
    isOverdue(r)
      ? 'Past the review deadline'
      : r.clockStatus === 'waiting_checks'
        ? 'Clock starts after checks'
        : r.clockStatus === 'paused'
          ? `Paused · ${r.businessDaysLeft ?? 0} business days left`
          : r.businessDaysLeft !== null
            ? `${r.businessDaysLeft} business day${r.businessDaysLeft === 1 ? '' : 's'} left`
            : 'No review clock'
  return (
    <DashSection
      title="Awaiting review"
      icon={<MessageSquare size={16} strokeWidth={1.75} />}
      helper={DASH_LINE.review}
      empty={DASH_EMPTY.review}
      isEmpty={board !== null && total === 0}
      count={total || undefined}
      to="/review"
      action="Open review"
      testId="awaiting-review"
    >
      <ul className="divide-y divide-line">
        {reels.slice(0, 5).map((r) => (
          <li key={`${r.dealId}:${r.milestoneKey}`}>
            <Link
              to={`/deals/${encodeURIComponent(r.dealId)}?reel=${encodeURIComponent(r.milestoneKey)}`}
              className="row-link flex items-center gap-3 px-5 py-2.5"
              data-testid="awaiting-review-reel"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] text-ink">{r.title}</p>
                <p
                  className={`text-[12px] sm:truncate ${isOverdue(r) ? 'text-danger' : 'text-umber'}`}
                >
                  {r.dealTitle} · {clockText(r)}
                </p>
              </div>
              {r.heldMinor > 0 && (
                <span className="t-num shrink-0 text-[12.5px] text-umber">
                  {money(r.heldMinor, r.currency)} held
                </span>
              )}
            </Link>
          </li>
        ))}
        {projects.slice(0, Math.max(0, 6 - Math.min(reels.length, 5))).map((p) => (
          <li key={p.id}>
            <Link to={`/projects/${p.id}`} className="row-link flex items-center gap-3 px-5 py-2.5">
              <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{p.title}</span>
              <StatusChip status={p.status} label={projectStatusLabel(p)} />
            </Link>
          </li>
        ))}
      </ul>
    </DashSection>
  )
}

/** Scheduled projects with their channels and next post time (for Going live today + Scheduled). */
function useScheduledRows(items: Project[]): ScheduledRow[] {
  const posts = useUpcomingPosts()
  return items
    .map((p) => {
      const mine = (posts ?? []).filter((x) => x.projectId === p.id && x.status !== 'cancelled')
      const next = mine
        .filter((x) => x.status === 'scheduled' && x.scheduledFor)
        .map((x) => new Date(x.scheduledFor as string))
        .sort((a, b) => a.getTime() - b.getTime())[0]
      return {
        key: p.id,
        title: p.title,
        to: `/projects/${p.id}`,
        when: next
          ? fmtWhen(next)
          : p.scheduleDate
            ? `Scheduled ${p.scheduleDate}`
            : 'Time not set',
        platforms: mine.map((x) => x.channel?.platform || x.platform).filter(Boolean) as string[],
        at: next?.getTime() ?? Infinity,
        right: mine.some((x) => x.status === 'failed') ? <StatusChip status="failed" /> : undefined,
      }
    })
    .sort((a, b) => a.at - b.at)
}

/** Admin: money strip, stages, then the six insight sections in two columns. */
function AdminOverview({ inReview, scheduled }: { inReview: Project[]; scheduled: Project[] }) {
  const board = useMoneyBoard()
  const { data, error } = usePipeline()
  const scheduledRows = useScheduledRows(scheduled)
  return (
    <div className="space-y-4">
      <AttentionStrip board={board} />
      {error && !data ? null : !data ? (
        <PipelineSkeleton />
      ) : (
        <div className="space-y-4" data-testid="pipeline">
          <StageStrip data={data} />
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
            <div className="space-y-4">
              <WaitingOn data={data} />
              <AwaitingReviewCard board={board} projects={inReview} />
            </div>
            <div className="space-y-4">
              <GoingLive data={data} scheduled={scheduledRows} />
              <LastWeekBest data={data} />
            </div>
          </div>
        </div>
      )}
      <ActivityCard />
    </div>
  )
}

function relTime(iso: string) {
  const d = new Date(iso)
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const h = Math.round(mins / 60)
  if (h < 24) return `${h}h ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function PublishedCard({ p }: { p: Project }) {
  return (
    <Link to={`/projects/${p.id}`} className="card card-hover p-5">
      <div className="mb-3 flex items-center justify-between">
        <span className="micro-label">{p.platform ?? 'Published'}</span>
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-success/10 text-success">
          <Megaphone {...iconProps} />
        </span>
      </div>
      <h3 className="font-headline text-[15px] font-semibold leading-snug tracking-[-0.01em] text-ink">
        {p.title}
      </h3>
      <div className="mt-4 flex items-center justify-between">
        <span className="micro-label">{p.publishedAt ?? p.updated}</span>
        <Chip label="Published" tone="success" />
      </div>
    </Link>
  )
}

function RoleOverview() {
  const board = useMoneyBoard()
  return (
    <div className="space-y-4">
      <AttentionStrip board={board} />
      <PipelineOverview />
    </div>
  )
}

/* ---------- Page ---------- */

export default function DashboardPage() {
  const viewer = useViewer()

  const { projects, error: projectsError } = useProjects()
  const { team } = useTeam()
  setTeamRef(team)

  // While the backend round-trip is in flight, show skeletons - never a
  // misleading "zero" state on slow connections.

  // My scope
  const myWork = projects.filter(
    (p) => p.assignee === viewer.id && p.status !== 'PUBLISHED' && p.status !== 'CLOSED',
  )
  const mineInReview = projects.filter((p) => p.assignee === viewer.id && inReview(p))
  const myWaiting = projects.filter(
    (p) =>
      p.assignee === viewer.id &&
      (p.status === 'WAITING_FOR_INPUTS' || p.status === 'INPUTS_READY'),
  )

  // Org scope
  const allInReview = projects.filter(inReview)
  const approvedOrScheduled = projects.filter(
    (p) => p.status === 'APPROVED' || p.status === 'SCHEDULED',
  )
  const readyToPublish = projects.filter((p) => p.status === 'APPROVED')
  const publishedAll = projects.filter((p) => p.status === 'PUBLISHED')
  const sharedWithMe = projects.filter(
    (p) => p.reviewers.includes(viewer.id) || p.creator === viewer.id,
  )
  // Published work is no longer waiting to go out - only SCHEDULED counts here.
  const scheduled = projects.filter((p) => p.status === 'SCHEDULED')

  return (
    <div className="space-y-8">
      <div>
        <h1 className="t-display">Dashboard</h1>
        <p className="mt-1 text-[14px] text-umber">{PAGE_LINE['/dashboard']}</p>
      </div>

      {/* Admin: money strip, stages, waiting on, going live + scheduled, awaiting review,
          last week's best, recent activity. Other roles: money strip + pipeline, then their desk. */}
      {projectsError ? (
        <ErrorBanner onRetry={() => window.location.reload()} />
      ) : viewer.role === 'admin' ? (
        <AdminOverview inReview={allInReview} scheduled={scheduled} />
      ) : (
        <RoleOverview />
      )}

      {/* ---------------- Admin: team overview ---------------- */}
      {viewer.role === 'admin' && (
        <>
          {myWork.length > 0 && (
            <section>
              <header className="mb-3 flex items-center justify-between">
                <h2 className="card-title">Your work</h2>
                <Link
                  to="/my-work"
                  className="group flex items-center gap-1 text-xs font-medium text-teal transition-opacity hover:opacity-80"
                >
                  All my work
                  <ArrowRight
                    size={13}
                    strokeWidth={2}
                    className="transition-transform group-hover:translate-x-0.5"
                  />
                </Link>
              </header>
              <div className="stagger grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {myWork.slice(0, 3).map((p) => (
                  <WorkCard key={p.id} p={p} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {/* ---------------- Editor: production desk ---------------- */}
      {viewer.role === 'editor' && (
        <>
          <section className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <div className="card overflow-hidden xl:col-span-2">
              <CardHeader title="My work" to="/my-work" action="All my work" />
              {myWork.length ? (
                <div className="stagger grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
                  {myWork.slice(0, 4).map((p) => (
                    <WorkCard key={p.id} p={p} />
                  ))}
                </div>
              ) : (
                <div className="px-5 py-10 text-center text-sm text-umber">
                  Nothing on your desk right now.
                </div>
              )}
            </div>
            <div className="space-y-6">
              <ProjectListCard
                title="In review - my submissions"
                icon={<MessageSquare {...iconProps} />}
                items={mineInReview}
                empty="Nothing of yours is in review."
              />
              <ActivityCard />
            </div>
          </section>
          {myWaiting.length > 0 && (
            <ProjectListCard
              title="Ready to start"
              to="/my-work"
              action="All my work"
              icon={<Inbox {...iconProps} />}
              items={myWaiting}
              empty=""
            />
          )}
        </>
      )}

      {/* ---------------- Designer: design desk ---------------- */}
      {viewer.role === 'designer' && (
        <section className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <ProjectListCard
            className="xl:col-span-2"
            title="Awaiting your design"
            to="/my-work"
            action="All my work"
            icon={<Clapperboard {...iconProps} />}
            items={myWork}
            empty="Nothing is waiting on your desk."
          />
          <div className="space-y-6">
            {mineInReview.length > 0 && (
              <ProjectListCard
                title="In review"
                icon={<MessageSquare {...iconProps} />}
                items={mineInReview}
              />
            )}
            <ActivityCard />
          </div>
        </section>
      )}

      {/* ---------------- Reviewer: review desk ---------------- */}
      {viewer.role === 'reviewer' && (
        <section className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <ProjectListCard
            className="xl:col-span-2"
            title="Awaiting your review"
            to="/review"
            action="Open review"
            icon={<MessageSquare {...iconProps} />}
            items={allInReview}
            empty="Nothing waiting on you right now."
          />
          <div className="space-y-6">
            <ProjectListCard
              title="Recently approved"
              icon={<BadgeCheck {...iconProps} />}
              items={approvedOrScheduled}
              empty="No approvals yet."
            />
            <ActivityCard />
          </div>
        </section>
      )}

      {/* ---------------- Publisher: publishing desk ---------------- */}
      {viewer.role === 'publisher' && (
        <>
          <section className="grid grid-cols-1 gap-6 xl:grid-cols-3">
            <ScheduledCard items={scheduled} className="xl:col-span-2" />
            <div className="space-y-6">
              <ProjectListCard
                title="Ready to publish"
                to="/publishing/compose"
                action="Compose post"
                icon={<BadgeCheck {...iconProps} />}
                items={readyToPublish}
                empty="No approved projects waiting to go live."
              />
              <ActivityCard />
            </div>
          </section>
          <section>
            <header className="mb-3 flex items-center justify-between">
              <h2 className="card-title">Recently published</h2>
              <Link
                to="/projects"
                className="group flex items-center gap-1 text-xs font-medium text-teal transition-opacity hover:opacity-80"
              >
                All projects
                <ArrowRight
                  size={13}
                  strokeWidth={2}
                  className="transition-transform group-hover:translate-x-0.5"
                />
              </Link>
            </header>
            {publishedAll.length ? (
              <div className="stagger grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {publishedAll.slice(0, 3).map((p) => (
                  <PublishedCard key={p.id} p={p} />
                ))}
              </div>
            ) : (
              <div className="card p-8 text-center text-sm text-umber">
                Nothing published yet.
                <p className="mt-1 text-[13px]">{EMPTY_LINE.published}</p>
              </div>
            )}
          </section>
        </>
      )}

      {/* ---------------- Member: read-only workspace ---------------- */}
      {viewer.role === 'member' && (
        <section className="grid grid-cols-1 gap-6 xl:grid-cols-3">
          <ProjectListCard
            className="xl:col-span-2"
            title="Shared with you"
            to="/projects"
            action="All projects"
            icon={<Eye {...iconProps} />}
            items={sharedWithMe}
            empty="Nothing has been shared with you yet."
          />
          <div className="space-y-6">
            <ActivityCard />
          </div>
        </section>
      )}
    </div>
  )
}
