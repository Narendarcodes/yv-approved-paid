/**
 * Invoices: one scannable list of everything billed.
 *  - Studio invoices (the org invoice store; amounts in major units).
 *  - Change-order invoices drafted in PayPal from a deal (amounts in minor
 *    units from the signed rate card; read-only here, acted on in the deal).
 * Status filters, a mobile card layout and empty states per filter.
 * AI checks facts, people own taste, the deal decides the money.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Plus,
  Receipt,
  Send,
  CircleCheck,
  Ban,
  AlarmClock,
  Wallet,
  FileText,
  ArrowUpRight,
} from 'lucide-react'
import Chip, { Modal, StatCard, EmptyState } from '../components/primitives'
import { PageHeader } from '../components/ui'
import { ErrorBanner, ListSkeleton } from '../components/states'
import { useToast } from '../components/toast'
import { PaypalInvoiceId } from '../components/deals/common'
import { primaryOrgId, useProjects } from '../lib/data'
import {
  INVOICE_STATUS,
  dateOnly,
  dealOrgId,
  invoiceSent,
  money as moneyMinor,
  moneyMajor,
  type InvoiceStatus,
} from '../lib/deals'
import {
  createInvoice,
  invoiceAction,
  listDeals,
  listInvoices,
  type Invoice,
} from '../services/api'
import type { DealView } from '../contracts/types'
import { PAGE_LINE, EMPTY_LINE } from '../lib/copy'

/** Major units -> currency (kept as an export: ContractsPage uses it). */
export function money(amount: number, currency = 'INR') {
  return moneyMajor(amount, currency)
}

function plusDays(n: number) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

/** One row of the list, whatever store it came from. */
type Row = {
  key: string
  source: 'studio' | 'deal'
  number: string
  /** what was billed, one line */
  description: string
  billedTo: string
  amountLabel: string
  amountValue: number // major units, for totals
  currency: string
  status: InvoiceStatus
  issued?: string | null
  due?: string | null
  paidAt?: string | null
  inv?: Invoice
  dealId?: string
}

const FILTERS: ('all' | InvoiceStatus)[] = ['all', 'draft', 'sent', 'overdue', 'paid', 'void']

function isOverdue(inv: Invoice) {
  if (inv.status === 'overdue') return true
  if (inv.status !== 'sent' || !inv.dueDate) return false
  return new Date(inv.dueDate).getTime() < Date.now()
}

function dealRows(deals: DealView[]): Row[] {
  const rows: Row[] = []
  for (const d of deals) {
    for (const co of d.changeOrders ?? []) {
      if (co.status !== 'invoiced' || !co.invoiceId) continue
      const item = d.terms.rateCard.find((r) => r.id === co.rateCardItemId)
      const ms = d.terms.milestones.find((m) => m.key === co.milestoneKey)
      rows.push({
        key: `deal:${d.id}:${co.id}`,
        source: 'deal',
        number: co.invoiceId,
        description: `${co.quantity} × ${item?.label ?? co.rateCardItemId} @ ${moneyMinor(item?.unitPriceMinor, d.terms.currency)}`,
        billedTo: `Client · ${ms?.title ?? d.terms.title}`,
        amountLabel: moneyMinor(co.amountMinor, d.terms.currency),
        amountValue: co.amountMinor / 100,
        currency: d.terms.currency,
        status: invoiceSent(co.invoiceId) ? 'sent' : 'draft', // PayPal sandbox creates and sends it; the mock only drafts
        issued: co.decidedAt ?? co.at,
        dealId: d.id,
      })
    }
  }
  return rows
}

/** "₹12,000 + $60.00": totals stay per currency, never mixed. */
function sumByCurrency(rows: Row[]) {
  const by = new Map<string, number>()
  for (const r of rows) by.set(r.currency, (by.get(r.currency) ?? 0) + r.amountValue)
  if (!by.size) return moneyMajor(0, 'USD')
  return [...by.entries()].map(([c, n]) => moneyMajor(Math.round(n * 100) / 100, c)).join(' + ')
}

