/**
 * DisputeSplitCard: the Scope & Dispute evidence pack and the split it
 * proposes. The split is checklist arithmetic computed in Node (passed / total
 * signed check lines x the milestone amount), never an AI number. Each side's
 * accepted number is shown; it is "agreed" only when both match, and then the
 * Money Agent captures it through policy and releases the rest.
 *
 * Button: Accept this split (the caller's side) -> POST .../milestones/:key/split
 * with the proposal's own workerMinor. AI checks facts, people own taste, the deal decides the money.
 */
import { useState } from 'react'
import { Check, CircleDashed, Scale } from 'lucide-react'
import { useToast } from '../toast'
import * as api from '../../services/api'
import type { DealView } from '../../contracts/types'
import { milestonePair, money, roleWord } from '../../lib/deals'
import { DealCardShell, PassPill } from './common'
import PolicyBlockedChip from './PolicyBlockedChip'

export default function DisputeSplitCard({
  deal,
  orgId,
  milestoneKey,
  onChanged,
}: {
  deal: DealView
  orgId: string
  milestoneKey: string
  onChanged?: () => void
}) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const pair = milestonePair(deal, milestoneKey)
  if (!pair) return null
  const { terms, runtime } = pair
  const p = runtime.proposals?.dispute
  const cur = deal.terms.currency
  const split = runtime.split ?? {}
  const agreed = split.client !== undefined && split.client === split.worker
  const mine = deal.me ? split[deal.me] : undefined
  const canAccept =
    !!p && !!deal.me && runtime.state === 'DISPUTED' && p.decision.allowed && mine !== p.workerMinor && !agreed

  const accept = async () => {
    if (!p) return
    setBusy(true)
    try {
      await api.acceptDealSplit(orgId, deal.id, milestoneKey, p.workerMinor)
      toast('success', 'Split accepted', 'When both sides match, the Money Agent captures it and releases the rest.')
      onChanged?.()
    } catch (e: any) {
      toast('danger', 'Could not accept the split', e?.message || 'Try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <DealCardShell
      testId="dispute-split-card"
      label="Dispute split"
      title={terms.title}
      meta={agreed ? <span className="status-chip bg-st-scheduled-bg text-st-scheduled">Agreed</span> : undefined}
      footer={
        canAccept ? (
          <button className="btn-primary" disabled={busy} onClick={accept}>
            <Scale size={15} strokeWidth={2} />
            Accept {money(p!.workerMinor, cur)} to the editor
          </button>
        ) : undefined
      }
    >
      {!p ? (
        <p className="text-[13px] text-umber">No split proposed yet. Opening a dispute builds the evidence pack and a split from the checklist.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div>
              <p className="micro-label">Checklist</p>
              <p className="t-num text-[18px]">
                {p.basis.passedChecks} of {p.basis.totalChecks} met → {(p.basis.shareBp / 100).toFixed(0)}%
              </p>
            </div>
            <div>
              <p className="micro-label">To the editor</p>
              <p className="t-num text-[18px] !text-teal">{money(p.workerMinor, cur)}</p>
            </div>
            <div>
              <p className="micro-label">Back to the client</p>
              <p className="t-num text-[18px]">{money(p.clientMinor, cur)}</p>
            </div>
          </div>
          <p className="mt-1 text-[12px] text-umber">
            {(p.basis.shareBp / 100).toFixed(0)}% of the signed {money(p.basis.amountMinor, cur)}, capped at what is still held ({money(p.basis.remainingMinor, cur)}). Arithmetic, not an AI number.
          </p>

          <ul className="mt-4 divide-y divide-line">
            {p.evidence.checks.map((c) => (
              <li key={c.id} className="flex items-center gap-3 py-2">
                <PassPill passed={c.passed} />
                <span className="text-[13px] text-ink">{c.text}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12px] text-umber">
            Rounds used {p.evidence.rounds.used} of {p.evidence.rounds.included} · {p.evidence.versions} version(s) ·{' '}
            {p.evidence.changeRequests.length} change request(s)
            {p.evidence.tasteLines.length > 0 && ` · taste lines (people decide): ${p.evidence.tasteLines.join('; ')}`}
          </p>

          <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-[13px]">
            {(['client', 'worker'] as const).map((side) => {
              const v = split[side]
              return (
                <span key={side} className="inline-flex items-center gap-1.5">
                  {v === p.workerMinor ? (
                    <Check size={14} strokeWidth={2.25} className="text-teal" />
                  ) : (
                    <CircleDashed size={14} strokeWidth={2} className="text-label" />
                  )}
                  {roleWord(side)}
                  {deal.me === side && <span className="text-umber">(you)</span>}:{' '}
                  <span className="text-umber">{v === undefined ? 'not yet' : `accepted ${money(v, cur)}`}</span>
                </span>
              )
            })}
          </div>
          {!p.decision.allowed && (
            <div className="mt-3">
              <PolicyBlockedChip violations={p.decision.violations} currency={deal.terms.currency} />
            </div>
          )}
        </>
      )}
    </DealCardShell>
  )
}
