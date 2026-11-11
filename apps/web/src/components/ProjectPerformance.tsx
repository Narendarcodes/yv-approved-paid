/**
 * "Performance" card on the project page (Phase 2): one row per channel the
 * project went live on - views, engagement rate, a daily-views sparkline and
 * the % change of the last days vs the days before. Data comes from the
 * analytics time series (Postiz, or clearly-labelled simulated data in demo mode).
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { BarChart3, ExternalLink, FileText } from 'lucide-react'
import { primaryOrgId } from '../lib/data'
import { PLATFORMS, compact, fmtDateTime } from '../lib/publishing'
import { getProjectPerformance, type ProjectPerformance as Perf } from '../services/api'
import { Delta, SimulatedBadge, Sparkline, pctText } from './charts'
import { PlatformIcon } from './status'

export function ProjectPerformance({ projectId, status }: { projectId: string; status: string }) {
  const [data, setData] = useState<Perf | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let live = true
    ;(async () => {
      const orgId = await primaryOrgId().catch(() => null)
      if (!orgId) {
        if (live) setLoaded(true)
        return
      }
      try {
        const d = await getProjectPerformance(orgId, projectId, 30)
        if (live) setData(d)
      } catch {
        /* card shows its empty state */
      } finally {
        if (live) setLoaded(true)
      }
    })()
    return () => {
      live = false
    }
  }, [projectId, status])

  const live = data?.channels ?? []
  return (
    <section className="card p-0" data-testid="performance-card">
      <header className="card-head flex-wrap">
        <BarChart3 size={16} strokeWidth={1.75} className="text-teal" />
        <h2 className="card-title">Performance</h2>
        <SimulatedBadge show={!!data?.simulated && live.length > 0} />
        {live.length > 0 && (
          <Link
            to={`/reports/performance?project=${projectId}`}
            className="btn-ghost ml-auto !h-8 text-xs"
            data-testid="project-report"
          >
            <FileText size={13} strokeWidth={1.75} /> Client report
          </Link>
        )}
      </header>
      {!loaded ? (
        <div className="h-24 animate-pulse bg-canvas/60" />
      ) : !live.length ? (
        <p className="px-5 py-6 text-sm text-umber">
          {['APPROVED', 'SCHEDULED'].includes(status)
            ? 'Numbers start flowing in about an hour after the first post goes live.'
            : 'Performance appears here once this project is published.'}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-4">
            {[
              ['Views', compact(data!.totals.views)],
              ['Engagement', pctText(data!.totals.engagementRate)],
              ['Likes', compact(data!.totals.likes)],
              ['Saves + shares', compact((data!.totals.saves || 0) + (data!.totals.shares || 0))],
            ].map(([k, v]) => (
              <div key={k} className="bg-surface px-5 py-3">
                <p className="micro-label">{k}</p>
                <p className="mt-1 font-headline text-xl font-semibold text-ink">{v}</p>
              </div>
            ))}
          </div>
          <ul className="divide-y divide-line">
            {live.map((r) => (
              <li
                key={r.publicationId}
                className="flex flex-wrap items-center gap-4 px-5 py-3.5"
                data-testid="performance-row"
              >
                <PlatformIcon platform={r.platform} size="sm" />
                <div className="min-w-[140px] flex-1">
                  <p className="truncate text-sm font-medium text-ink">
                    {r.channel?.name ?? PLATFORMS[r.platform]?.label}
                  </p>
                  <p className="micro-label normal-case tracking-normal">
                    Live {fmtDateTime(r.publishedAt)}
                  </p>
                </div>
                <div className="w-20 text-right">
                  <p className="font-mono text-sm text-ink">{compact(r.metrics.views)}</p>
                  <p className="micro-label">views</p>
                </div>
                <div className="w-16 text-right">
                  <p className="font-mono text-sm text-ink">{pctText(r.engagementRate)}</p>
                  <p className="micro-label">eng.</p>
                </div>
                <Sparkline
                  values={r.sparkline.map((s) => s.views)}
                  label={`Daily views for ${r.channel?.name ?? r.platform}`}
                />
                <div className="w-16 text-right">
                  <Delta value={r.change.views} />
                  <p className="micro-label">{r.change.window}</p>
                </div>
                {r.postUrl && (
                  <a
                    href={r.postUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="icon-btn icon-btn-sm"
                    aria-label="Open live post"
                  >
                    <ExternalLink size={14} strokeWidth={1.75} />
                  </a>
                )}
              </li>
            ))}
          </ul>
          {data!.pending > 0 && (
            <p className="border-t border-line px-5 py-2.5 text-xs text-umber">
              {data!.pending} more post{data!.pending === 1 ? '' : 's'} still scheduled or needing a
              retry.
            </p>
          )}
        </>
      )}
    </section>
  )
}
