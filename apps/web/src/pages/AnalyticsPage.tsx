/**
 * Measure - Analytics (Phase 2). Everything here comes from the analytics
 * time series (Postiz post + platform analytics, or clearly-labelled
 * simulated data in demo mode): totals with a 7/30/90 day toggle, trend,
 * top content by engagement rate, platform comparison, best posting
 * day/hour from our own history, and per-client / per-campaign rollups.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { BarChart3, FileText, RefreshCw, Send } from 'lucide-react'
import { EmptyState } from '../components/primitives'
import { PageHeader } from '../components/ui'
import { ErrorBanner } from '../components/states'
import { useToast } from '../components/toast'
import {
  BarTrend,
  Delta,
  RAMP,
  RampLegend,
  SimulatedBadge,
  pctText,
  rampColor,
} from '../components/charts'
import { Skeleton } from '../components/states'
import { primaryOrgId } from '../lib/data'
import { compact, canPublish } from '../lib/publishing'
import { useViewer } from '../lib/viewer'
import {
  getAnalyticsHeatmap,
  getAnalyticsSummary,
  runAnalyticsIngest,
  type AnalyticsSummary,
  type Heatmap,
} from '../services/api'
import { PlatformIcon } from '../components/status'

const WINDOWS = [7, 30, 90] as const
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const DAY_INDEX = [1, 2, 3, 4, 5, 6, 0] // Mon-first rows -> JS weekday

function lastMonthKey() {
  const d = new Date()
  d.setDate(1)
  d.setMonth(d.getMonth() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function AnalyticsPage() {
  const toast = useToast()
  const viewer = useViewer()
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30)
  const [orgId, setOrgId] = useState<string | null>(null)
  const [data, setData] = useState<AnalyticsSummary | null>(null)
  const [heat, setHeat] = useState<Heatmap | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [rollupBy, setRollupBy] = useState<'client' | 'campaign'>('client')
  const [syncing, setSyncing] = useState(false)

  const load = async (id: string, d: number) => {
    setError(null)
    try {
      const [s, h] = await Promise.all([getAnalyticsSummary(id, d), getAnalyticsHeatmap(id)])
      setData(s)
      setHeat(h)
    } catch (err: any) {
      setError(err?.message || 'Could not load analytics')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    primaryOrgId().then((id) => {
      setOrgId(id)
      if (id) void load(id, days)
      else setLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pick = (d: (typeof WINDOWS)[number]) => {
    setDays(d)
    if (orgId) void load(orgId, d)
  }

  const syncNow = async () => {
    if (!orgId) return
    setSyncing(true)
    try {
      const r = await runAnalyticsIngest(orgId)
      toast(
        'success',
        'Analytics refreshed',
        `${r.posts} post${r.posts === 1 ? '' : 's'} and ${r.channels} channel${r.channels === 1 ? '' : 's'} updated`,
      )
      await load(orgId, days)
    } catch (err: any) {
      toast('danger', 'Refresh failed', err?.message)
    } finally {
      setSyncing(false)
    }
  }

  const hasData =
    !!data && (data.totals.views > 0 || data.topContent.length > 0 || data.platforms.length > 0)
  const heatGrid = useMemo(() => {
    const max = Math.max(0.0001, ...(heat?.cells.map((c) => c.engagementRate) ?? [0]))
    const at = (weekday: number, hour: number) =>
      heat?.cells.find((c) => c.weekday === weekday && c.hour === hour)
    return { max, at }
  }, [heat])
  const maxPlatformViews = Math.max(1, ...(data?.platforms.map((p) => p.views) ?? [1]))

  return (
    <div className="fade-in space-y-6">
      <PageHeader
        title="Analytics"
        actions={
          <>
            <div className="seg" role="group" aria-label="Time window" data-testid="window-toggle">
              {WINDOWS.map((w) => (
                <button
                  key={w}
                  onClick={() => pick(w)}
                  aria-pressed={days === w}
                  className="font-mono"
                  data-testid={`window-${w}`}
                >
                  {w}d
                </button>
              ))}
            </div>
            <Link
              to={`/reports/performance?month=${lastMonthKey()}`}
              className="btn-secondary"
              data-testid="monthly-report"
            >
              <FileText size={14} strokeWidth={1.75} /> Monthly report
            </Link>
            {canPublish(viewer) && (
              <button
                className="btn-ghost"
                onClick={() => void syncNow()}
                disabled={syncing}
                data-testid="analytics-refresh"
              >
                <RefreshCw size={14} strokeWidth={1.75} /> {syncing ? 'Refreshing…' : 'Refresh'}
              </button>
            )}
          </>
        }
      />
      {error && <ErrorBanner message={error} onRetry={() => orgId && void load(orgId, days)} />}
      {data && <SimulatedBadge show={data.simulated} />}

      {loading ? (
        <AnalyticsSkeleton />
      ) : !hasData ? (
        <EmptyState
          icon={<BarChart3 size={22} strokeWidth={1.5} />}
          title="No performance data yet"
          description="Analytics fill in automatically once an approved project is published. Next step: schedule something from the composer."
          action={
            <Link to="/publishing/compose" className="btn-primary">
              <Send size={14} strokeWidth={1.75} /> Schedule a post
            </Link>
          }
        />
      ) : (
        data && (
          <>
            {/* KPI tiles */}
            <section className="grid grid-cols-2 gap-4 lg:grid-cols-5" data-testid="kpis">
              {[
                { k: 'Views', v: compact(data.totals.views), d: data.change.views },
                {
                  k: 'Engagements',
                  v: compact(data.totals.engagements),
                  d: data.change.engagements,
                },
                {
                  k: 'Engagement rate',
                  v: pctText(data.totals.engagementRate),
                  d: data.change.engagementRate,
                  suffix: ' pts',
                },
                {
                  k: 'Followers gained',
                  v: compact(data.totals.followersGained),
                  d: data.change.followersGained,
                },
                {
                  k: 'Watch time (min)',
                  v: compact(data.totals.watchTime),
                  d: data.change.watchTime,
                },
              ].map((t) => (
                <div key={t.k} className="card p-4">
                  <p className="micro-label">{t.k}</p>
                  <p className="t-num mt-2 text-[26px] leading-none">{t.v}</p>
                  <div className="mt-2 flex items-center gap-1.5">
                    <Delta value={t.d} suffix={t.suffix ?? '%'} />
                    <span className="text-[11px] text-umber">vs prior {days}d</span>
                  </div>
                </div>
              ))}
            </section>

            {/* Trend */}
            <section className="card p-5" data-testid="trend">
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <h2 className="card-title">Daily views</h2>
                  <p className="t-meta mt-0.5">
                    {compact(data.totals.views)} views across all channels
                    <span className="hidden sm:inline"> · hover a bar for the day</span>
                  </p>
                </div>
                <span className="micro-label whitespace-nowrap">last {days} days</span>
              </div>
              <BarTrend
                data={data.trend.map((t) => {
                  const d = new Date(`${t.date}T12:00:00`)
                  return {
                    label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
                    date: d.toLocaleDateString(undefined, {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                    }),
                    value: t.views,
                  }
                })}
              />
            </section>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2 [&>*]:min-w-0">
              {/* Top content */}
              <section className="card p-0" data-testid="top-content">
                <header className="card-head justify-between">
                  <h2 className="card-title">Top content</h2>
                  <span className="micro-label hidden sm:inline">by engagement rate</span>
                </header>
                <ol className="divide-y divide-line">
                  {data.topContent.map((t, i) => (
                    <li key={t.projectId} className="flex items-center gap-3 px-5 py-3">
                      <span className="w-5 font-mono text-xs text-umber">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <Link
                          to={`/projects/${t.projectId}`}
                          className="block truncate text-sm font-medium text-ink hover:text-teal"
                        >
                          {t.title}
                        </Link>
                        <p className="truncate text-xs text-umber">{t.client || 'No client'}</p>
                      </div>
                      <span className="flex gap-1">
                        {t.platforms.map((p) => (
                          <PlatformIcon key={p} platform={p} size="sm" />
                        ))}
                      </span>
                      <span className="hidden w-16 text-right font-mono text-sm text-ink sm:inline">
                        {compact(t.views)}
                      </span>
                      <span className="w-14 text-right font-mono text-sm font-medium text-teal">
                        {pctText(t.engagementRate)}
                      </span>
                    </li>
                  ))}
                  {!data.topContent.length && (
                    <li className="px-5 py-6 text-sm text-umber">
                      Nothing crossed 50 views in this window yet.
                    </li>
                  )}
                </ol>
              </section>

              {/* Platforms */}
              <section className="card p-0" data-testid="platform-comparison">
                <header className="card-head justify-between">
                  <h2 className="card-title">Platform comparison</h2>
                  <span className="micro-label">{days}d</span>
                </header>
                <ul className="divide-y divide-line">
                  {data.platforms.map((p) => (
                    <li key={p.platform} className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <PlatformIcon platform={p.platform} size="sm" />
                        <span className="flex-1 text-sm font-medium text-ink">{p.label}</span>
                        <span className="font-mono text-xs text-umber">
                          {p.posts} post{p.posts === 1 ? '' : 's'}
                        </span>
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink/[0.06]">
                        <div
                          className="h-full rounded-full bg-teal transition-[width] duration-500"
                          style={{ width: `${Math.max(2, (p.views / maxPlatformViews) * 100)}%` }}
                        />
                      </div>
                      <dl className="mt-2 grid grid-cols-4 gap-2 text-xs">
                        <div>
                          <dt className="micro-label">Views</dt>
                          <dd className="font-mono text-ink">{compact(p.views)}</dd>
                        </div>
                        <div>
                          <dt className="micro-label">Eng. rate</dt>
                          <dd className="font-mono text-ink">{pctText(p.engagementRate)}</dd>
                        </div>
                        <div>
                          <dt className="micro-label">Followers +</dt>
                          <dd className="font-mono text-ink">{compact(p.followersGained)}</dd>
                        </div>
                        <div>
                          <dt className="micro-label">
                            {p.platform === 'youtube' ? 'Watch min' : 'Saves'}
                          </dt>
                          <dd className="font-mono text-ink">
                            {compact(p.platform === 'youtube' ? p.watchTime : p.saves)}
                          </dd>
                        </div>
                      </dl>
                    </li>
                  ))}
                </ul>
              </section>
            </div>

            <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] [&>*]:min-w-0">
              {/* Heatmap */}
              <section className="card p-5" data-testid="heatmap">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="card-title">Best time to post</h2>
                  {heat?.best && (
                    <span
                      className="rounded-full bg-tint px-2.5 py-1 text-xs font-medium text-teal"
                      data-testid="best-slot"
                    >
                      {heat.best.day} around {heat.best.hour}:00 ·{' '}
                      {pctText(heat.best.engagementRate)}
                    </span>
                  )}
                </div>
                <p className="mb-3 text-xs text-umber">
                  {heat?.posts ?? 0} posts, {heat?.timezone}
                </p>
                <div className="overflow-x-auto">
                  <table
                    className="border-separate border-spacing-[3px]"
                    aria-label="Engagement by weekday and hour"
                  >
                    <thead>
                      <tr>
                        <th />
                        {Array.from({ length: 24 }, (_, h) => (
                          <th key={h} className="w-5 font-mono text-[10px] font-normal text-label">
                            {h % 6 === 0 ? h : ''}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {DAYS.map((d, row) => (
                        <tr key={d}>
                          <th className="pr-2 text-left font-mono text-[11px] font-normal text-label">
                            {d}
                          </th>
                          {Array.from({ length: 24 }, (_, h) => {
                            const c = heatGrid.at(DAY_INDEX[row], h)
                            return (
                              <td
                                key={h}
                                className="h-5 w-5 rounded-[4px] transition-transform hover:scale-110"
                                style={{
                                  background: c
                                    ? rampColor(c.engagementRate / heatGrid.max)
                                    : RAMP[0],
                                }}
                                title={
                                  c
                                    ? `${d} ${h}:00 · ${c.posts} post(s) · ${pctText(c.engagementRate)}`
                                    : `${d} ${h}:00 · no posts`
                                }
                              />
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <span className="t-meta">Darker = higher engagement rate</span>
                  <RampLegend
                    low="Low"
                    high={heatGrid.max > 0.0001 ? `${pctText(heatGrid.max)}` : 'High'}
                  />
                </div>
              </section>

              {/* Rollups */}
              <section className="card p-0" data-testid="rollups">
                <header className="card-head">
                  <h2 className="card-title">By {rollupBy}</h2>
                  <div className="seg ml-auto" role="group" aria-label="Group by">
                    {(['client', 'campaign'] as const).map((k) => (
                      <button
                        key={k}
                        onClick={() => setRollupBy(k)}
                        aria-pressed={rollupBy === k}
                        className="capitalize"
                      >
                        {k}
                      </button>
                    ))}
                  </div>
                </header>
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="table-head">
                      <th className="px-5 py-2.5">Name</th>
                      <th className="px-3 py-2.5 text-right">Projects</th>
                      <th className="px-3 py-2.5 text-right">Views</th>
                      <th className="px-5 py-2.5 text-right">Eng.</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {data.rollups[rollupBy].map((r) => (
                      <tr key={r.name}>
                        <td className="px-5 py-2.5 text-ink">
                          {rollupBy === 'client' && r.name !== 'No client' ? (
                            <Link
                              className="hover:text-teal"
                              to={`/reports/performance?month=${lastMonthKey()}&client=${encodeURIComponent(r.name)}`}
                            >
                              {r.name}
                            </Link>
                          ) : (
                            r.name
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-umber">
                          {r.projects}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-ink">
                          {compact(r.views)}
                        </td>
                        <td className="px-5 py-2.5 text-right font-mono text-teal">
                          {pctText(r.engagementRate)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </div>
          </>
        )
      )}
    </div>
  )
}

function AnalyticsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading analytics">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="card space-y-3 p-4">
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-6 w-16" />
            <Skeleton className="h-2.5 w-24" />
          </div>
        ))}
      </div>
      <div className="card p-5">
        <Skeleton className="mb-5 h-3.5 w-28" />
        <div className="flex h-[180px] items-end gap-[3px]">
          {Array.from({ length: 30 }).map((_, i) => (
            <div
              key={i}
              className="skeleton flex-1 !rounded-b-none"
              style={{ height: `${25 + ((i * 37) % 60)}%` }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
