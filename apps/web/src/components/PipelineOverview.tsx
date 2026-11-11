/**
 * Dashboard pipeline pieces, all from one request (GET /organizations/:orgId/pipeline):
 *
 *   StageStrip    - Idea -> Brief -> Production -> Review -> Publish -> Live with
 *                   counts and one share bar; click a stage to list it
 *   WaitingOn     - who holds the next step (people and roles) and on which items
 *   GoingLive     - failed posts, what goes out today, then what is scheduled
 *   LastWeekBest  - last week's top post by engagement
 *
 * Each section collapses to one line when empty (DashSection).
 * PipelineOverview composes them for the role desks; the admin dashboard
 * places them itself next to the money strip and Awaiting review.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowRight, CalendarClock, Hourglass, Trophy } from 'lucide-react'
import { primaryOrgId } from '../lib/data'
import { compact, fmtTime } from '../lib/publishing'
import { getPipeline, type BlockedOn, type PipelineData } from '../services/api'
import { UnassignedChip } from './ui'
import { Delta, SimulatedBadge, pctText } from './charts'
import { PlatformIcon, PlatformIcons, STAGE_DOT, StatusChip, StatusDot, stageOf } from './status'
import { Skeleton } from './states'
import { DashSection } from './dashboard/Section'
import { DASH_EMPTY, DASH_LINE } from '../lib/copy'
import { ownBlocked } from '../lib/attention'

const STAGE_LINK: Record<string, string> = {
  idea: '/concepts',
  brief: '/projects?stage=brief',
  production: '/projects?stage=production',
  review: '/review',
  publish: '/publishing/calendar',
  live: '/analytics',
}

const ic = { size: 16, strokeWidth: 1.75 }

export function usePipeline() {
  const [data, setData] = useState<PipelineData | null>(null)
  const [error, setError] = useState(false)
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
  return { data, error }
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

/* ---------------- stage strip ---------------- */

export function StageStrip({ data }: { data: PipelineData }) {
  const [active, setActive] = useState<string | null>(null)
  const shown = data.stages.find((s) => s.key === active) || null
  const sum = data.stages.reduce((a, s) => a + s.count, 0)
  return (
    <section aria-label="Pipeline stages" data-testid="stage-strip">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
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
        <p className="text-[12.5px] text-umber">{DASH_LINE.stages}</p>
      </div>
      {/* progress: the share of all work each stage holds, left to right */}
      <div
        className="mt-2.5 flex h-1.5 w-full overflow-hidden rounded-full bg-ink/[0.05]"
        role="img"
        aria-label={data.stages.map((s) => `${s.label} ${s.count}`).join(', ')}
        data-testid="stage-progress"
      >
        {sum > 0 &&
          data.stages
            .filter((s) => s.count > 0)
            .map((s) => (
              <span
                key={s.key}
                className={`h-full ${STAGE_DOT[stageOf(s.key)]} border-r-2 border-canvas last:border-r-0`}
                style={{ width: `${(s.count / sum) * 100}%` }}
              />
            ))}
      </div>
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
  )
}

/* ---------------- waiting on ---------------- */

