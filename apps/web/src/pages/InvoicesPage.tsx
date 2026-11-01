import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Receipt, Send, CircleCheck, Ban, AlarmClock, Wallet } from 'lucide-react'
import Chip, { Modal, StatCard, EmptyState } from '../components/primitives'
import { PageHeader } from '../components/ui'
import { ErrorBanner, ListSkeleton } from '../components/states'
import { useToast } from '../components/toast'
import { primaryOrgId, useProjects } from '../lib/data'
import {
  createInvoice,
  invoiceAction,
  listInvoices,
  outstandingInvoices,
  type Invoice,
  type OutstandingSummary,
} from '../services/api'

export function money(amount: number, currency = 'INR') {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount)
  } catch {
    return `${currency} ${amount.toLocaleString()}`
  }
}
function shortDate(iso?: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}
const STATUS_TONE: Record<Invoice['status'], 'neutral' | 'warning' | 'teal' | 'danger'> = {
  draft: 'neutral',
  sent: 'warning',
  paid: 'teal',
  overdue: 'danger',
  void: 'neutral',
}
function plusDays(n: number) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

export default function InvoicesPage() {
  const toast = useToast()
  const { projects } = useProjects()
  const [orgId, setOrgId] = useState<string | null>(null)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [summary, setSummary] = useState<OutstandingSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ number: '', projectId: '', amount: '', currency: 'INR', dueDate: plusDays(30), note: '' })

  const load = useCallback(async () => {
    setError(false)
    try {
      const id = orgId ?? (await primaryOrgId())
      if (!id) throw new Error('no org')
      setOrgId(id)
      const [list, out] = await Promise.all([listInvoices(id), outstandingInvoices(id)])
      setInvoices(list)
      setSummary(out)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [orgId])

  useEffect(() => {
    void load()
  }, [load])

  const projectTitle = (pid?: string | null) => projects.find((p) => p.id === pid)?.title ?? '—'
  const paid = useMemo(() => invoices.filter((i) => i.status === 'paid'), [invoices])
  const currency = invoices[0]?.currency ?? 'INR'

  const openNew = () => {
    const n = invoices.length + 1
    setForm({ number: `INV-${String(n).padStart(4, '0')}`, projectId: projects[0]?.id ?? '', amount: '', currency: 'INR', dueDate: plusDays(30), note: '' })
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
      await invoiceAction(orgId, inv.id, action, action === 'pay' ? { paymentMethod: 'Bank transfer' } : undefined)
      toast('success', action === 'pay' ? 'Payment recorded' : action === 'send' ? 'Invoice sent' : 'Invoice voided', inv.number)
      await load()
    } catch (err: any) {
      toast('danger', 'Action failed', err?.message || 'Try again')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="fade-in">
      <PageHeader
        title="Invoices"
        subtitle="Bill clients per project, track what is outstanding and get paid on time."
        actions={
          <button className="btn-primary" onClick={openNew} data-testid="new-invoice">
            <Plus size={15} strokeWidth={1.75} /> New invoice
          </button>
        }
      />

      <section className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Outstanding" value={money(summary?.totalOutstanding ?? 0, currency)} icon={<Wallet size={18} strokeWidth={1.75} />} />
        <StatCard label="Overdue" value={money(summary?.overdue.amount ?? 0, currency)} icon={<AlarmClock size={18} strokeWidth={1.75} />} tone="danger" />
        <StatCard label="Paid" value={money(paid.reduce((s, i) => s + i.amount, 0), currency)} icon={<CircleCheck size={18} strokeWidth={1.75} />} tone="success" />
        <StatCard label="Open invoices" value={summary?.invoiceCount ?? 0} icon={<Receipt size={18} strokeWidth={1.75} />} tone="warning" />
      </section>

      {error ? (
        <ErrorBanner onRetry={() => void load()} message="Couldn't load invoices." />
      ) : loading ? (
        <ListSkeleton rows={4} />
      ) : invoices.length === 0 ? (
        <EmptyState
          icon={<Receipt size={22} strokeWidth={1.75} />}
          title="No invoices yet"
          description="Create an invoice when a project is delivered - yv. tracks due dates and flags anything overdue."
          action={<button className="btn-primary" onClick={openNew}>New invoice</button>}
        />
      ) : (
        <div className="card overflow-hidden p-0">
          <table className="w-full text-left text-sm">
            <thead className="micro-label border-b border-line bg-canvas/60">
              <tr>
                <th className="px-5 py-3 font-medium">Invoice</th>
                <th className="px-5 py-3 font-medium">Project</th>
                <th className="px-5 py-3 font-medium text-right">Amount</th>
                <th className="px-5 py-3 font-medium">Due</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {invoices.map((inv) => (
                <tr key={inv.id} className="transition-colors hover:bg-ink/[0.02]" data-testid={`invoice-${inv.number}`}>
                  <td className="px-5 py-3.5">
                    <p className="font-mono text-[13px] font-medium text-ink">{inv.number}</p>
                    {inv.note && <p className="mt-0.5 max-w-[260px] truncate text-xs text-umber">{inv.note}</p>}
                  </td>
                  <td className="px-5 py-3.5 text-ink/80">{projectTitle(inv.projectId)}</td>
                  <td className="px-5 py-3.5 text-right font-mono text-[13px] text-ink">{money(inv.amount, inv.currency)}</td>
                  <td className="px-5 py-3.5 text-ink/80">{inv.status === 'paid' ? `Paid ${shortDate(inv.paidAt)}` : shortDate(inv.dueDate)}</td>
                  <td className="px-5 py-3.5">
                    <Chip label={inv.status} tone={STATUS_TONE[inv.status]} dot />
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex justify-end gap-1.5">
                      {inv.status === 'draft' && (
                        <button className="btn-secondary btn-sm" disabled={busyId === inv.id} onClick={() => void act(inv, 'send')} data-testid="send-invoice">
                          <Send size={13} strokeWidth={1.75} /> Send
                        </button>
                      )}
                      {(inv.status === 'sent' || inv.status === 'overdue') && (
                        <button className="btn-primary btn-sm" disabled={busyId === inv.id} onClick={() => void act(inv, 'pay')} data-testid="pay-invoice">
                          <CircleCheck size={13} strokeWidth={1.75} /> Mark paid
                        </button>
                      )}
                      {inv.status !== 'paid' && inv.status !== 'void' && (
                        <button className="btn-ghost btn-sm" disabled={busyId === inv.id} onClick={() => void act(inv, 'void')} aria-label={`Void ${inv.number}`}>
                          <Ban size={13} strokeWidth={1.75} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="New invoice">
        <div className="space-y-3 px-6 py-5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="inv-number">Number</label>
              <input id="inv-number" className="input font-mono" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="inv-project">Project</label>
              <select id="inv-project" className="input" value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.title}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="inv-amount">Amount</label>
              <input id="inv-amount" type="number" min={0} className="input" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="inv-currency">Currency</label>
              <select id="inv-currency" className="input" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                {['INR', 'USD', 'EUR', 'GBP'].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
            <div className="col-span-2">
              <label className="label" htmlFor="inv-due">Due date</label>
              <input id="inv-due" type="date" className="input w-auto" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
            </div>
            <div className="col-span-2">
              <label className="label" htmlFor="inv-note">Note</label>
              <input id="inv-note" className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="e.g. 4 reels + 2 carousels, October" />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn-primary" onClick={() => void submit()} disabled={!form.number.trim() || !form.amount} data-testid="create-invoice">
              Create draft
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
