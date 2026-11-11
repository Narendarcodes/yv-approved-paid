/**
 * /my-money ("Where's my money"): the signed-in crew member's milestones, their
 * signed share, what was released to them so far, and when the rest is due:
 * the review clock's deadline for the partial release, its grace deadline for
 * the rest, or "on approval" when there is no clock. Simulated payouts are labelled.
 */
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { AgGridReact } from 'ag-grid-react'
import type { ColDef, ICellRendererParams } from 'ag-grid-community'
import { FlaskConical } from 'lucide-react'
import Illustration from '../components/Illustration'
import { yvGridTheme } from '../components/grid/agGrid'
import { shortDate, StatusPill, useNarrow } from '../components/grid/moneyGrid'
import type { Stage } from '../components/status'
import { PageHeader } from '../components/ui'
import { EmptyState, ErrorBanner, ListSkeleton, WakingServer, useSlow } from '../components/states'
import { money, useDealOrg } from '../lib/deals'
import * as api from '../services/api'
import type { MyMoneyRow } from '../services/api'
import { PAGE_LINE, EMPTY_LINE, HINT } from '../lib/copy'
import { SandboxChip } from '../components/Sponsors'

const STATUS: Record<string, { label: string; stage: Stage }> = {
  paid: { label: 'Paid', stage: 'live' },
  releasing: { label: 'Releasing', stage: 'scheduled' },
  clock_running: { label: 'In review · clock running', stage: 'review' },
  clock_paused: { label: 'In review · clock paused', stage: 'review' },
  in_grace: { label: 'In grace', stage: 'production' },
  in_progress: { label: 'In progress', stage: 'production' },
  not_funded: { label: 'Not funded yet', stage: 'brief' },
  disputed: { label: 'Disputed', stage: 'failed' },
  cancelled: { label: 'Cancelled', stage: 'neutral' },
}