export function WaitingOn({ data, mine }: { data: PipelineData; mine?: string }) {
  const all = mine !== undefined ? ownBlocked(data.blocked, mine) : data.blocked
  const rows = all.slice(0, 5)
  return (
    <DashSection
      title={mine !== undefined ? 'Waiting on you' : 'Waiting on'}
      icon={<Hourglass {...ic} />}
      helper={mine !== undefined ? DASH_LINE.waitingOnYou : DASH_LINE.waitingOn}
      empty={mine !== undefined ? DASH_EMPTY.waitingOnYou : DASH_EMPTY.waitingOn}
      isEmpty={!rows.length}
      count={rows.length ? all.reduce((a, b) => a + b.count, 0) : undefined}
      to="/projects"
      action="Projects"
      testId="waiting-on"
    >
      <ul className="divide-y divide-line">
        {rows.map((b) => (
          <li key={b.id ? `user:${b.id}` : `${b.kind}:${b.name}`}>
            <Link
              to={b.projects[0] ? `/projects/${b.projects[0]._id}` : '/projects'}
              className="row-link flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 sm:flex-nowrap"
            >
              <span className="min-w-0 max-w-[70%] shrink-0 sm:w-[38%] sm:max-w-[180px]">
                <Who b={{ kind: b.kind, name: b.name }} />
              </span>
              <span className="order-last min-w-0 basis-full truncate text-[13.5px] text-ink sm:order-none sm:flex-1 sm:basis-0">
                {b.projects.map((p) => p.title).join(', ')}
              </span>
              <span className="t-num ml-auto shrink-0 text-[12.5px] text-umber sm:ml-0">
                {b.count} item{b.count === 1 ? '' : 's'}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </DashSection>
  )
}

/* ---------------- going live today + scheduled ---------------- */

export type ScheduledRow = {
  key: string
  title: string
  to: string
  when: string
  platforms: string[]
  right?: ReactNode
}

export function GoingLive({
  data,
  scheduled = [],
}: {
  data: PipelineData
  scheduled?: ScheduledRow[]
}) {
  const today = data.goingLiveToday.slice(0, 6)
  const todayIds = new Set(today.map((g) => g.projectId))
  const later = scheduled.filter((s) => !todayIds.has(s.key)).slice(0, 5)
  const isEmpty = !data.failedPosts && !today.length && !later.length
  return (
    <DashSection
      title="Going live today"
      icon={<CalendarClock {...ic} />}
      helper={DASH_LINE.goingLive}
      empty={DASH_EMPTY.goingLive}
      isEmpty={isEmpty}
      count={today.length || undefined}
      to="/publishing/calendar"
      action="Calendar"
      testId="next-up"
    >
      <ul className="divide-y divide-line" data-testid="going-live-today">
        {data.failedPosts > 0 && (
          <li>
            <Link
              to="/publishing/calendar"
              className="row-link flex items-center gap-3 px-5 py-2.5"
            >
              <AlertTriangle size={15} strokeWidth={1.75} className="shrink-0 text-st-failed" />
              <span className="flex-1 text-[13.5px] text-st-failed">
                {data.failedPosts} post{data.failedPosts === 1 ? '' : 's'} failed
              </span>
            </Link>
          </li>
        )}
        {today.map((g) => (
          <li key={g._id}>
            <Link
              to={`/projects/${g.projectId}`}
              className="row-link flex items-center gap-3 px-5 py-2.5"
            >
              <PlatformIcon platform={g.platform} size="sm" />
              <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{g.title}</span>
              {g.status === 'published' ? (
                <StatusChip status="published" label="Live" />
              ) : g.status === 'failed' ? (
                <StatusChip status="failed" />
              ) : (
                <span className="t-num text-[12.5px] text-umber">Today {fmtTime(g.at)}</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
      {later.length > 0 && (
        <div data-testid="scheduled-card">
          <p className="border-t border-line bg-ink/[0.015] px-5 py-1.5 text-[12px] text-umber">
            Scheduled
          </p>
          <ul className="divide-y divide-line border-t border-line">
            {later.map((s) => (
              <li key={s.key}>
                <Link
                  to={s.to}
                  className="row-link flex items-center gap-3 px-5 py-2.5"
                  data-testid="scheduled-row"
                >
                  <span className="flex w-[52px] shrink-0">
                    {s.platforms.length ? (
                      <PlatformIcons platforms={s.platforms} size="sm" />
                    ) : (
                      <span className="t-meta">-</span>
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{s.title}</span>
                  <span className="t-num shrink-0 text-[12.5px] text-umber">{s.when}</span>
                  {s.right}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </DashSection>
  )
}

/* ---------------- last week's best ---------------- */

export function LastWeekBest({ data }: { data: PipelineData }) {
  const best = data.lastWeekBest
  return (
    <DashSection
      title="Last week's best"
      icon={<Trophy {...ic} />}
      helper={DASH_LINE.best}
      empty={DASH_EMPTY.best}
      isEmpty={!best}
      to="/analytics"
      action="Analytics"
      testId="last-week-best"
    >
      {best && (
        <Link
          to={`/projects/${best.projectId}`}
          className="row-link flex flex-wrap items-center gap-x-4 gap-y-1.5 px-5 py-3"
        >
          <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{best.title}</span>
          <span className="t-num text-[13.5px] text-teal">{pctText(best.engagementRate)}</span>
          <span className="t-num text-[13.5px] text-umber">{compact(best.views)} views</span>
          <Delta value={data.lastWeek.change} />
          {data.lastWeek.simulated && <SimulatedBadge show />}
        </Link>
      )}
    </DashSection>
  )
}

/* ---------------- composition for the role desks ---------------- */

/** `mine` (the viewer's id) scopes Waiting on to the viewer's own items: the crew desks pass it. */
export function PipelineOverview({ mine }: { mine?: string } = {}) {
  const { data, error } = usePipeline()
  if (error && !data) return null
  if (!data) return <PipelineSkeleton />
  return (
    <div className="space-y-4" data-testid="pipeline">
      <StageStrip data={data} />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <WaitingOn data={data} mine={mine} />
        <GoingLive data={data} />
      </div>
      <LastWeekBest data={data} />
    </div>
  )
}

export function PipelineSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading pipeline">
      <div className="flex gap-1.5">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-24" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="card space-y-3 p-5">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
          </div>
        ))}
      </div>
    </div>
  )
}
