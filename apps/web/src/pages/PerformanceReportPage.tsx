/**
 * One-click client performance report (Phase 2) - a printable page for a
 * project (lifetime) or a month (optionally one client). "Save as PDF" uses
 * the browser's print dialog; print CSS hides the toolbar.
 */
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Printer } from 'lucide-react'
import BrandLogo from '../components/BrandLogo'
import { primaryOrgId } from '../lib/data'
import { PLATFORMS, compact, fmtDateTime } from '../lib/publishing'
import { getPerformanceReport, type PerformanceReport } from '../services/api'

const pct = (r: number) => `${(r * 100).toFixed(1)}%`

export default function PerformanceReportPage() {
  const [params] = useSearchParams()
  const projectId = params.get('project') || undefined
  const month = params.get('month') || undefined
  const client = params.get('client') || undefined
  const [data, setData] = useState<PerformanceReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    primaryOrgId()
      .then((orgId) => {
        if (!orgId) throw new Error('No workspace')
        return getPerformanceReport(orgId, { projectId, month, client })
      })
      .then(setData)
      .catch((err) => setError(err?.message || 'Could not build the report'))
  }, [projectId, month, client])

  const title = data
    ? data.period.kind === 'project'
      ? (data.projects[0]?.title ?? 'Project report')
      : `${data.client ? `${data.client} · ` : ''}${data.period.label}`
    : 'Performance report'

  return (
    <div className="min-h-screen bg-canvas print:bg-white">
      <div className="mx-auto max-w-4xl px-6 py-6 print:max-w-none print:px-0 print:py-0">
        <div className="mb-6 flex items-center justify-between print:hidden">
          <Link to={projectId ? `/projects/${projectId}` : '/analytics'} className="btn-ghost">
            <ArrowLeft size={14} strokeWidth={1.75} /> Back
          </Link>
          <button
            className="btn-primary"
            onClick={() => window.print()}
            disabled={!data}
            data-testid="report-print"
          >
            <Printer size={14} strokeWidth={1.75} /> Print / save as PDF
          </button>
        </div>

        <article
          className="rounded-2xl border border-line bg-surface p-10 shadow-card print:rounded-none print:border-0 print:p-0 print:shadow-none"
          data-testid="report"
        >
          <header className="flex items-start justify-between border-b border-line pb-6">
            <div>
              <p className="micro-label">Performance report</p>
              <h1 className="mt-1 font-headline text-3xl font-semibold tracking-tight text-ink">
                {title}
              </h1>
              {data && (
                <p className="mt-1 text-sm text-umber">
                  {data.period.kind === 'project'
                    ? data.period.label
                    : `Posts published in ${data.period.label}`}{' '}
                  · generated{' '}
                  {new Date(data.generatedAt).toLocaleDateString(undefined, {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}
                </p>
              )}
            </div>
            <BrandLogo />
          </header>

          {error && <p className="mt-8 text-sm text-danger">{error}</p>}
          {!data && !error && <div className="mt-8 h-40 animate-pulse rounded-xl bg-canvas" />}

          {data && (
            <>
              {data.simulated && (
                <p
                  className="mt-6 rounded-lg border border-dashed border-warning/60 bg-warning/10 px-4 py-2 text-xs text-warning"
                  data-testid="report-simulated"
                >
                  Demo workspace: these figures are simulated, not real platform data.
                </p>
              )}
              {!data.posts.length ? (
                <p className="mt-8 text-sm text-umber">No published posts in this period yet.</p>
              ) : (
                <>
                  <section className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
                    {[
                      ['Views', compact(data.totals.views)],
                      ['Engagement rate', pct(data.totals.engagementRate)],
                      ['Likes', compact(data.totals.likes)],
                      ['Posts', String(data.totals.posts)],
                    ].map(([k, v]) => (
                      <div
                        key={k}
                        className="rounded-xl bg-canvas px-4 py-3 print:border print:border-line"
                      >
                        <p className="micro-label">{k}</p>
                        <p className="mt-1 font-headline text-2xl font-semibold text-ink">{v}</p>
                      </div>
                    ))}
                  </section>

                  <section className="mt-8">
                    <h2 className="font-headline text-lg font-semibold text-ink">Highlights</h2>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-ink/85">
                      {data.highlights.map((h) => (
                        <li key={h}>{h}</li>
                      ))}
                    </ul>
                  </section>

                  <section className="mt-8">
                    <h2 className="font-headline text-lg font-semibold text-ink">By platform</h2>
                    <table className="mt-3 w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-line">
                          <th className="py-2 micro-label">Platform</th>
                          <th className="py-2 text-right micro-label">Posts</th>
                          <th className="py-2 text-right micro-label">Views</th>
                          <th className="py-2 text-right micro-label">Engagement</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.platforms.map((p) => (
                          <tr key={p.platform} className="border-b border-line/70">
                            <td className="py-2 text-ink">{p.label}</td>
                            <td className="py-2 text-right font-mono">{p.posts}</td>
                            <td className="py-2 text-right font-mono">
                              {compact(p.metrics.views)}
                            </td>
                            <td className="py-2 text-right font-mono text-teal">
                              {pct(p.engagementRate)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>

                  <section className="mt-8">
                    <h2 className="font-headline text-lg font-semibold text-ink">Every post</h2>
                    <table className="mt-3 w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-line">
                          <th className="py-2 micro-label">Post</th>
                          <th className="py-2 micro-label">Live</th>
                          <th className="py-2 text-right micro-label">Views</th>
                          <th className="py-2 text-right micro-label">Likes</th>
                          <th className="py-2 text-right micro-label">Comments</th>
                          <th className="py-2 text-right micro-label">Eng.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.posts.map((p) => (
                          <tr key={p.publicationId} className="border-b border-line/70 align-top">
                            <td className="py-2 pr-3">
                              <p className="font-medium text-ink">{p.project}</p>
                              <p className="text-xs text-umber">
                                {PLATFORMS[p.platform]?.label ?? p.platform} · {p.channel}
                                {p.postUrl && (
                                  <>
                                    {' '}
                                    ·{' '}
                                    <a className="text-teal underline" href={p.postUrl}>
                                      link
                                    </a>
                                  </>
                                )}
                              </p>
                            </td>
                            <td className="py-2 text-xs text-umber">
                              {fmtDateTime(p.publishedAt)}
                            </td>
                            <td className="py-2 text-right font-mono">
                              {compact(p.metrics.views)}
                            </td>
                            <td className="py-2 text-right font-mono">
                              {compact(p.metrics.likes)}
                            </td>
                            <td className="py-2 text-right font-mono">
                              {compact(p.metrics.comments)}
                            </td>
                            <td className="py-2 text-right font-mono text-teal">
                              {pct(p.engagementRate)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>
                </>
              )}
              <footer className="mt-10 border-t border-line pt-4 text-xs text-umber">
                Engagement rate = (likes + comments + shares + saves) ÷ views. Figures as of{' '}
                {new Date(data.generatedAt).toLocaleString()}.
              </footer>
            </>
          )}
        </article>
      </div>
    </div>
  )
}