export default function InvoicesPage() {
  const toast = useToast()
  const { projects } = useProjects()
  const [orgId, setOrgId] = useState<string | null>(null)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [deals, setDeals] = useState<DealView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | InvoiceStatus>('all')
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    number: '',
    projectId: '',
    amount: '',
    currency: 'INR',
    dueDate: plusDays(30),
    note: '',
  })

  const load = useCallback(async () => {
    setError(false)
    try {
      const id = orgId ?? (await primaryOrgId())
      if (!id) throw new Error('no org')
      setOrgId(id)
      const dealOrg = await dealOrgId().catch(() => id)
      const [list, dl] = await Promise.allSettled([listInvoices(id), listDeals(dealOrg ?? id)])
      if (list.status === 'rejected' && dl.status === 'rejected') throw list.reason
      setInvoices(list.status === 'fulfilled' ? list.value : [])
      setDeals(dl.status === 'fulfilled' ? dl.value : [])
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [orgId])

  useEffect(() => {
    void load()
  }, [load])

  const projectTitle = useCallback(
    (pid?: string | null) => projects.find((p) => p.id === pid)?.title,
    [projects],
  )

  const rows: Row[] = useMemo(() => {
    const studio: Row[] = invoices.map((inv) => ({
      key: `inv:${inv.id}`,
      source: 'studio',
      number: inv.number,
      description: inv.note || 'Studio invoice',
      billedTo: projectTitle(inv.projectId) ?? 'No project',
      amountLabel: moneyMajor(inv.amount, inv.currency),
      amountValue: inv.amount,
      currency: inv.currency,
      status: isOverdue(inv) ? 'overdue' : inv.status,
      issued: inv.issuedAt,
      due: inv.dueDate,
      paidAt: inv.paidAt,
      inv,
    }))
    return [...studio, ...dealRows(deals)].sort(
      (a, b) => new Date(b.issued ?? 0).getTime() - new Date(a.issued ?? 0).getTime(),
    )
  }, [invoices, deals, projectTitle])

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length }
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1
    return c
  }, [rows])
  const shown = filter === 'all' ? rows : rows.filter((r) => r.status === filter)
  const outstanding = rows.filter((r) => r.status === 'sent' || r.status === 'overdue')

  const openNew = () => {
    const n = invoices.length + 1
    setForm({
      number: `INV-${String(n).padStart(4, '0')}`,
      projectId: projects[0]?.id ?? '',
      amount: '',
      currency: 'INR',
      dueDate: plusDays(30),
      note: '',
    })
    setOpen(true)
  }

  const submit = async () => {
    if (!orgId || !form.number.trim() || !form.amount) return
    try {
      await createInvoice(orgId, {
        number: form.number.trim(),
        amount: Number(form.amount),
        currency: form.currency,
        dueDate: form.dueDate ? new Date(form.dueDate).toISOString() : null,
        note: form.note,
        projectId: form.projectId || null,
      })
      setOpen(false)
      toast('success', 'Invoice created', `${form.number} saved as a draft.`)
      void load()
    } catch (err: any) {
      toast('danger', 'Could not create invoice', err?.message || 'Try again')
    }
  }

  const act = async (inv: Invoice, action: 'send' | 'pay' | 'void') => {
    if (!orgId) return
    setBusyId(inv.id)
    try {
      await invoiceAction(
        orgId,
        inv.id,
        action,
        action === 'pay' ? { paymentMethod: 'Bank transfer' } : undefined,
      )
      toast(
        'success',
        action === 'pay'
          ? 'Payment recorded'
          : action === 'send'
            ? 'Invoice sent'
            : 'Invoice voided',
        inv.number,
      )
      await load()
    } catch (err: any) {
      toast('danger', 'Action failed', err?.message || 'Try again')
    } finally {
      setBusyId(null)
    }
  }

  const actions = (r: Row) => {
    if (r.source === 'deal')
      return (
        <Link
          to={`/deals/${encodeURIComponent(r.dealId!)}`}
          className="btn-secondary btn-xs"
          data-testid="open-deal-invoice"
        >
          Open deal <ArrowUpRight size={13} strokeWidth={2} />
        </Link>
      )
    const inv = r.inv!
    const busy = busyId === inv.id
    return (
      <>
        {inv.status === 'draft' && (
          <button
            className="btn-primary btn-xs"
            disabled={busy}
            onClick={() => void act(inv, 'send')}
            data-testid="send-invoice"
          >
            <Send size={13} strokeWidth={1.75} /> Send
          </button>
        )}
        {(inv.status === 'sent' || inv.status === 'overdue') && (
          <button
            className="btn-primary btn-xs"
            disabled={busy}
            onClick={() => void act(inv, 'pay')}
            data-testid="pay-invoice"
          >
            <CircleCheck size={13} strokeWidth={1.75} /> Mark paid
          </button>
        )}
        {inv.status !== 'paid' && inv.status !== 'void' && (
          <button
            className="btn-ghost btn-xs"
            disabled={busy}
            onClick={() => void act(inv, 'void')}
            aria-label={`Void ${inv.number}`}
            title="Void"
          >
            <Ban size={13} strokeWidth={1.75} />
          </button>
        )}
      </>
    )
  }

  const dateCell = (r: Row) =>
    r.status === 'paid' ? (
      <span className="text-st-live">Paid {dateOnly(r.paidAt)}</span>
    ) : r.status === 'overdue' ? (
      <span className="text-danger">Was due {dateOnly(r.due)}</span>
    ) : r.due ? (
      <span>Due {dateOnly(r.due)}</span>
    ) : (
      <span className="text-umber">No due date</span>
    )

  const statusChip = (s: InvoiceStatus) => (
    <span title={INVOICE_STATUS[s].hint}>
      <Chip label={INVOICE_STATUS[s].label} tone={INVOICE_STATUS[s].tone} dot />
    </span>
  )

  const numberCell = (r: Row) =>
    r.source === 'deal' ? (
      <PaypalInvoiceId id={r.number} />
    ) : (
      <span className="font-mono text-[13px] font-medium text-ink">{r.number}</span>
    )

  return (
    <div className="fade-in">
      <PageHeader
        title="Invoices"
        subtitle={PAGE_LINE['/invoices']}
        actions={
          <button className="btn-primary" onClick={openNew} data-testid="new-invoice">
            <Plus size={15} strokeWidth={1.75} /> New invoice
          </button>
        }
      />

      <section className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Outstanding"
          value={sumByCurrency(outstanding)}
          icon={<Wallet size={18} strokeWidth={1.75} />}
        />
        <StatCard
          label="Overdue"
          value={sumByCurrency(rows.filter((r) => r.status === 'overdue'))}
          icon={<AlarmClock size={18} strokeWidth={1.75} />}
          tone="danger"
        />
        <StatCard
          label="Paid"
          value={sumByCurrency(rows.filter((r) => r.status === 'paid'))}
          icon={<CircleCheck size={18} strokeWidth={1.75} />}
          tone="success"
        />
        <StatCard
          label="Drafts"
          value={sumByCurrency(rows.filter((r) => r.status === 'draft'))}
          icon={<FileText size={18} strokeWidth={1.75} />}
          tone="warning"
        />
      </section>

      {error ? (
        <ErrorBanner onRetry={() => void load()} message="Couldn't load invoices." />
      ) : loading ? (
        <ListSkeleton rows={4} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Receipt size={22} strokeWidth={1.75} />}
          title="No invoices yet"
          description={EMPTY_LINE.invoices}
          action={
            <button className="btn-primary" onClick={openNew}>
              New invoice
            </button>
          }
        />
      ) : (
        <>
          <div className="mb-3 -mx-1 overflow-x-auto px-1 pb-1">
            <div
              className="seg"
              role="tablist"
              aria-label="Filter by status"
              data-testid="invoice-filters"
            >
              {FILTERS.map((f) => (
                <button
                  key={f}
                  role="tab"
                  aria-selected={filter === f}
                  onClick={() => setFilter(f)}
                  className="whitespace-nowrap"
                >
                  {f === 'all' ? 'All' : INVOICE_STATUS[f].label}
                  <span className="ml-1.5 font-mono text-xs opacity-70">{counts[f] ?? 0}</span>
                </button>
              ))}
            </div>
          </div>

          {shown.length === 0 ? (
            <div
              className="card flex flex-col items-center px-6 py-10 text-center"
              data-testid="invoices-filter-empty"
            >
              <p className="t-title">
                No{' '}
                {filter === 'all'
                  ? ''
                  : INVOICE_STATUS[filter as InvoiceStatus].label.toLowerCase()}{' '}
                invoices
              </p>
              <p className="mt-1 text-[13px] text-umber">
                {filter === 'overdue' ? 'Nothing is late. Nice.' : 'Try another status.'}
              </p>
              <button className="btn-ghost btn-xs mt-3" onClick={() => setFilter('all')}>
                Show all
              </button>
            </div>
          ) : (
            <>
              {/* desktop: table */}
              <div className="card hidden overflow-hidden p-0 md:block">
                <table className="w-full text-left text-sm" data-testid="invoices-table">
                  <thead className="border-b border-line bg-canvas/60">
                    <tr>
                      <th className="table-head">Invoice</th>
                      <th className="table-head">Billed to</th>
                      <th className="table-head">Status</th>
                      <th className="table-head">Issued</th>
                      <th className="table-head">Due</th>
                      <th className="table-head text-right">Amount</th>
                      <th className="table-head text-right">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {shown.map((r) => (
                      <tr
                        key={r.key}
                        className="align-top transition-colors hover:bg-ink/[0.02]"
                        data-testid={`invoice-${r.number}`}
                      >
                        <td className="max-w-[300px] px-5 py-3.5">
                          {numberCell(r)}
                          <p className="mt-0.5 truncate text-xs text-umber" title={r.description}>
                            {r.description}
                          </p>
                        </td>
                        <td className="px-5 py-3.5 text-[13px] text-ink/85">{r.billedTo}</td>
                        <td className="px-5 py-3.5">{statusChip(r.status)}</td>
                        <td className="whitespace-nowrap px-5 py-3.5 text-[13px] text-ink/80">
                          {dateOnly(r.issued)}
                        </td>
                        <td className="whitespace-nowrap px-5 py-3.5 text-[13px] text-ink/80">
                          {dateCell(r)}
                        </td>
                        <td className="t-num whitespace-nowrap px-5 py-3.5 text-right !text-[14px]">
                          {r.amountLabel}
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex justify-end gap-1.5">{actions(r)}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* mobile: cards */}
              <ul className="space-y-3 md:hidden" data-testid="invoices-cards">
                {shown.map((r) => (
                  <li key={r.key} className="card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        {numberCell(r)}
                        <p className="mt-0.5 truncate text-xs text-umber">{r.description}</p>
                      </div>
                      <p className="t-num shrink-0 text-[17px]">{r.amountLabel}</p>
                    </div>
                    <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-umber">
                      {statusChip(r.status)}
                      <span>{r.billedTo}</span>
                      <span>{dateCell(r)}</span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">{actions(r)}</div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="New invoice">
        <div className="space-y-3 px-6 py-5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="inv-number">
                Number
              </label>
              <input
                id="inv-number"
                className="input font-mono"
                value={form.number}
                onChange={(e) => setForm({ ...form, number: e.target.value })}
              />
            </div>
            <div>
              <label className="label" htmlFor="inv-project">
                Project
              </label>
              <select
                id="inv-project"
                className="input"
                value={form.projectId}
                onChange={(e) => setForm({ ...form, projectId: e.target.value })}
              >
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="inv-amount">
                Amount
              </label>
              <input
                id="inv-amount"
                type="number"
                min={0}
                step="0.01"
                className="input"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
              />
            </div>
            <div>
              <label className="label" htmlFor="inv-currency">
                Currency
              </label>
              <select
                id="inv-currency"
                className="input"
                value={form.currency}
                onChange={(e) => setForm({ ...form, currency: e.target.value })}
              >
                {['INR', 'USD', 'EUR', 'GBP'].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
            <div className="col-span-2">
              <label className="label" htmlFor="inv-due">
                Due date
              </label>
              <input
                id="inv-due"
                type="date"
                className="input w-auto"
                value={form.dueDate}
                onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
              />
            </div>
            <div className="col-span-2">
              <label className="label" htmlFor="inv-note">
                What it is for
              </label>
              <input
                id="inv-note"
                className="input"
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                placeholder="e.g. 4 reels + 2 carousels, October"
              />
            </div>
          </div>
          {form.amount && Number(form.amount) > 0 && (
            <p className="text-[13px] text-umber">
              Total{' '}
              <span className="t-num text-ink">
                {moneyMajor(Number(form.amount), form.currency)}
              </span>
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button className="btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={() => void submit()}
              disabled={!form.number.trim() || !form.amount}
              data-testid="create-invoice"
            >
              Create draft
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
