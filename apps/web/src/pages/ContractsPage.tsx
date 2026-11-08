import { useCallback, useEffect, useState } from 'react'
import { Plus, FileSignature, Send, Eye, PenLine, Check } from 'lucide-react'
import Chip, { Modal, EmptyState } from '../components/primitives'
import { PageHeader } from '../components/ui'
import { ErrorBanner, ListSkeleton } from '../components/states'
import { useToast } from '../components/toast'
import { primaryOrgId, useProjects } from '../lib/data'
import {
  contractAction,
  createContract,
  listContracts,
  signContract,
  type Contract,
} from '../services/api'
import { money } from './InvoicesPage'

const STEPS: Contract['status'][] = ['draft', 'sent', 'viewed', 'signed']

export default function ContractsPage() {
  const toast = useToast()
  const { projects } = useProjects()
  const [orgId, setOrgId] = useState<string | null>(null)
  const [contracts, setContracts] = useState<Contract[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    title: '',
    sentTo: '',
    amount: '',
    currency: 'INR',
    projectId: '',
    terms: '',
  })
  const [signing, setSigning] = useState<Contract | null>(null)
  const [signer, setSigner] = useState({ name: '', email: '' })

  const load = useCallback(async () => {
    setError(false)
    try {
      const id = orgId ?? (await primaryOrgId())
      if (!id) throw new Error('no org')
      setOrgId(id)
      setContracts(await listContracts(id))
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [orgId])

  useEffect(() => {
    void load()
  }, [load])

  const projectTitle = (pid?: string | null) => projects.find((p) => p.id === pid)?.title

  const submit = async () => {
    if (!orgId || !form.title.trim()) return
    try {
      await createContract(orgId, {
        title: form.title.trim(),
        sentTo: form.sentTo.trim(),
        amount: Number(form.amount || 0),
        currency: form.currency,
        terms: form.terms,
        projectId: form.projectId || null,
      })
      setOpen(false)
      toast('success', 'Contract drafted', form.title.trim())
      void load()
    } catch (err: any) {
      toast('danger', 'Could not create contract', err?.message || 'Try again')
    }
  }

  const act = async (c: Contract, action: 'send' | 'view') => {
    if (!orgId) return
    setBusyId(c.id)
    try {
      await contractAction(orgId, c.id, action)
      toast('success', action === 'send' ? 'Contract sent' : 'Marked as viewed', c.title)
      await load()
    } catch (err: any) {
      toast('danger', 'Action failed', err?.message || 'Try again')
    } finally {
      setBusyId(null)
    }
  }

  const sign = async () => {
    if (!orgId || !signing || !signer.name.trim() || !signer.email.trim()) return
    try {
      await signContract(orgId, signing.id, signer.name.trim(), signer.email.trim())
      toast('success', 'Contract signed', `${signing.title} · ${signer.name.trim()}`)
      setSigning(null)
      void load()
    } catch (err: any) {
      toast('danger', 'Could not sign', err?.message || 'Check the signer email')
    }
  }

  return (
    <div className="fade-in">
      <PageHeader
        title="Contracts"
        subtitle="Send scopes and retainers, see when clients open them, and capture the signature - all next to the work."
        actions={
          <button
            className="btn-primary"
            onClick={() => {
              setForm({
                title: '',
                sentTo: '',
                amount: '',
                currency: 'INR',
                projectId: projects[0]?.id ?? '',
                terms: '',
              })
              setOpen(true)
            }}
          >
            <Plus size={15} strokeWidth={1.75} /> New contract
          </button>
        }
      />

      {error ? (
        <ErrorBanner onRetry={() => void load()} message="Couldn't load contracts." />
      ) : loading ? (
        <ListSkeleton rows={3} height="h-24" />
      ) : contracts.length === 0 ? (
        <EmptyState
          icon={<FileSignature size={22} strokeWidth={1.75} />}
          title="No contracts yet"
          description="Draft a scope of work, send it to your client and capture their signature here."
        />
      ) : (
        <div className="space-y-3">
          {contracts.map((c) => {
            const step = STEPS.indexOf(c.status)
            return (
              <article
                key={c.id}
                className="card flex flex-wrap items-center gap-5 p-5"
                data-testid={`contract-${c.id}`}
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-tint text-teal">
                  <FileSignature size={18} strokeWidth={1.75} />
                </span>
                <div className="min-w-[220px] flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-headline text-[15px] font-semibold tracking-tight text-ink">
                      {c.title}
                    </h3>
                    <Chip
                      label={c.status}
                      tone={
                        c.status === 'signed'
                          ? 'teal'
                          : c.status === 'draft'
                            ? 'neutral'
                            : 'warning'
                      }
                      dot
                    />
                  </div>
                  <p className="mt-0.5 text-xs text-umber">
                    {[
                      c.sentTo,
                      projectTitle(c.projectId),
                      c.amount ? money(c.amount, c.currency) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {c.status === 'signed' && c.signerName && (
                    <p className="mt-1 font-mono text-[11px] text-teal">Signed by {c.signerName}</p>
                  )}
                </div>
                <ol className="flex items-center gap-1.5" aria-label="Contract progress">
                  {STEPS.map((s, i) => (
                    <li key={s} className="flex items-center gap-1.5">
                      <span
                        className={`flex h-5 items-center gap-1 rounded-full px-2 text-[10px] ${
                          i <= step ? 'bg-teal text-on-accent' : 'bg-ink/5 text-label'
                        }`}
                      >
                        {i < step && <Check size={10} strokeWidth={3} />}
                        {s}
                      </span>
                      {i < STEPS.length - 1 && (
                        <span className={`h-px w-3 ${i < step ? 'bg-teal' : 'bg-line'}`} />
                      )}
                    </li>
                  ))}
                </ol>
                <div className="flex gap-1.5">
                  {c.status === 'draft' && (
                    <button
                      className="btn-secondary btn-sm"
                      disabled={busyId === c.id}
                      onClick={() => void act(c, 'send')}
                    >
                      <Send size={13} strokeWidth={1.75} /> Send
                    </button>
                  )}
                  {c.status === 'sent' && (
                    <button
                      className="btn-ghost btn-sm"
                      disabled={busyId === c.id}
                      onClick={() => void act(c, 'view')}
                    >
                      <Eye size={13} strokeWidth={1.75} /> Mark viewed
                    </button>
                  )}
                  {c.status !== 'signed' && c.status !== 'draft' && (
                    <button
                      className="btn-primary btn-sm"
                      onClick={() => {
                        setSigner({ name: '', email: c.sentTo || '' })
                        setSigning(c)
                      }}
                    >
                      <PenLine size={13} strokeWidth={1.75} /> Sign
                    </button>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="New contract">
        <div className="space-y-3 px-6 py-5">
          <div>
            <label className="label" htmlFor="ct-title">
              Title
            </label>
            <input
              id="ct-title"
              className="input"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="e.g. Q4 social retainer"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="ct-to">
                Client email
              </label>
              <input
                id="ct-to"
                className="input"
                value={form.sentTo}
                onChange={(e) => setForm({ ...form, sentTo: e.target.value })}
              />
            </div>
            <div>
              <label className="label" htmlFor="ct-project">
                Project
              </label>
              <select
                id="ct-project"
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
              <label className="label" htmlFor="ct-amount">
                Value
              </label>
              <input
                id="ct-amount"
                type="number"
                min={0}
                className="input"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
              />
            </div>
            <div>
              <label className="label" htmlFor="ct-cur">
                Currency
              </label>
              <select
                id="ct-cur"
                className="input"
                value={form.currency}
                onChange={(e) => setForm({ ...form, currency: e.target.value })}
              >
                {['INR', 'USD', 'EUR', 'GBP'].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="label" htmlFor="ct-terms">
              Terms
            </label>
            <textarea
              id="ct-terms"
              rows={3}
              className="input w-full"
              value={form.terms}
              onChange={(e) => setForm({ ...form, terms: e.target.value })}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button className="btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={() => void submit()}
              disabled={!form.title.trim()}
            >
              Save draft
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!signing}
        onClose={() => setSigning(null)}
        title={`Sign · ${signing?.title ?? ''}`}
      >
        <div className="space-y-3 px-6 py-5">
          <p className="text-sm text-umber">
            The signer&apos;s name and email are recorded with a timestamp.
          </p>
          <div>
            <label className="label" htmlFor="sg-name">
              Full name
            </label>
            <input
              id="sg-name"
              className="input"
              value={signer.name}
              onChange={(e) => setSigner({ ...signer, name: e.target.value })}
            />
          </div>
          <div>
            <label className="label" htmlFor="sg-email">
              Email
            </label>
            <input
              id="sg-email"
              type="email"
              className="input"
              value={signer.email}
              onChange={(e) => setSigner({ ...signer, email: e.target.value })}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button className="btn-ghost" onClick={() => setSigning(null)}>
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={() => void sign()}
              disabled={!signer.name.trim() || !signer.email.trim()}
            >
              Sign contract
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