/** "Tue 10 Nov" */
function payday(iso: string): string {
  const d = new Date(iso)
  return isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

function expectedText(r: MyMoneyRow): string {
  if (!r.expected.length) return r.releasedMinor > 0 ? 'All released' : '—'
  return r.expected
    .map((e) => `${money(e.amountMinor, r.currency)} ${e.at ? `by ${shortDate(e.at)}` : e.label}`)
    .join(' · ')
}

function MilestoneCell(p: ICellRendererParams<MyMoneyRow> & { showDeal?: boolean }) {
  if (!p.data) return null
  return (
    <Link
      to={`/deals/${encodeURIComponent(p.data.dealId)}?reel=${encodeURIComponent(p.data.milestoneKey)}`}
      className="flex h-full min-w-0 items-center gap-1.5 text-ink hover:text-teal"
      title={`${p.data.title} · ${p.data.dealTitle}`}
    >
      <span className="truncate">{p.data.title}</span>
      {p.showDeal && <span className="truncate text-umber">· {p.data.dealTitle}</span>}
    </Link>
  )
}

/** The next amount and when: the first expected release, one line. */
function NextCell(p: ICellRendererParams<MyMoneyRow>) {
  const r = p.data
  if (!r) return null
  const e = r.expected[0]
  if (!e) return <span className="text-umber">—</span>
  return (
    <span className="truncate" title={expectedText(r)}>
      <span className="t-num text-ink">{money(e.amountMinor, r.currency)}</span>{' '}
      <span className="text-umber">{e.at ? shortDate(e.at) : e.label}</span>
    </span>
  )
}

/** Released so far; a simulated line says so on hover (the page header carries the badge). */
function ReleasedCell(p: ICellRendererParams<MyMoneyRow>) {
  if (!p.data) return null
  return (
    <span
      className="t-num flex h-full items-center justify-end"
      title={p.data.simulated ? 'Simulated payout: no money left PayPal for this line' : undefined}
    >
      {money(p.data.releasedMinor, p.data.currency)}
    </span>
  )
}

function StatusCell(p: ICellRendererParams<MyMoneyRow>) {
  if (!p.data) return null
  const s = STATUS[p.data.status] || { label: p.data.status, stage: 'neutral' as Stage }
  return <StatusPill label={s.label} stage={s.stage} />
}

export default function MyMoneyPage() {
  const org = useDealOrg()
  const orgId = org.data ?? null
  const narrow = useNarrow()
  const q = useQuery({
    queryKey: ['my-money', orgId],
    queryFn: () => api.getMyMoney(orgId as string),
    enabled: !!orgId,
    retry: 3,
    retryDelay: (n) => Math.min(1000 * 2 ** n, 10_000),
  })
  // waiting on the org or the rows (a disabled query has no data yet, so it counts as loading too)
  const loading = org.isPending || (!!orgId && q.isPending)
  const attempt = Math.max(org.failureCount, q.failureCount)
  const slow = useSlow(loading)
  const retry = () => {
    if (org.isError || !orgId) void org.refetch()
    else void q.refetch()
  }
  const rows = useMemo(() => q.data?.rows ?? [], [q.data])

  const summary = useMemo(() => {
    const cur = rows[0]?.currency || 'USD'
    const mixed = rows.some((r) => r.currency !== cur)
    const released = rows.reduce((a, r) => a + r.releasedMinor, 0)
    const expected = rows.reduce((a, r) => a + r.expectedMinor, 0)
    const dates = rows
      .flatMap((r) => r.expected.map((e) => e.at).filter(Boolean) as string[])
      .sort()
    const onApproval = rows.some((r) => r.expected.some((e) => !e.at))
    const now = new Date().toISOString()
    return {
      cur,
      mixed,
      released,
      expected,
      next: dates.find((d) => d >= now) || dates[0] || null,
      onApproval,
      simulated: rows.some((r) => r.simulated),
    }
  }, [rows])

  const showDeal = new Set(rows.map((r) => r.dealId)).size > 1
  const cols = useMemo<ColDef<MyMoneyRow>[]>(
    () => [
      {
        headerName: 'Milestone',
        field: 'title',
        cellRenderer: MilestoneCell,
        cellRendererParams: { showDeal: showDeal && !narrow },
        minWidth: 150,
        flex: 1.5,
      },
      {
        headerName: 'My share',
        field: 'myShareMinor',
        valueFormatter: (p) => (p.data ? money(p.value, p.data.currency) : ''),
        tooltipValueGetter: (p) =>
          p.data ? `${p.data.mySharePct}% of ${money(p.data.amountMinor, p.data.currency)}` : '',
        type: 'rightAligned',
        cellClass: 'ag-right-aligned-cell t-num',
        width: 120,
        hide: narrow,
      },
      {
        headerName: 'Paid',
        field: 'releasedMinor',
        cellRenderer: ReleasedCell,
        type: 'rightAligned',
        width: narrow ? 104 : 130,
      },
      {
        headerName: 'Next',
        colId: 'expected',
        valueGetter: (p) =>
          p.data
            ? p.data.expectedAt || (p.data.expectedLabel ? `~${p.data.expectedLabel}` : '')
            : '',
        valueFormatter: (p) => (p.data ? expectedText(p.data) : ''),
        cellRenderer: NextCell,
        minWidth: 160,
        flex: 1,
        hide: narrow,
      },
      {
        headerName: 'Status',
        field: 'status',
        cellRenderer: StatusCell,
        minWidth: narrow ? 120 : 180,
      },
    ],
    [narrow, showDeal],
  )

  return (
    <div className="fade-in" data-testid="my-money-page">
      <PageHeader title="My money" subtitle={PAGE_LINE['/my-money']} />
      {loading ? (
        slow || attempt > 0 ? (
          <WakingServer onRetry={retry} attempt={attempt} />
        ) : (
          <ListSkeleton rows={3} height="h-12" />
        )
      ) : org.isError || q.isError ? (
        <ErrorBanner message="Your payouts did not load." onRetry={retry} />
      ) : !rows.length ? (
        <EmptyState title="No payouts yet" description={EMPTY_LINE.myMoney} illustration="wallet" />
      ) : (
        <>
          <div
            className="mb-6 flex flex-wrap items-baseline gap-x-4 gap-y-1"
            data-testid="money-summary"
          >
            {summary.expected === 0 && summary.released > 0 && (
              <Illustration name="paid" className="h-20 w-auto self-center" />
            )}
            <p className="text-[22px] tracking-[-0.01em] text-ink">
              {summary.expected === 0 && summary.released > 0 ? (
                <span data-testid="all-paid">All paid</span>
              ) : (
                <>
                  <span className="t-num">{money(summary.expected, summary.cur)}</span> on the way
                </>
              )}
              {(summary.next || summary.onApproval) && (
                <span className="text-umber">
                  {' '}
                  · next payday {summary.next ? payday(summary.next) : 'on approval'}
                </span>
              )}
            </p>
            <p
              className="text-[14px] text-umber"
              title={summary.mixed ? 'Mixed currencies: see rows' : undefined}
            >
              <span className="t-num text-ink">{money(summary.released, summary.cur)}</span> paid
            </p>
            <SandboxChip className="self-center" />
            <p className="w-full text-[12px] text-umber" data-testid="decision-hint">
              {HINT.myMoney}
            </p>
            {summary.simulated && (
              <span
                className="chip chip-warning ml-auto"
                data-testid="simulated-badge"
                title="These payouts were recorded as simulated: no money left PayPal"
              >
                <FlaskConical size={12} strokeWidth={2} />
                Simulated payout
              </span>
            )}
          </div>
          <div className="yv-grid" data-testid="my-money-grid">
            <AgGridReact<MyMoneyRow>
              theme={yvGridTheme}
              rowData={rows}
              columnDefs={cols}
              defaultColDef={{ sortable: true, resizable: true, suppressMovable: true }}
              getRowId={(p) => `${p.data.dealId}:${p.data.milestoneKey}`}
              domLayout={rows.length <= 25 ? 'autoHeight' : 'normal'}
              containerStyle={rows.length <= 25 ? undefined : { height: 640 }}
              animateRows={false}
            />
          </div>
        </>
      )}
    </div>
  )
}
