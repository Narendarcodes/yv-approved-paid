/**
 * /payables: every milestone's money across the org's deals, for the brand and
 * deal managers. AG Grid (Community) with sorting, checkbox selection and CSV
 * export. One box filters and searches: it suggests the plain-language filters
 * as you type; what parses becomes an editable chip, anything else is a plain
 * text search over the rows. "Approve
 * selected" always shows a dry run (what would be captured, who gets how much)
 * before anything moves; the server re-applies policy and the tap rules.
 */
import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AgGridReact } from 'ag-grid-react'
import type {
  ColDef,
  ICellRendererParams,
  RowSelectionOptions,
  SelectionChangedEvent,
} from 'ag-grid-community'
import {
  AlertTriangle,
  CheckCircle2,
  CornerDownLeft,
  Download,
  Search,
  X,
  XCircle,
} from 'lucide-react'
import { yvGridTheme } from '../components/grid/agGrid'
import { payableStatus, shortDate, StatusPill, useNarrow } from '../components/grid/moneyGrid'
import { PageHeader } from '../components/ui'
import { EmptyState, ErrorBanner, ListSkeleton } from '../components/states'
import { Modal } from '../components/primitives'
import { useToast } from '../components/toast'
import { money, useDealOrg } from '../lib/deals'
import {
  daysToLapse,
  filtersToText,
  LAPSING_SOON_DAYS,
  matchesAll,
  parseClause,
  parseFilter,
  type PayableFilter,
} from '../lib/payablesFilter'
import * as api from '../services/api'
import type { BulkDryRun, BulkResult, PayableRow } from '../services/api'

const SUGGESTIONS = [
  'held over $300',
  'in grace',
  'failed checks',
  'lapsing soon',
  'waiting 3+ days',
  'ready to approve',
  'days left under 2',
]

function sumByCurrency(rows: { currency?: string; v: number }[]): string {
  const by: Record<string, number> = {}
  for (const r of rows) by[r.currency || 'USD'] = (by[r.currency || 'USD'] || 0) + r.v
  const parts = Object.entries(by).map(([c, v]) => money(v, c))
  return parts.length ? parts.join(' + ') : money(0)
}

/* ------------------------------------------------------------ cells */

