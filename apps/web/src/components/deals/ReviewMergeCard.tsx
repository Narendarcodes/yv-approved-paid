/**
 * ReviewMergeCard: the Review Agent's merge of reviewer comments into items,
 * each tagged Fix (cites a failed checklist line) or Taste (costs a revision
 * round, never pay). Contradictions are flagged for people to settle, and any
 * Fix the engine downgraded to Taste is explained. The proposal was dry-run
 * through policy before it was stored; a blocked one shows the rule, not a button.
 *
 * Button (client, while in review): Send changes -> POST .../milestones/:key/changes.
 * AI checks facts, people own taste, the deal decides the money.
 */
import { useState } from 'react'
import { AlertTriangle, Send } from 'lucide-react'
import { useToast } from '../toast'
import * as api from '../../services/api'
import type { DealView } from '../../contracts/types'
import { milestonePair, when } from '../../lib/deals'
import { DealCardShell, TagPill } from './common'
import PolicyBlockedChip from './PolicyBlockedChip'

export default function ReviewMergeCard({
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
  const p = pair?.runtime.proposals?.review
  if (!pair) return null
  const { terms, runtime } = pair
  const lineText = (id?: string) => terms.checklist.find((c) => c.id === id)?.text
  const sent = !!p && runtime.changeRequests.some((r) => r.versionId === p.versionId)
  const canSend =
    !!p && p.decision.allowed && !sent && deal.me === 'client' && runtime.state === 'IN_REVIEW'

  const send = async () => {
    if (!p) return
    setBusy(true)
    try {
      await api.requestDealChanges(
        orgId,
        deal.id,
        milestoneKey,
        p.items.map(({ text, tag, checklistId, disputed }) => ({
          text,
          tag,
          checklistId,
          disputed,
        })),
      )
      toast('success', 'Changes sent', 'The editor sees each item tagged Fix or Taste.')
      onChanged?.()
    } catch (e: any) {
      toast('danger', 'Could not send changes', e?.message || 'Try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <DealCardShell
      testId="review-merge-card"
      label="Review merge"
      title={terms.title}
      meta={
        p ? <span className="font-mono text-xs text-label">VERSION {p.versionId}</span> : undefined
      }
      footer={
        canSend ? (
          <button className="btn-primary" disabled={busy} onClick={send}>
            <Send size={15} strokeWidth={2} />
            Send changes
          </button>
        ) : sent ? (
          <span className="text-[13px] text-umber">Sent to the editor.</span>
        ) : undefined
      }
    >
      {!p ? (
        <p className="text-[13px] text-umber">No review merge yet</p>
      ) : (
        <>
          <ul className="divide-y divide-line">
            {p.items.map((it, i) => (
              <li key={i} className="flex items-start gap-3 py-2.5">
                <TagPill tag={it.tag} />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-ink">&ldquo;{it.text}&rdquo;</p>
                  <p className="text-[12px] text-umber">
                    {it.tag === 'fix'
                      ? `Cites the failed line: ${lineText(it.checklistId) ?? it.checklistId}`
                      : 'Taste: costs a revision round, not pay.'}
                    {p.downgraded.includes(it.text) &&
                      ' Downgraded to Taste: the line it cites passed.'}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          {p.contradictions.length > 0 && (
            <div className="mt-3 space-y-1">
              {p.contradictions.map((c, i) => (
                <p key={i} className="flex items-start gap-1.5 text-[12px] text-warning">
                  <AlertTriangle size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
                  Items {c.a + 1} and {c.b + 1} pull opposite ways{c.why ? `: ${c.why}` : ''}.
                  People settle this.
                </p>
              ))}
            </div>
          )}
          <p className="mt-3 text-[12px] text-umber">
            {p.costsRevisionRound === true && 'This costs a revision round. '}
            {p.costsRevisionRound === false && 'Fix-only: no revision round used. '}
            {typeof p.roundsLeftAfter === 'number' && `Rounds left after: ${p.roundsLeftAfter}. `}
            Merged {when(p.at)}.
          </p>
          {!p.decision.allowed && (
            <div className="mt-3">
              <PolicyBlockedChip
                violations={p.decision.violations}
                currency={deal.terms.currency}
              />
            </div>
          )}
        </>
      )}
    </DealCardShell>
  )
}
