/**
 * Deal copilot: generative UI for Approved = Paid.
 *
 * AI checks facts, people own taste, the deal decides the money.
 *
 * The copilot answers by RENDERING CARDS, never with a paragraph about money.
 * Its actions mirror the CopilotKit plan (docs/phase4-ui-plan.md section 4) one
 * to one, so moving them onto `useCopilotAction` / `useRenderToolCall` later is
 * mechanical:
 *
 *   render-only   showDeal, showChecks, showReviewMerge, showMoneyTimeline,
 *                 showChangeOrder, showDisputeSplit, showBlocked
 *   proposal      proposeCapture (dry-run through POST .../policy-check; read-only)
 *
 * Parameters are ids only (milestoneKey, changeOrderId); the cards fetch their
 * own data. No action takes an amount the model wrote. proposeCapture uses the
 * SIGNED amount from the deal, or the number the person typed, and only ever as
 * a policy dry-run: a blocked answer renders PolicyBlockedChip, never a button.
 *
 * Offline replay: intents are matched deterministically from the words typed
 * (and the suggested prompts map straight to actions), so every card is
 * reachable with no LLM. This is the judge-mode path and the default.
 */
import type { DealView } from '../contracts/types'

export type CopilotAction =
  | { name: 'showDeal' }
  | { name: 'showChecks'; milestoneKey: string }
  | { name: 'showReviewMerge'; milestoneKey: string }
  | { name: 'showMoneyTimeline'; milestoneKey?: string }
  | { name: 'showChangeOrder'; changeOrderId: string }
  | { name: 'showDisputeSplit'; milestoneKey: string }
  | { name: 'showBlocked' }
  | { name: 'proposeCapture'; milestoneKey: string; versionId?: string; typedMinor?: number }
  | { name: 'help' }

export const SUGGESTIONS: { label: string; prompt: string }[] = [
  { label: 'Show the deal', prompt: 'Show me the deal' },
  { label: 'Checks on reel 1', prompt: 'What did the checks find on reel 1?' },
  { label: 'Fix vs Taste', prompt: 'Merge the review notes for reel 1' },
  { label: 'Money timeline', prompt: 'Where is the money?' },
  { label: 'Change order', prompt: 'Show the change order' },
  { label: 'Dispute split', prompt: 'Show the dispute split on reel 2' },
  { label: 'Capture $450', prompt: 'Capture $450 on reel 1' },
  { label: 'Pay the old version', prompt: 'Pay reel 1 for the old version v1' },
]

/** "reel 2", "reel2", "milestone reel1", "second" -> a milestone key of this deal. */
function milestoneFrom(text: string, deal: DealView, fallback?: string): string | undefined {
  const keys = deal.terms.milestones.map((m) => m.key)
  const low = text.toLowerCase().replace(/\s+/g, ' ')
  for (const k of keys) {
    const spaced = k.replace(/(\D)(\d+)$/, '$1 $2')
    if (low.includes(k.toLowerCase()) || low.includes(spaced.toLowerCase())) return k
  }
  const titled = deal.terms.milestones.find((m) => low.includes(m.title.toLowerCase()))
  if (titled) return titled.key
  const ord = ['first', 'second', 'third', 'fourth'].findIndex((w) => low.includes(w))
  if (ord >= 0 && keys[ord]) return keys[ord]
  return fallback
}

function moneyFrom(text: string): number | undefined {
  const m = text.match(/(?:\$|usd\s*|rs\.?\s*|₹)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)|([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:dollars|usd)/i)
  const raw = m?.[1] ?? m?.[2]
  if (!raw) return undefined
  const n = Math.round(parseFloat(raw.replace(/,/g, '')) * 100)
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

/** Deterministic intent match (the offline replay). Returns the actions to render, in order. */
export function matchIntent(text: string, deal: DealView): CopilotAction[] {
  const low = text.toLowerCase()
  const firstKey = deal.terms.milestones[0]?.key
  const disputed = deal.milestones.find((m) => m.state === 'DISPUTED')?.key
  const has = (...w: string[]) => w.some((x) => low.includes(x))

  if (has('capture', 'pay ', 'pay the', 'release', 'charge', 'payout', 'pay out') && !has('timeline', 'where is')) {
    const key = milestoneFrom(text, deal, firstKey)
    if (!key) return [{ name: 'help' }]
    const versions = deal.milestones.find((m) => m.key === key)?.versions ?? []
    let versionId: string | undefined
    if (has('old version', 'older version', 'previous version', 'first version', 'v1')) versionId = versions[0]?.id
    const vMatch = low.match(/\bv(\d+)\b/)
    if (vMatch) versionId = versions.find((v) => v.id.toLowerCase() === `v${vMatch[1]}`)?.id ?? versionId
    return [{ name: 'proposeCapture', milestoneKey: key, versionId, typedMinor: moneyFrom(text) }]
  }
  if (has('blocked', 'refused', 'denied', 'policy')) return [{ name: 'showBlocked' }]
  if (has('change order', 'extra cut', 'extra 15', 'invoice', 'out of scope', 'rate card')) {
    const cos = deal.changeOrders
    const pick = cos.find((c) => c.status === 'draft') ?? cos[cos.length - 1]
    return pick ? [{ name: 'showChangeOrder', changeOrderId: pick.id }] : [{ name: 'showDeal' }]
  }
  if (has('dispute', 'split', 'disagree')) {
    const key = milestoneFrom(text, deal, disputed ?? firstKey)
    return key ? [{ name: 'showDisputeSplit', milestoneKey: key }] : [{ name: 'help' }]
  }
  if (has('review', 'notes', 'fix', 'taste', 'feedback', 'comments', 'merge')) {
    const key = milestoneFrom(text, deal, firstKey)
    return key ? [{ name: 'showReviewMerge', milestoneKey: key }] : [{ name: 'help' }]
  }
  if (has('check', 'loud', 'lufs', 'logo', 'hook', 'caption', 'evidence', 'qa', 'measure')) {
    const key = milestoneFrom(text, deal, firstKey)
    return key ? [{ name: 'showChecks', milestoneKey: key }] : [{ name: 'help' }]
  }
  if (has('money', 'ledger', 'timeline', 'held', 'paid', 'where is', 'captured', 'hold')) {
    return [{ name: 'showMoneyTimeline', milestoneKey: milestoneFrom(text, deal) }]
  }
  if (has('deal', 'terms', 'contract', 'sign', 'summary', 'overview', 'status')) return [{ name: 'showDeal' }]
  return [{ name: 'help' }]
}

/**
 * The capture a proposal would dry-run. The amount is the SIGNED milestone
 * amount from the deal unless the person typed a number (then theirs, so policy
 * can say why it is wrong). Never a number the copilot made up.
 */
export function captureDryRun(deal: DealView, a: Extract<CopilotAction, { name: 'proposeCapture' }>) {
  const terms = deal.terms.milestones.find((m) => m.key === a.milestoneKey)
  const rt = deal.milestones.find((m) => m.key === a.milestoneKey)
  if (!terms || !rt) return null
  const latest = rt.versions[rt.versions.length - 1]
  const versionId = a.versionId ?? rt.approvedVersionId ?? latest?.id
  if (!versionId) return null
  const amountMinor = a.typedMinor ?? terms.amountMinor
  return {
    body: {
      kind: 'money',
      action: { kind: 'capture', milestoneKey: a.milestoneKey, amountMinor, versionId, final: true, reason: 'approval' },
    },
    amountMinor,
    amountFrom: a.typedMinor !== undefined ? ('typed' as const) : ('signed' as const),
    versionId,
    latestId: latest?.id,
  }
}
