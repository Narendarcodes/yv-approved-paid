/**
 * Dashboard pipeline (Phase 3): the stage strip (Idea -> Brief -> Production
 * -> Review -> Publish -> Live) with counts, what each item is waiting on,
 * who the pipeline is blocked on, what goes live today, and last week's best
 * post. One request: GET /organizations/:orgId/pipeline.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowRight, CalendarClock, Hourglass, Trophy } from 'lucide-react'
import { primaryOrgId } from '../lib/data'
import { compact, fmtTime } from '../lib/publishing'
import { getPipeline, type BlockedOn, type PipelineData } from '../services/api'
import { UnassignedChip } from './ui'
import { Delta, SimulatedBadge, pctText } from './charts'
import { PlatformIcon, StatusChip, StatusDot, STAGE_DOT, stageOf } from './status'
import { Skeleton } from './states'

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

export function PipelineOverview() {
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

  const total = data.stages.reduce((a, s) => a + s.count, 0)
  const shown = data.stages.find((s) => s.key === active) || null

  return (
    <div className="space-y-6" data-testid="pipeline">
      {/* Stage strip */}
      <section className="card p-0" aria-label="Pipeline stages">
        <ol className="grid grid-cols-3 divide-line lg:grid-cols-6 lg:divide-x">
          {data.stages.map((s, i) => (
            <li key={s.key}>
              <button
                onClick={() => setActive(active === s.key ? null : s.key)}
                aria-pressed={active === s.key}
                className={`group flex h-full w-full flex-col items-start gap-1 px-3.5 py-3.5 sm:px-5 sm:py-4 text-left transition-colors duration-200 hover:bg-ink/[0.025] focus-visible:!rounded-none focus-visible:!outline-offset-[-2px] ${active === s.key ? 'bg-tint' : ''}`}
                data-testid={`stage-${s.key}`}
              >
                <span className="micro-label flex items-center gap-1.5">
                  <StatusDot stage={stageOf(s.key)} />
                  <span className="sr-only">Stage {i + 1}: </span>
                  {s.label}
                </span>
                <span
                  className="t-num mt-1 text-[28px] leading-none"
                  data-testid={`stage-count-${s.key}`}
                >
                  {s.count}
                </span>
                <span className="text-xs text-umber">
                  {s.key === 'idea' && s.concepts
                    ? `${s.concepts} concept${s.concepts === 1 ? '' : 's'}`
                    : s.key === 'live'
                      ? 'last 30 days'
                      : s.count
                        ? 'in progress'
                        : 'clear'}
                </span>
                <span className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-ink/[0.06]">
                  <span
                    className={`block h-full rounded-full transition-[width] duration-500 ${STAGE_DOT[stageOf(s.key)]}`}
                    style={{ width: `${total ? Math.max(4, (s.count / total) * 100) : 0}%` }}
                  />
                </span>
              </button>
            </li>
          ))}
        </ol>
        {shown && (
          <div className="fade-in border-t border-line px-5 py-4" data-testid="stage-items">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-headline text-sm font-semibold text-ink">{shown.label}</h3>
              <Link to={STAGE_LINK[shown.key]} className="card-link">
                Open {shown.label.toLowerCase()} →
              </Link>
            </div>
            {shown.items.length ? (
              <ul className="divide-y divide-line">
                {shown.items.map((it) => (
                  <li key={it._id} className="flex flex-wrap items-center gap-3 py-2.5">
                    <Link
                      to={`/projects/${it._id}`}
                      className="min-w-0 flex-1 truncate text-sm font-medium text-ink hover:text-teal"
                    >
                      {it.title}
                    </Link>
                    {it.failedPosts > 0 && (
                      <span className="text-[11px] font-medium text-danger">
                        {it.failedPosts} failed post
                      </span>
                    )}
                    {it.blockedOn?.action && (
                      <span className="text-xs text-umber">{it.blockedOn.action}</span>
                    )}
                    <Who b={it.blockedOn} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-2 text-sm text-umber">Nothing in this stage.</p>
            )}
          </div>
        )}
      </section>

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        {/* Waiting on */}
        <div className="card flex flex-col p-0" data-testid="blocked-on">
          <header className="card-head">
            <Hourglass size={15} strokeWidth={1.75} className="text-umber" />
            <h2 className="card-title">Waiting on</h2>
          </header>
          {data.blocked.length ? (
            <ul className="divide-y divide-line">
              {data.blocked.slice(0, 5).map((b) => (
                <li key={`${b.kind}:${b.name}`} className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <Who b={{ kind: b.kind, name: b.name }} />
                    <span className="ml-auto font-mono text-xs text-umber">
                      {b.count} item{b.count === 1 ? '' : 's'}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-umber">
                    {b.projects.map((p) => p.title).join(' · ')}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-5 py-6 text-sm text-umber">Nobody is blocking anything</p>
          )}
        </div>

        {/* Going live today */}
        <div className="card flex flex-col p-0" data-testid="going-live-today">
          <header className="card-head">
            <CalendarClock size={15} strokeWidth={1.75} className="text-umber" />
            <h2 className="card-title">Going live today</h2>
            {data.failedPosts > 0 && (
              <Link
                to="/publishing/calendar"
                className="ml-auto flex items-center gap-1 rounded-md text-xs font-medium text-st-failed hover:underline"
              >
                <AlertTriangle size={12} strokeWidth={2} /> {data.failedPosts} failed
              </Link>
            )}
          </header>
          {data.goingLiveToday.length ? (
            <ul className="divide-y divide-line">
              {data.goingLiveToday.slice(0, 6).map((g) => (
                <li key={g._id} className="flex items-center gap-3 px-5 py-3">
                  <PlatformIcon platform={g.platform} size="sm" />
                  <Link
                    to={`/projects/${g.projectId}`}
                    className="min-w-0 flex-1 truncate text-sm text-ink hover:text-teal"
                  >
                    {g.title}
                  </Link>
                  {g.status === 'published' ? (
                    <StatusChip status="published" label="Live" />
                  ) : g.status === 'failed' ? (
                    <StatusChip status="failed" />
                  ) : (
                    <span className="font-mono text-xs text-ink">{fmtTime(g.at)}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-5 py-6 text-sm text-umber">
              Nothing scheduled for today.{' '}
              <Link to="/publishing/compose" className="font-medium text-teal hover:underline">
                Schedule an approved project →
              </Link>
            </div>
          )}
        </div>

        {/* Last week's best */}
        <div className="card flex flex-col p-0" data-testid="last-week-best">
          <header className="card-head">
            <Trophy size={15} strokeWidth={1.75} className="text-umber" />
            <h2 className="card-title">Last week's best</h2>
          </header>
          {data.lastWeekBest ? (
            <div className="p-5">
              {data.lastWeek.simulated && (
                <div className="mb-3">
                  <SimulatedBadge show />
                </div>
              )}
              <Link
                to={`/projects/${data.lastWeekBest.projectId}`}
                className="block font-headline text-lg font-semibold leading-snug tracking-[-0.01em] text-ink hover:text-teal"
              >
                {data.lastWeekBest.title}
              </Link>
              <div className="mt-2 flex items-center gap-1.5">
                {data.lastWeekBest.platforms.map((p) => (
                  <PlatformIcon key={p} platform={p} size="sm" />
                ))}
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3">
                <div>
                  <dt className="micro-label">Engagement</dt>
                  <dd className="t-num mt-0.5 text-xl !text-teal">
                    {pctText(data.lastWeekBest.engagementRate)}
                  </dd>
                </div>
                <div>
                  <dt className="micro-label">Views (7d)</dt>
                  <dd className="t-num mt-0.5 text-xl">{compact(data.lastWeekBest.views)}</dd>
                </div>
              </dl>
              <p className="mt-3 flex items-center gap-1.5 text-xs text-umber">
                Team views this week {compact(data.lastWeek.views)}{' '}
                <Delta value={data.lastWeek.change} />
              </p>
              <Link to="/analytics" className="card-link mt-3">
                Open analytics <ArrowRight size={12} strokeWidth={2} />
              </Link>
            </div>
          ) : (
            <p className="px-5 py-6 text-sm text-umber">No published posts last week</p>
          )}
        </div>
      </section>
    </div>
  )
}

function PipelineSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading pipeline">
      <div className="card grid grid-cols-2 gap-px overflow-hidden sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="space-y-2.5 px-5 py-4">
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="h-7 w-10" />
            <Skeleton className="h-2.5 w-20" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="card space-y-3 p-5">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
    </div>
  )
}