function MilestoneCell(p: ICellRendererParams<PayableRow> & { showDeal?: boolean }) {
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
/** State, plus what needs an eye in the same cell: failed checks and a PayPal hold close to lapsing. */
function StatusCell(p: ICellRendererParams<PayableRow> & { nowMs: number }) {
  const r = p.data
  if (!r) return null
  const s = payableStatus(r.state, r.clockStatus)
  const left = daysToLapse(r.holdLapsesAt, p.nowMs)
  const lapsing = left != null && left <= LAPSING_SOON_DAYS
  return (
    <span className="flex h-full items-center gap-1.5">
      <StatusPill label={s.label} stage={s.stage} />
      {r.failedChecks > 0 && (
        <span className="chip chip-danger !px-2">{r.failedChecks} failed</span>
      )}
      {lapsing && (
        <span
          className="chip chip-warning !px-2"
          data-testid="lapse-warn"
          title={
            r.holdLapsesAt
              ? `PayPal hold lapses ${new Date(r.holdLapsesAt).toLocaleString()}`
              : undefined
          }
        >
          <AlertTriangle size={11} strokeWidth={2} />
          {left <= 0 ? 'Hold lapses today' : `Hold lapses in ${left}d`}
        </span>
      )}
    </span>
  )
}
/* ------------------------------------------------------------ chips */

function FilterChip({
  f,
  onRemove,
  onEdit,
}: {
  f: PayableFilter
  onRemove: () => void
  onEdit: (text: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(f.text)
  const unknown = f.kind === 'unknown'
  if (editing)
    return (
      <span className="chip chip-neutral !h-7 !pr-1">
        <input
          autoFocus
          aria-label={`Edit filter ${f.label}`}
          className="w-[180px] bg-transparent font-body text-[12px] text-ink outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setEditing(false)
              onEdit(draft)
            } else if (e.key === 'Escape') {
              setEditing(false)
              setDraft(f.text)
            }
          }}
          onBlur={() => {
            setEditing(false)
            if (draft !== f.text) onEdit(draft)
          }}
        />
      </span>
    )
  return (
    <span
      className={`chip ${unknown ? 'chip-neutral' : 'chip-teal'} !h-7 !pr-1`}
      data-testid="filter-chip"
      data-kind={f.kind}
    >
      <button
        type="button"
        className="max-w-[260px] truncate"
        onClick={() => {
          setDraft(f.text)
          setEditing(true)
        }}
        title={`Edit: ${f.text}`}
      >
        {unknown ? `“${f.text}”` : f.label}
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter ${f.label}`}
        className="flex h-5 w-5 items-center justify-center rounded-full hover:bg-ink/10"
      >
        <X size={12} strokeWidth={2.25} />
      </button>
    </span>
  )
}

/* ------------------------------------------------------------ approve dialog */

const OUTCOME: Record<string, { label: string; cls: string }> = {
  would_capture: { label: 'Captures now', cls: 'chip-success' },
  needs_tap: { label: 'Needs one more tap', cls: 'chip-warning' },
  blocked: { label: 'Blocked by policy', cls: 'chip-danger' },
  already_approved: { label: 'Already approved', cls: 'chip-neutral' },
  refused: { label: 'Not allowed', cls: 'chip-danger' },
  captured: { label: 'Captured', cls: 'chip-success' },
  waiting_for_tap: { label: 'Waiting for a tap', cls: 'chip-warning' },
  approved: { label: 'Approved', cls: 'chip-success' },
  error: { label: 'Failed', cls: 'chip-danger' },
}

function ApproveDialog({
  open,
  onClose,
  plan,
  result,
  busy,
  error,
  onConfirm,
}: {
  open: boolean
  onClose: () => void
  plan: BulkDryRun | null
  result: BulkResult | null
  busy: boolean
  error: string | null
  onConfirm: () => void
}) {
  const actionable =
    plan?.items.filter((i) => i.outcome === 'would_capture' || i.outcome === 'needs_tap') ?? []
  const nowTotal = sumByCurrency(
    (plan?.items ?? [])
      .filter((i) => i.outcome === 'would_capture')
      .map((i) => ({ currency: i.currency, v: i.captureMinor })),
  )
  const allTotal = plan
    ? Object.entries(plan.totals.captureByCurrency)
        .map(([c, v]) => money(v, c))
        .join(' + ') || money(0)
    : ''
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={result ? 'Approval results' : 'Approve selected: dry run'}
      width="max-w-2xl"
    >
      {!plan && !result ? (
        <ListSkeleton rows={2} height="h-14" />
      ) : result ? (
        <div data-testid="bulk-results">
          <ul className="divide-y divide-line rounded-xl border border-line">
            {result.items.map((r) => (
              <li
                key={`${r.dealId}:${r.milestoneKey}`}
                className="flex flex-wrap items-start gap-3 px-4 py-3"
              >
                {r.ok ? (
                  <CheckCircle2 size={16} className="mt-0.5 text-success" />
                ) : (
                  <XCircle size={16} className="mt-0.5 text-danger" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-ink">
                    {r.title || r.milestoneKey}{' '}
                    <span className="font-normal text-umber">· {r.dealTitle || r.dealId}</span>
                  </p>
                  <p className="text-[12px] text-umber">{r.message}</p>
                </div>
                <div className="text-right">
                  <span className={`chip ${OUTCOME[r.outcome]?.cls || 'chip-neutral'}`}>
                    {OUTCOME[r.outcome]?.label || r.outcome}
                  </span>
                  {r.capturedMinor > 0 && (
                    <p className="mt-1 t-num text-[13px]">{money(r.capturedMinor, r.currency)}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex justify-end">
            <button className="btn-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : plan ? (
        <div data-testid="bulk-dryrun">
          <p className="mb-3 text-[13px] text-umber">
            Nothing has moved yet. This is what approving would do, checked against the deal&apos;s
            policy. Amounts come from the signed shares.
          </p>
          <ul className="max-h-[42vh] divide-y divide-line overflow-y-auto rounded-xl border border-line">
            {plan.items.map((i) => (
              <li key={`${i.dealId}:${i.milestoneKey}`} className="px-4 py-3">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium text-ink">
                      {i.title || i.milestoneKey}{' '}
                      <span className="font-normal text-umber">· {i.dealTitle || i.dealId}</span>
                    </p>
                    <p className="text-[12px] text-umber">{i.message}</p>
                  </div>
                  <div className="text-right">
                    <span className={`chip ${OUTCOME[i.outcome]?.cls || 'chip-neutral'}`}>
                      {OUTCOME[i.outcome]?.label || i.outcome}
                    </span>
                    {i.captureMinor > 0 && (
                      <p className="mt-1 t-num text-[14px]">{money(i.captureMinor, i.currency)}</p>
                    )}
                  </div>
                </div>
                {i.payees.length > 0 &&
                  (i.outcome === 'would_capture' || i.outcome === 'needs_tap') && (
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {i.payees.map((p) => (
                        <li key={p.userId} className="chip chip-neutral">
                          {p.name} · {p.shareBp / 100}% · {money(p.amountMinor, i.currency)}
                        </li>
                      ))}
                    </ul>
                  )}
                {i.violations.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {i.violations.map((v) => (
                      <li key={v.rule + v.message} className="chip chip-danger" title={v.message}>
                        {v.rule}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          {plan.totals.byPerson.length > 0 && (
            <div className="mt-4">
              <p className="micro-label mb-1.5">Who gets how much</p>
              <ul
                className="divide-y divide-line rounded-xl border border-line"
                data-testid="bulk-per-person"
              >
                {plan.totals.byPerson.map((p) => (
                  <li
                    key={`${p.userId}:${p.currency}`}
                    className="flex items-center justify-between px-4 py-2 text-[13px]"
                  >
                    <span className="text-ink">{p.name}</span>
                    <span className="t-num">{money(p.amountMinor, p.currency)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-canvas px-4 py-3">
            <div>
              <p className="micro-label">Total</p>
              <p className="t-num text-[18px]" data-testid="bulk-total">
                {allTotal}
              </p>
              {actionable.some((i) => i.outcome === 'needs_tap') && (
                <p className="text-[12px] text-umber">
                  {nowTotal} captures now; the rest waits for one more tap above the deal&apos;s
                  limit.
                </p>
              )}
            </div>
            <div className="flex gap-2">
              <button className="btn-secondary" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                className="btn-primary"
                onClick={onConfirm}
                disabled={busy || !actionable.length}
                data-testid="bulk-confirm"
              >
                {busy ? 'Approving…' : `Approve ${actionable.length}`}
              </button>
            </div>
          </div>
          {error && (
            <p className="mt-3 text-[13px] text-danger" role="alert">
              {error}
            </p>
          )}
        </div>
      ) : null}
    </Modal>
  )
}

/* ------------------------------------------------------------ page */

export default function PayablesPage() {
  const org = useDealOrg()
  const orgId = org.data ?? null
  const qc = useQueryClient()
  const toast = useToast()
  const narrow = useNarrow()
  const gridRef = useRef<AgGridReact<PayableRow>>(null)
  const q = useQuery({
    queryKey: ['payables', orgId],
    queryFn: () => api.getPayables(orgId as string),
    enabled: !!orgId,
  })
  const [text, setText] = useState('')
  const [filters, setFilters] = useState<PayableFilter[]>([])
  const [focused, setFocused] = useState(false)
  const [hi, setHi] = useState(-1)
  const [selected, setSelected] = useState<PayableRow[]>([])
  const [dialog, setDialog] = useState(false)
  const [plan, setPlan] = useState<BulkDryRun | null>(null)
  const [result, setResult] = useState<BulkResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const rows = useMemo(() => q.data?.rows ?? [], [q.data])
  const nowMs = q.data?.asOf ? Date.parse(q.data.asOf) : Date.now()
  const shown = useMemo(
    () => rows.filter((r) => matchesAll(r, filters, nowMs)),
    [rows, filters, nowMs],
  )

  const apply = (next: PayableFilter[]) => {
    setFilters(next)
    setText(filtersToText(next))
  }
  const applyText = () => apply(parseFilter(text))
  // text that is not a filter searches the rows
  const quick = filters
    .filter((f) => f.kind === 'unknown')
    .map((f) => f.text)
    .join(' ')
  // suggest for the clause being typed (after the last "and" or comma)
  const parts = text.split(/\s*(?:,|\band\b)\s*/i)
  const typing = (parts[parts.length - 1] || '').trim().toLowerCase()
  const suggestions = SUGGESTIONS.filter(
    (x) => x.includes(typing) && !filters.some((f) => f.text.toLowerCase() === x),
  ).slice(0, 5)
  const pick = (x: string) => {
    const head = parts.slice(0, -1).filter(Boolean)
    apply(parseFilter([...head, x].join(' and ')))
    setHi(-1)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHi((i) => Math.min(i + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHi((i) => Math.max(i - 1, -1))
    } else if (e.key === 'Enter') {
      if (hi >= 0 && suggestions[hi]) pick(suggestions[hi])
      else applyText()
      setFocused(false)
    } else if (e.key === 'Escape') setFocused(false)
  }
  const showDeal = new Set(rows.map((r) => r.dealId)).size > 1

  // Deal, Team, Revisions, Failed and Hold age stay as hidden columns so the CSV keeps every field.
  const cols = useMemo<ColDef<PayableRow>[]>(
    () => [
      { headerName: 'Deal', field: 'dealTitle', hide: true },
      {
        headerName: 'Milestone',
        field: 'title',
        cellRenderer: MilestoneCell,
        cellRendererParams: { showDeal: showDeal && !narrow },
        minWidth: narrow ? 130 : 220,
        flex: 1.6,
      },
      {
        headerName: 'Team',
        colId: 'team',
        valueGetter: (p) => (p.data ? p.data.team.map((t) => t.name).join(', ') : ''),
        hide: true,
      },
      {
        headerName: 'Held',
        field: 'heldMinor',
        valueFormatter: (p) => (p.data ? money(p.value, p.data.currency) : ''),
        width: narrow ? 92 : 110,
        type: 'rightAligned',
        cellClass: 'ag-right-aligned-cell font-medium t-num',
      },
      {
        headerName: 'Status',
        colId: 'status',
        valueGetter: (p) => (p.data ? payableStatus(p.data.state, p.data.clockStatus).label : ''),
        cellRenderer: StatusCell,
        cellRendererParams: { nowMs },
        minWidth: narrow ? 150 : 260,
        flex: 1.2,
      },
      {
        headerName: 'Days left',
        field: 'businessDaysLeft',
        // only a clock that is still counting has days left
        valueGetter: (p) =>
          p.data &&
          p.data.businessDaysLeft != null &&
          (p.data.clockStatus === 'running' || p.data.clockStatus === 'paused')
            ? p.data.businessDaysLeft
            : null,
        valueFormatter: (p) => (p.value == null ? '—' : `${p.value}d`),
        width: 100,
        type: 'rightAligned',
        hide: narrow,
      },
      {
        headerName: 'Revisions',
        colId: 'revisions',
        valueGetter: (p) => (p.data ? p.data.revisionsUsed : 0),
        valueFormatter: (p) =>
          p.data ? `${p.data.revisionsUsed} / ${p.data.revisionsIncluded}` : '',
        hide: true,
      },
      { headerName: 'Failed', field: 'failedChecks', hide: true },
      {
        headerName: 'Hold age',
        field: 'holdAgeDays',
        valueFormatter: (p) =>
          p.data?.holdAgeDays == null
            ? ''
            : `${p.data.holdAgeDays}d (lapses ${shortDate(p.data.holdLapsesAt)})`,
        hide: true,
      },
      { headerName: 'Action', field: 'nextAction', minWidth: 170, flex: 1, hide: narrow },
    ],
    [narrow, nowMs, showDeal],
  )

  const rowSelection = useMemo<RowSelectionOptions<PayableRow>>(
    () => ({
      mode: 'multiRow',
      checkboxes: true,
      headerCheckbox: true,
      isRowSelectable: (n) => !!n.data?.approvable,
    }),
    [],
  )
  const onSelectionChanged = useCallback(
    (e: SelectionChangedEvent<PayableRow>) => setSelected(e.api.getSelectedRows()),
    [],
  )

  const openApprove = async () => {
    if (!orgId || !selected.length) return
    setPlan(null)
    setResult(null)
    setErr(null)
    setDialog(true)
    try {
      setPlan(
        await api.bulkApproveDryRun(
          orgId,
          selected.map((r) => ({ dealId: r.dealId, milestoneKey: r.milestoneKey })),
        ),
      )
    } catch (e) {
      setDialog(false)
      toast('danger', 'Dry run failed', e instanceof Error ? e.message : undefined)
    }
  }
  const confirm = async () => {
    if (!orgId || !plan) return
    setBusy(true)
    setErr(null)
    try {
      const items = plan.items
        .filter((i) => i.outcome === 'would_capture' || i.outcome === 'needs_tap')
        .map((i) => ({ dealId: i.dealId, milestoneKey: i.milestoneKey }))
      const r = await api.bulkApprove(orgId, items)
      setResult(r)
      gridRef.current?.api?.deselectAll()
      void qc.invalidateQueries({ queryKey: ['payables'] })
      void qc.invalidateQueries({ queryKey: ['deals'] })
      void qc.invalidateQueries({ queryKey: ['deal'] })
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Approving failed')
    } finally {
      setBusy(false)
    }
  }
  const exportCsv = () =>
    gridRef.current?.api?.exportDataAsCsv({
      fileName: `payables-${new Date().toISOString().slice(0, 10)}.csv`,
      allColumns: true,
      onlySelected: false,
      processCellCallback: (p) => {
        const id = p.column.getColId()
        const r = p.node?.data as PayableRow | undefined
        if (!r) return p.value
        if (id === 'heldMinor') return (r.heldMinor / 100).toFixed(2)
        if (id === 'failedChecks') return String(r.failedChecks)
        if (id === 'holdAgeDays')
          return r.holdAgeDays == null ? '' : `${r.holdAgeDays}d; lapses ${r.holdLapsesAt ?? ''}`
        if (id === 'businessDaysLeft')
          return r.businessDaysLeft == null ? '' : String(r.businessDaysLeft)
        if (id === 'revisions') return `${r.revisionsUsed}/${r.revisionsIncluded}`
        return p.formatValue ? p.formatValue(p.value) : p.value
      },
    })

  const heldTotal = sumByCurrency(shown.map((r) => ({ currency: r.currency, v: r.heldMinor })))
  const ready = shown.filter((r) => r.approvable).length

  return (
    <div className="fade-in" data-testid="payables-page">
      <PageHeader
        title="Payables"
        actions={
          <>
            <button
              className="btn-secondary"
              onClick={exportCsv}
              disabled={!rows.length}
              data-testid="export-csv"
            >
              <Download size={16} strokeWidth={1.75} />
              Export CSV
            </button>
            <button
              className="btn-primary"
              onClick={() => void openApprove()}
              disabled={!selected.length}
              title={
                rows.length && !rows.some((r) => r.approvable)
                  ? 'Only the brand on a deal approves its milestones'
                  : undefined
              }
              data-testid="approve-selected"
            >
              <CheckCircle2 size={16} strokeWidth={1.75} />
              Approve selected{selected.length ? ` (${selected.length})` : ''}
            </button>
          </>
        }
      />

      {org.isLoading || q.isLoading ? (
        <ListSkeleton rows={4} height="h-12" />
      ) : org.isError || q.isError ? (
        <ErrorBanner message="Payables did not load." onRetry={() => void q.refetch()} />
      ) : !rows.length ? (
        <EmptyState
          title="Nothing held"
          illustration="wallet"
          action={
            <Link to="/deals" className="btn-secondary !h-9 text-[13px]">
              Go to deals
            </Link>
          }
        />
      ) : (
        <>
          <div className="mb-4">
            <div className="relative">
              <label className="relative block">
                <span className="sr-only">Filter or search</span>
                <Search
                  size={16}
                  strokeWidth={1.5}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-umber"
                />
                <input
                  className="input !pl-9 !pr-11"
                  placeholder="Filter or search"
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value)
                    setHi(-1)
                    setFocused(true)
                  }}
                  onFocus={() => setFocused(true)}
                  onBlur={() => window.setTimeout(() => setFocused(false), 120)}
                  onKeyDown={onKey}
                  role="combobox"
                  aria-expanded={focused && suggestions.length > 0}
                  aria-controls="payables-suggest"
                  aria-autocomplete="list"
                  data-testid="nl-filter"
                />
              </label>
              <button
                className="icon-btn icon-btn-sm absolute right-1.5 top-1/2 -translate-y-1/2 text-umber"
                onClick={applyText}
                aria-label="Apply filter"
                title="Apply"
                data-testid="nl-apply"
              >
                <CornerDownLeft size={15} strokeWidth={1.5} />
              </button>
              {focused && suggestions.length > 0 && (
                <ul
                  id="payables-suggest"
                  role="listbox"
                  className="absolute left-0 right-0 z-20 mt-1 rounded-xl border border-line bg-surface p-1 shadow-pop"
                  data-testid="nl-suggestions"
                >
                  {suggestions.map((x, i) => (
                    <li key={x} role="option" aria-selected={i === hi}>
                      <button
                        type="button"
                        className={`menu-item w-full ${i === hi ? 'bg-ink/[0.045]' : ''}`}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          pick(x)
                          setFocused(false)
                        }}
                      >
                        {x}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {filters.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-live="polite">
                {filters.map((f, i) => (
                  <FilterChip
                    key={`${i}:${f.text}`}
                    f={f}
                    onRemove={() => apply(filters.filter((_, j) => j !== i))}
                    onEdit={(t) => {
                      const next = t.trim()
                        ? filters.map((x, j) => (j === i ? parseClause(t) : x))
                        : filters.filter((_, j) => j !== i)
                      apply(next)
                    }}
                  />
                ))}
                <button className="btn-ghost btn-xs" onClick={() => apply([])}>
                  Clear all
                </button>
              </div>
            )}
          </div>

          <p
            className="mb-2 text-[13px] text-umber"
            data-testid="payables-summary"
            title={`As of ${new Date(nowMs).toLocaleTimeString()}`}
          >
            <span className="t-num text-ink">{shown.length}</span> of {rows.length} milestones ·{' '}
            <span className="t-num text-ink">{heldTotal}</span> held ·{' '}
            <span className="t-num text-ink">{ready}</span> ready for your approval
          </p>

          {shown.length ? (
            <div className="yv-grid" data-testid="payables-grid">
              <AgGridReact<PayableRow>
                ref={gridRef}
                theme={yvGridTheme}
                rowData={shown}
                columnDefs={cols}
                defaultColDef={{ sortable: true, resizable: true, suppressMovable: true }}
                getRowId={(p) => `${p.data.dealId}:${p.data.milestoneKey}`}
                rowSelection={rowSelection}
                selectionColumnDef={{ width: 48, pinned: narrow ? undefined : 'left' }}
                onSelectionChanged={onSelectionChanged}
                quickFilterText={quick}
                domLayout={shown.length <= 25 ? 'autoHeight' : 'normal'}
                containerStyle={shown.length <= 25 ? undefined : { height: 640 }}
                animateRows={false}
              />
            </div>
          ) : (
            <EmptyState
              title="Nothing matches these filters"
              action={
                <button className="btn-secondary !h-9 text-[13px]" onClick={() => apply([])}>
                  Clear filters
                </button>
              }
            />
          )}
        </>
      )}

      <ApproveDialog
        open={dialog}
        onClose={() => setDialog(false)}
        plan={plan}
        result={result}
        busy={busy}
        error={err}
        onConfirm={() => void confirm()}
      />
    </div>
  )
}
