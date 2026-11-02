/**
 * ChangeOrderCard: an out-of-scope ask, priced from the SIGNED rate card
 * (qty x unit price; the API computed it, the UI only shows it), laid out as
 * the invoice it becomes. The client accepts or declines with one tap;
 * accepting drafts the PayPal invoice through policy and unlocks one extra round.
 *
 * Buttons (client, draft only): Accept / Decline -> POST .../change-orders/:coId/accept|decline.
 * AI checks facts, people own taste, the deal decides the money.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, Check, Copy, ShieldCheck, X } from 'lucide-react'
import Chip from '../primitives'
import { useToast } from '../toast'
import * as api from '../../services/api'
import type { DealView } from '../../contracts/types'
import { INVOICE_STATUS, changeOrderStage, dateOnly, money, roleWord, when } from '../../lib/deals'
import { DealCardShell, PaypalInvoiceId } from './common'

const STEPS = ['Requested', 'Accepted', 'Invoiced'] as const

export default function ChangeOrderCard({
  deal,
  orgId,
  changeOrderId,
  onChanged,
}: {
  deal: DealView
  orgId: string
  changeOrderId: string
  onChanged?: () => void
}) {
  const toast = useToast()
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null)
  const co = deal.changeOrders.find((c) => c.id === changeOrderId)
  if (!co) return null
  const item = deal.terms.rateCard.find((r) => r.id === co.rateCardItemId)
  const ms = deal.terms.milestones.find((m) => m.key === co.milestoneKey)
  const cur = deal.terms.currency
  const stage = changeOrderStage(co)
  const canDecide = deal.me === 'client' && co.status === 'draft'
  const declined = co.status === 'declined'
  const step = co.status === 'invoiced' ? 2 : co.status === 'accepted' ? 1 : 0
  const unit = item?.unitPriceMinor
  const by = co.by === 'agent' ? 'Scope Agent' : roleWord(co.by)

  const decide = async (verb: 'accept' | 'decline') => {
    setBusy(verb)
    try {
      const r = await api.decideChangeOrder(orgId, deal.id, co.id, verb)
      const inv = r.deal.changeOrders.find((c) => c.id === co.id)?.invoiceId
      toast(
        'success',
        verb === 'accept' ? 'Change order accepted' : 'Change order declined',
        verb === 'accept' ? (inv ? `PayPal invoice ${inv} drafted for ${money(co.amountMinor, cur)}.` : 'Accepted; the invoice is drafted through policy.') : 'Nothing is owed for it.',
      )
      onChanged?.()
    } catch (e: any) {
      toast('danger', 'Could not record your answer', e?.message || 'Try again')
    } finally {
      setBusy(null)
    }
  }

  const copyId = async () => {
    if (!co.invoiceId) return
    try {
      await navigator.clipboard.writeText(co.invoiceId)
      toast('success', 'Invoice id copied', co.invoiceId)
    } catch {
      /* clipboard unavailable */
    }
  }

  const footer = canDecide ? (
    <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center">
      <button className="btn-primary w-full sm:w-auto" disabled={!!busy} onClick={() => decide('accept')} data-testid="accept-change-order">
        <Check size={15} strokeWidth={2} />
        {busy === 'accept' ? 'Drafting invoice…' : `Accept & invoice ${money(co.amountMinor, cur)}`}
      </button>
      <button className="btn-ghost w-full sm:w-auto" disabled={!!busy} onClick={() => decide('decline')}>
        <X size={15} strokeWidth={2} />
        Decline
      </button>
      <span className="text-[12px] text-umber sm:ml-auto">One tap drafts the PayPal invoice.</span>
    </div>
  ) : co.status === 'invoiced' ? (
    <div className="flex w-full flex-wrap items-center gap-2">
      <Link to="/invoices" className="btn-secondary btn-sm" data-testid="view-invoice">
        View in Invoices <ArrowUpRight size={14} strokeWidth={2} />
      </Link>
      <span className="text-[12px] text-umber">Drafted in PayPal; it is charged only once it is sent and paid.</span>
    </div>
  ) : co.status === 'draft' ? (
    <span className="text-[13px] text-umber">Waiting for the client to accept or decline.</span>
  ) : co.status === 'accepted' ? (
    <span className="text-[13px] text-umber">Accepted. The invoice is being drafted through policy.</span>
  ) : (
    <span className="text-[13px] text-umber">Declined{co.decidedAt ? ` ${when(co.decidedAt)}` : ''}. No invoice, nothing is owed.</span>
  )

  return (
    <DealCardShell
      testId="change-order-card"
      label="Change order"
      title={item?.label ? `${item.label} · ${ms?.title ?? co.milestoneKey}` : (ms?.title ?? co.milestoneKey)}
      meta={<Chip label={stage.label} tone={stage.tone} dot />}
      footer={footer}
    >
      {/* where it stands: requested -> accepted -> invoiced */}
      {!declined && (
        <ol className="mb-4 flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.06em]" aria-label="Progress">
          {STEPS.map((s, i) => (
            <li key={s} className="flex items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 ${i <= step ? 'text-teal' : 'text-label/70'}`} aria-current={i === step ? 'step' : undefined}>
                <span className={`h-1.5 w-1.5 rounded-full ${i <= step ? 'bg-teal' : 'bg-line-strong'}`} aria-hidden="true" />
                {s}
              </span>
              {i < STEPS.length - 1 && <span className={`h-px w-5 sm:w-8 ${i < step ? 'bg-teal' : 'bg-line-strong'}`} aria-hidden="true" />}
            </li>
          ))}
        </ol>
      )}

      <p className="micro-label">Requested change</p>
      <blockquote className="mt-1 border-l-2 border-teal/40 pl-3 text-[14px] leading-snug text-ink">&ldquo;{co.reason}&rdquo;</blockquote>
      <p className="mt-1 text-[12px] text-umber">
        Raised by {by} {when(co.at)}
      </p>

      {/* the invoice document */}
      <div className={`mt-4 overflow-hidden rounded-xl border border-line bg-canvas/50 ${declined ? 'opacity-60' : ''}`} data-testid="change-order-invoice">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-line px-4 py-3 sm:grid-cols-[minmax(0,1.8fr)_minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="col-span-2 min-w-0 sm:col-span-1">
            <dt className="micro-label">Invoice</dt>
            <dd className="mt-0.5">
              {co.invoiceId ? (
                <span className="inline-flex max-w-full items-center gap-1">
                  <PaypalInvoiceId id={co.invoiceId} />
                  <button className="icon-btn-sm shrink-0 text-umber hover:text-ink" onClick={() => void copyId()} aria-label="Copy invoice id" title="Copy invoice id">
                    <Copy size={12} strokeWidth={1.75} />
                  </button>
                </span>
              ) : (
                <span className="text-[13px] text-umber">{declined ? 'Not issued' : 'Issued on accept'}</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="micro-label">Status</dt>
            <dd className="mt-1">
              {stage.invoice ? (
                <span title={INVOICE_STATUS[stage.invoice].hint}>
                  <Chip label={INVOICE_STATUS[stage.invoice].label} tone={INVOICE_STATUS[stage.invoice].tone} dot />
                </span>
              ) : (
                <span className="text-[13px] text-umber">Quote</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="micro-label">{co.invoiceId ? 'Issued' : 'Quoted'}</dt>
            <dd className="mt-0.5 text-[13px] text-ink">{dateOnly(co.invoiceId ? (co.decidedAt ?? co.at) : co.at)}</dd>
          </div>
          <div>
            <dt className="micro-label">Billed to</dt>
            <dd className="mt-0.5 text-[13px] text-ink">
              Client <span className="text-umber">· from {roleWord('worker')}</span>
            </dd>
          </div>
        </dl>

        {/* line items */}
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="font-mono text-[10px] uppercase tracking-[0.05em] text-label">
              <th className="px-4 pb-1.5 pt-3 font-medium">Item</th>
              <th className="px-2 pb-1.5 pt-3 text-right font-medium">Qty</th>
              <th className="hidden px-2 pb-1.5 pt-3 text-right font-medium sm:table-cell">Rate</th>
              <th className="px-4 pb-1.5 pt-3 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr className="align-top">
              <td className="px-4 py-2">
                <p className="text-ink">{item?.label ?? co.rateCardItemId}</p>
                <p className="text-[12px] text-umber">
                  {item?.unit ?? 'unit'}
                  <span className="sm:hidden"> · {money(unit, cur)} each</span>
                </p>
              </td>
              <td className="t-num px-2 py-2 text-right !font-medium">{co.quantity}</td>
              <td className="t-num hidden px-2 py-2 text-right !font-medium sm:table-cell">{money(unit, cur)}</td>
              <td className="t-num px-4 py-2 text-right !font-medium">{money(co.amountMinor, cur)}</td>
            </tr>
          </tbody>
        </table>
        <div className="mx-4 flex items-baseline justify-between gap-3 border-t border-line py-3">
          <span className="text-[13px] text-umber">
            Total <span className="font-mono text-[11px] text-label">{cur}</span>
          </span>
          <span className="t-num text-[22px]" data-testid="change-order-total">
            {money(co.amountMinor, cur)}
          </span>
        </div>
      </div>

      <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-snug text-umber">
        <ShieldCheck size={13} strokeWidth={1.75} className="mt-px shrink-0 text-teal" aria-hidden="true" />
        <span>
          Priced from the signed rate card; the AI never sets amounts. {declined ? 'Declined, so no extra round.' : co.status === 'draft' ? 'Accepting unlocks one extra revision round.' : 'Unlocked one extra revision round.'}
        </span>
      </p>
    </DealCardShell>
  )
}
