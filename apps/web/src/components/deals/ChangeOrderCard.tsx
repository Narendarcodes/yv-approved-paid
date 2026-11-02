/**
 * ChangeOrderCard: an out-of-scope ask, priced from the SIGNED rate card
 * (qty x unit price; the API computed it, the UI only shows it). The client
 * accepts or declines with one tap; accepting drafts the PayPal invoice through
 * policy and unlocks one extra round.
 *
 * Buttons (client, draft only): Accept / Decline -> POST .../change-orders/:coId/accept|decline.
 * AI checks facts, people own taste, the deal decides the money.
 */
import { useState } from 'react'
import { Check, Receipt, X } from 'lucide-react'
import Chip from '../primitives'
import { useToast } from '../toast'
import * as api from '../../services/api'
import type { DealView } from '../../contracts/types'
import { money, roleWord, when } from '../../lib/deals'
import { DealCardShell } from './common'

const TONE = { draft: 'warning', invoiced: 'teal', accepted: 'teal', declined: 'neutral' } as const

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
  const [busy, setBusy] = useState(false)
  const co = deal.changeOrders.find((c) => c.id === changeOrderId)
  if (!co) return null
  const item = deal.terms.rateCard.find((r) => r.id === co.rateCardItemId)
  const ms = deal.terms.milestones.find((m) => m.key === co.milestoneKey)
  const cur = deal.terms.currency
  const canDecide = deal.me === 'client' && co.status === 'draft'

  const decide = async (verb: 'accept' | 'decline') => {
    setBusy(true)
    try {
      const r = await api.decideChangeOrder(orgId, deal.id, co.id, verb)
      const inv = r.deal.changeOrders.find((c) => c.id === co.id)?.invoiceId
      toast(
        'success',
        verb === 'accept' ? 'Change order accepted' : 'Change order declined',
        verb === 'accept' ? (inv ? `PayPal invoice ${inv} drafted.` : 'Accepted; the invoice is drafted through policy.') : undefined,
      )
      onChanged?.()
    } catch (e: any) {
      toast('danger', 'Could not record your answer', e?.message || 'Try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <DealCardShell
      testId="change-order-card"
      label="Change order"
      title={ms?.title ?? co.milestoneKey}
      meta={<Chip label={co.status} tone={TONE[co.status]} dot />}
      footer={
        canDecide ? (
          <>
            <button className="btn-primary" disabled={busy} onClick={() => decide('accept')}>
              <Check size={15} strokeWidth={2} />
              Accept {money(co.amountMinor, cur)}
            </button>
            <button className="btn-secondary" disabled={busy} onClick={() => decide('decline')}>
              <X size={15} strokeWidth={2} />
              Decline
            </button>
          </>
        ) : co.invoiceId ? (
          <span className="inline-flex items-center gap-1.5 text-[13px] text-umber">
            <Receipt size={14} strokeWidth={1.75} /> PayPal invoice <span className="font-mono text-ink">{co.invoiceId}</span>
          </span>
        ) : undefined
      }
    >
      <blockquote className="border-l-2 border-line pl-3 text-[13px] text-ink">&ldquo;{co.reason}&rdquo;</blockquote>
      <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-3">
        <div>
          <p className="micro-label">Rate card</p>
          <p className="text-[13px] text-ink">
            {item?.label ?? co.rateCardItemId} <span className="text-umber">({item?.unit})</span>
          </p>
        </div>
        <div>
          <p className="micro-label">Price</p>
          <p className="t-num text-[18px]">
            {co.quantity} × {money(item?.unitPriceMinor, cur)} = {money(co.amountMinor, cur)}
          </p>
        </div>
      </div>
      <p className="mt-3 text-[12px] text-umber">
        Priced from the signed rate card, not by the AI. Unlocks one extra round. Drafted by {roleWord(co.by === 'agent' ? 'Scope Agent' : co.by)} {when(co.at)}.
      </p>
    </DealCardShell>
  )
}
