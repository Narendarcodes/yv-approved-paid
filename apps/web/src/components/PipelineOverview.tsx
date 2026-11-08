/**
 * Dashboard pipeline: one compact stage strip (Idea -> Brief -> Production ->
 * Review -> Publish -> Live, click a stage to list it) and one "Next up" list
 * that merges failed posts, what goes live today, who work is waiting on and,
 * for admins, what awaits review or is scheduled. Nothing pending shows one
 * illustrated empty state. Last week's best shows only when there is one.
 * One request: GET /organizations/:orgId/pipeline.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowRight, Hourglass, MessageSquare, Send } from 'lucide-react'
import { primaryOrgId } from '../lib/data'
import { compact, fmtTime } from '../lib/publishing'
import { getPipeline, type BlockedOn, type PipelineData } from '../services/api'
import { UnassignedChip } from './ui'
import { Delta, SimulatedBadge, pctText } from './charts'
import { PlatformIcon, StatusChip, StatusDot, stageOf } from './status'
import { Skeleton } from './states'
import { EmptyState } from './states'
import type { Project } from '../lib/types'

const STAGE_LINK: Record<string, string> = {
  idea: '/concepts',
  brief: '/projects?stage=brief',
  production: '/projects?stage=production',
  review: '/review',
  publish: '/publishing/calendar',
  live: '/analytics',
}

function Who({ b }: { b: BlockedOn | null }) {
  if (!b) return null
  if (b.kind === 'unassigned') return <UnassignedChip size="xs" />
  const tone =
    b.kind === 'client'
      ? 'bg-st-production-bg text-st-production'
      : b.kind === 'system'
        ? 'bg-ink/[0.05] text-umber'
        : 'bg-st-scheduled-bg text-st-scheduled'
  return <span className={`status-chip max-w-full truncate ${tone}`}>{b.name}</span>
}

type NextRow = { key: string; icon: ReactNode; title: ReactNode; to: string; right?: ReactNode }

export function PipelineOverview({
  review = [],
  scheduled = [],
}: {
  /** Admin only: projects awaiting review and scheduled to publish, merged into Next up. */
  review?: Project[]
  scheduled?: Project[]
}) {
  const [data, setData] = useState<PipelineData | null>(null)
  const [error, setError] = useState(false)
  const [active, setActive] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    const load = async () => {
      try {
        const orgId = await primaryOrgId()
        if (!orgId) return
        const d = await getPipeline(orgId)
        if (live) setData(d)
      } catch {
        if (live) setError(true)
      }
    }
    void load()
    const t = setInterval(load, 30000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [])

  if (error && !data) return null
  if (!data) return <PipelineSkeleton />

  const shown = data.stages.find((s) => s.key === active) || null
  const ic = { size: 15, strokeWidth: 1.5, className: 'shrink-0 text-umber' }
  const next: NextRow[] = [
    ...(data.failedPosts > 0
      ? [
          {
            key: 'failed',
            icon: <AlertTriangle {...ic} className="shrink-0 text-st-failed" />,
            title: (
              <span className="text-st-failed">
                {data.failedPosts} post{data.failedPosts === 1 ? '' : 's'} failed
              </span>
            ),
            to: '/publishing/calendar',
          },
        ]
      : []),
    ...data.goingLiveToday.slice(0, 6).map((g) => ({
      key: `live:${g._id}`,
      icon: <PlatformIcon platform={g.platform} size="sm" />,
      title: g.title,
      to: `/projects/${g.projectId}`,
      right:
        g.status === 'published' ? (
          <StatusChip status="published" label="Live" />
        ) : g.status === 'failed' ? (
          <StatusChip status="failed" />
        ) : (
          <span className="t-num text-[13px] text-umber">Today {fmtTime(g.at)}</span>
        ),
    })),
    ...review.map((p) => ({
      key: `review:${p.id}`,
      icon: <MessageSquare {...ic} />,
      title: p.title,
      to: `/projects/${p.id}`,
      right: <StatusChip status={p.status} />,
    })),
    ...scheduled.map((p) => ({
      key: `sched:${p.id}`,
      icon: <Send {...ic} />,
      title: p.title,
      to: `/projects/${p.id}`,
      right: <StatusChip status={p.status} />,
    })),
    ...data.blocked.slice(0, 5).map((b) => ({
      key: `blocked:${b.kind}:${b.name}`,
      icon: <Hourglass {...ic} />,
      title: b.projects[0]?.title ?? b.name,
      to: b.projects[0] ? `/projects/${b.projects[0]._id}` : '/projects',
      right: (
        <span className="flex items-center gap-2">
          {b.count > 1 && <span className="t-num text-[13px] text-umber">+{b.count - 1}</span>}
          <Who b={{ kind: b.kind, name: b.name }} />
        </span>
      ),
    })),
  ].slice(0, 10)

  return (
    <div className="space-y-6" data-testid="pipeline">
      <section aria-label="Pipeline stages">
        <ol className="flex flex-wrap gap-1.5">
          {data.stages.map((s, i) => (
            <li key={s.key}>
              <button
                onClick={() => setActive(active === s.key ? null : s.key)}
                aria-pressed={active === s.key}
                className={`flex h-9 items-center gap-2 rounded-lg border px-3 text-[14px] transition-colors ${active === s.key ? 'border-teal/40 bg-tint text-ink' : 'border-line bg-surface text-umber hover:text-ink'}`}
                data-testid={`stage-${s.key}`}
              >
                <StatusDot stage={stageOf(s.key)} />
                <span className="sr-only">Stage {i + 1}: </span>
                {s.label}
                <span className="t-num text-ink" data-testid={`stage-count-${s.key}`}>
                  {s.count}
                </span>
              </button>
            </li>
          ))}
        </ol>
        {shown && (
          <div className="card fade-in mt-3 px-5 py-3" data-testid="stage-items">
            <div className="flex items-center justify-between py-1">
              <h3 className="text-[14px] font-medium text-ink">{shown.label}</h3>
              <Link to={STAGE_LINK[shown.key]} className="card-link">
                Open <ArrowRight size={12} strokeWidth={2} />
              </Link>
            </div>
            {shown.items.length ? (
              <ul className="divide-y divide-line">
                {shown.items.map((it) => (
                  <li key={it._id} className="flex items-center gap-3 py-2.5">
                    <Link
                      to={`/projects/${it._id}`}
                      className="min-w-0 flex-1 truncate text-sm text-ink hover:text-teal"
                    >
                      {it.title}
                    </Link>
                    {it.failedPosts > 0 && (
                      <span className="text-xs text-danger">{it.failedPosts} failed</span>
                    )}
                    <Who b={it.blockedOn} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-2 text-sm text-umber">Empty</p>
            )}
          </div>
        )}
      </section>

      <section className="card overflow-hidden" data-testid="next-up">
        <header className="card-head">
          <h2 className="card-title">Next up</h2>
        </header>
        {next.length ? (
          <ul className="divide-y divide-line" data-testid="going-live-today">
            {next.map((r) => (
              <li key={r.key}>
                <Link to={r.to} className="row-link flex items-center gap-3 px-5 py-3">
                  {r.icon}
                  <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{r.title}</span>
                  {r.right}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="All clear" illustration="calendar" />
        )}
      </section>

      {data.lastWeekBest && (
        <section className="card px-5 py-4" data-testid="last-week-best">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-[13px] text-umber">Last week&apos;s best</span>
            <Link
              to={`/projects/${data.lastWeekBest.projectId}`}
              className="min-w-0 flex-1 truncate text-[15px] text-ink hover:text-teal"
            >
              {data.lastWeekBest.title}
            </Link>
            <span className="t-num text-[14px] text-teal">
              {pctText(data.lastWeekBest.engagementRate)}
            </span>
            <span className="t-num text-[14px] text-umber">
              {compact(data.lastWeekBest.views)} views
            </span>
            <Delta value={data.lastWeek.change} />
            {data.lastWeek.simulated && <SimulatedBadge show />}
          </div>
        </section>
      )}
    </div>
  )
}

function PipelineSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading pipeline">
      <div className="flex gap-1.5">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-24" />
        ))}
      </div>
      <div className="card space-y-3 p-5">
        <Skeleton className="h-3.5 w-28" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
      </div>
    </div>
  )
}
