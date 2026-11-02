/**
 * DealCard: the signed deal at a glance. Parties by role (never names), the
 * terms hash both sides signed, and per milestone the amount, due date + grace,
 * review window, rounds left, kill fee and state.
 *
 * Buttons: Sign (shows the exact hash being signed) and Fund with PayPal
 * (opens PayPal's approve page; the hold is an authorization, not a charge).
 * AI checks facts, people own taste, the deal decides the money.
 */
import { useState } from 'react'
import { Check, CircleDashed, ExternalLink, PenLine, Wallet } from 'lucide-react'
import { StatusChip } from '../status'
import { useToast } from '../toast'
import * as api from '../../services/api'
import type { DealView } from '../../contracts/types'
import { money, roleWord, shortHash, when } from '../../lib/deals'
import { DealCardShell } from './common'

export default function DealCard({
  deal,
  orgId,
  onChanged,
}: {
  deal: DealView
  orgId: string
  onChanged?: () => void
}) {
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const cur = deal.terms.currency
  const signed = (party: 'client' | 'worker') => deal.signatures.some((s) => s.party === party)
  const iSigned = deal.me ? signed(deal.me) : true
  const locked = !!deal.termsHash

  const sign = async () => {
    setBusy('sign')
    try {
      await api.signDeal(orgId, deal.id, deal.termsHashNow)
      toast('success', 'Signed', `Terms ${shortHash(deal.termsHashNow)} signed.`)
      onChanged?.()
    } catch (e: any) {
      toast('danger', 'Could not sign', e?.message || 'Try again')
    } finally {
      setBusy(null)
    }
  }

  const fund = async (key: string) => {
    setBusy(`fund:${key}`)
    try {
      const d = await api.fundMilestone(orgId, deal.id, key)
      const url = d.milestones.find((m) => m.key === key)?.funding?.approveUrl
      if (url) window.open(url, '_blank', 'noopener')
      toast('info', 'PayPal hold started', 'Approve the hold on PayPal; nothing is charged until the work is approved.')
      onChanged?.()
    } catch (e: any) {
      toast('danger', 'Could not start funding', e?.message || 'Try again')
    } finally {
      setBusy(null)
    }
  }

  return (
    <DealCardShell
      testId="deal-card"
      label="Deal"
      title={deal.terms.title}
      meta={
        <span className="font-mono text-[11px] text-label" title={deal.termsHash || deal.termsHashNow}>
          TERMS {shortHash(deal.termsHash || deal.termsHashNow)}
        </span>
      }
      footer={
        deal.me && !iSigned && !locked ? (
          <>
            <button className="btn-primary" disabled={busy === 'sign' || (deal.problems?.length ?? 0) > 0} onClick={sign}>
              <PenLine size={15} strokeWidth={2} />
              Sign terms {shortHash(deal.termsHashNow, 8)}
            </button>
            {(deal.problems?.length ?? 0) > 0 && (
              <span className="text-[13px] text-danger">Fix before signing: {deal.problems?.join('; ')}</span>
            )}
          </>
        ) : undefined
      }
    >
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-[13px]">
        {(['client', 'worker'] as const).map((p) => (
          <span key={p} className="inline-flex items-center gap-1.5 text-ink">
            {signed(p) ? (
              <Check size={14} strokeWidth={2.25} className="text-teal" aria-label="signed" />
            ) : (
              <CircleDashed size={14} strokeWidth={2} className="text-label" aria-label="not signed" />
            )}
            {roleWord(p)}
            {deal.me === p && <span className="text-umber">(you)</span>}
          </span>
        ))}
        <span className="text-umber">
          {locked ? 'Signed by both, terms locked' : 'Draft: not locked yet'} · Kill fee {(deal.terms.killFeeBp / 100).toFixed(0)}%
        </span>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-[13px]">
          <thead>
            <tr className="border-b border-line">
              {['Milestone', 'Amount', 'Due (+grace)', 'Review', 'Rounds left', 'State', ''].map((h) => (
                <th key={h} className="micro-label py-2 pr-3 font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {deal.terms.milestones.map((t) => {
              const r = deal.milestones.find((m) => m.key === t.key)
              const left = Math.max(0, t.revisionRoundsIncluded - (r?.revisionRoundsUsed ?? 0))
              const canFund = deal.me === 'client' && r?.state === 'SIGNED'
              return (
                <tr key={t.key} className="border-b border-line last:border-0">
                  <td className="py-2.5 pr-3 text-ink">{t.title}</td>
                  <td className="t-num py-2.5 pr-3 !text-[14px]">{money(t.amountMinor, cur)}</td>
                  <td className="py-2.5 pr-3 text-umber">
                    {when(t.dueAt)} <span className="text-label">+{t.graceHours}h</span>
                  </td>
                  <td className="py-2.5 pr-3 text-umber">{t.reviewWindowHours}h</td>
                  <td className="py-2.5 pr-3 text-umber">
                    {left} of {t.revisionRoundsIncluded}
                  </td>
                  <td className="py-2.5 pr-3">{r && <StatusChip status={r.state} />}</td>
                  <td className="py-2.5 text-right">
                    {canFund && (
                      <button className="btn-secondary !h-8 text-[12px]" disabled={busy === `fund:${t.key}`} onClick={() => fund(t.key)}>
                        <Wallet size={13} strokeWidth={2} />
                        Fund with PayPal
                        <ExternalLink size={12} strokeWidth={2} />
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </DealCardShell>
  )
}
