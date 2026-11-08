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
import { FlaskConical, Wallet } from 'lucide-react'
import { yvGridTheme } from '../components/grid/agGrid'
import { shortDate, StatusPill, useNarrow } from '../components/grid/moneyGrid'
import type { Stage } from '../components/status'
import { PageHeader } from '../components/ui'
import { EmptyState, ErrorBanner, ListSkeleton } from '../components/states'
import { money, useDealOrg } from '../lib/deals'
import * as api from '../services/api'
import type { MyMoneyRow } from '../services/api'

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

function expectedText(r: MyMoneyRow): string {
  if (!r.expected.length) return r.releasedMinor > 0 ? 'All released' : '—'
  return r.expected
    .map((e) => `${money(e.amountMinor, r.currency)} ${e.at ? `by ${shortDate(e.at)}` : e.label}`)
    .join(' · ')
}

function DealCell(p: ICellRendererParams<MyMoneyRow>) {
  if (!p.data) return null
  return (
    <Link
      to={`/deals/${encodeURIComponent(p.data.dealId)}`}
      className="flex h-full items-center truncate font-medium text-teal hover:underline"
    >
      {p.data.dealTitle}
    </Link>
  )
}
function MilestoneCell(p: ICellRendererParams<MyMoneyRow> & { narrow?: boolean }) {
  if (!p.data) return null
  return (
    <span className="flex h-full min-w-0 flex-col justify-center gap-1 leading-tight">
      <span className="truncate text-ink">{p.data.title}</span>
      {p.narrow && (
        <>
          <span className="truncate text-[11px] text-umber" title={expectedText(p.data)}>
            {expectedText(p.data)}
          </span>
          <span className="flex min-w-0">
            <StatusCell {...p} />
          </span>
        </>
      )}
    </span>
  )
}
function ExpectedCell(p: ICellRendererParams<MyMoneyRow>) {
  const r = p.data
  if (!r) return null
  if (!r.expected.length)
    return <span className="text-umber">{r.releasedMinor > 0 ? 'All released' : '—'}</span>
  return (
    <span className="flex h-full flex-col justify-center leading-tight">
      {r.expected.map((e, i) => (
        <span key={i} className="truncate text-[12px]" title={e.label}>
          <span className="font-medium text-ink">{money(e.amountMinor, r.currency)}</span>{' '}
          <span className="text-umber">
            {e.at
              ? `by ${shortDate(e.at)}${r.expected.length > 1 ? (i === 0 ? ' (partial)' : ' (rest)') : ''}`
              : e.label}
          </span>
        </span>
      ))}
    </span>
  )
}
function ShareCell(p: ICellRendererParams<MyMoneyRow>) {
  if (!p.data) return null
  return (
    <span className="flex h-full flex-col items-end justify-center leading-tight">
      <span className="font-medium">{money(p.data.myShareMinor, p.data.currency)}</span>
      <span className="text-[11px] text-umber">
        {p.data.mySharePct}% of {money(p.data.amountMinor, p.data.currency)}
      </span>
    </span>
  )
}
function ReleasedCell(p: ICellRendererParams<MyMoneyRow>) {
  if (!p.data) return null
  return (
    <span className="flex h-full items-center justify-end gap-1.5">
      {p.data.simulated && (
        <span
          className="chip chip-warning !h-5 !px-1.5"
          title="Simulated payout: no money left PayPal for this line"
        >
          SIM
        </span>
      )}
      <span className="font-medium">{money(p.data.releasedMinor, p.data.currency)}</span>
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
  })
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
    return {
      cur,
      mixed,
      released,
      expected,
      latest: dates[dates.length - 1] || null,
      onApproval,
      simulated: rows.some((r) => r.simulated),
    }
  }, [rows])

  const cols = useMemo<ColDef<MyMoneyRow>[]>(
    () => [
      {
        headerName: 'Deal',
        field: 'dealTitle',
        cellRenderer: DealCell,
        minWidth: 150,
        flex: 1,
        hide: narrow,
      },
      {
        headerName: 'Milestone',
        field: 'title',
        cellRenderer: MilestoneCell,
        cellRendererParams: { narrow },
        minWidth: 150,
        flex: 1.3,
      },
      {
        headerName: 'My share',
        field: 'myShareMinor',
        cellRenderer: ShareCell,
        type: 'rightAligned',
        width: 150,
        hide: narrow,
      },
      {
        headerName: 'Released',
        field: 'releasedMinor',
        cellRenderer: ReleasedCell,
        type: 'rightAligned',
        width: narrow ? 110 : 130,
      },
      {
        headerName: 'Expected',
        colId: 'expected',
        valueGetter: (p) =>
          p.data
            ? p.data.expectedAt || (p.data.expectedLabel ? `~${p.data.expectedLabel}` : '')
            : '',
        valueFormatter: (p) => (p.data ? expectedText(p.data) : ''),
        cellRenderer: ExpectedCell,
        minWidth: 200,
        flex: 1.2,
        hide: narrow,
      },
      {
        headerName: 'Status',
        field: 'status',
        cellRenderer: StatusCell,
        minWidth: 180,
        hide: narrow,
      },
    ],
    [narrow],
  )

  return (
    <div className="fade-in" data-testid="my-money-page">
      <PageHeader title="My money" />
      {org.isLoading || q.isLoading ? (
        <ListSkeleton rows={3} height="h-12" />
      ) : org.isError || q.isError ? (
        <ErrorBanner message="Your payouts did not load." onRetry={() => void q.refetch()} />
      ) : !rows.length ? (
        <EmptyState
          title="No payouts yet"
          hint="Milestones appear here once a signed deal names you on its team."
        />
      ) : (
        <>
          <div
            className="card mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-4"
            data-testid="money-summary"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-canvas text-teal">
              <Wallet size={18} strokeWidth={1.75} />
            </span>
            <p className="min-w-0 flex-1 basis-[220px] text-[15px] text-ink">
              <span className="t-num">{money(summary.released, summary.cur)}</span> released
              <span className="mx-2 text-umber">·</span>
              <span className="t-num">{money(summary.expected, summary.cur)}</span> expected
              {summary.latest
                ? ` by ${shortDate(summary.latest)}`
                : summary.onApproval
                  ? ' on approval'
                  : ''}
              {summary.latest && summary.onApproval && (
                <span className="text-umber"> (some on approval)</span>
              )}
              {summary.mixed && (
                <span className="ml-2 text-[12px] text-umber">(mixed currencies; see rows)</span>
              )}
            </p>
            {summary.simulated && (
              <span
                className="chip chip-warning"
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
              rowHeight={narrow ? 84 : 56}
              animateRows={false}
            />
          </div>
        </>
      )}
    </div>
  )
}
