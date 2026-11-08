/**
 * TeamPayoutCard: how a milestone's crew got paid. Every release (approve,
 * the review clock's partial release, its grace release) pays the whole team
 * in ONE PayPal Payouts batch, split by the signed shares; this card lists
 * each member's receipt line: amount, share, release step, batch id.
 *
 * The brand and deal managers see every line. A crew member (the editor
 * included) sees only their own line, plus "Your share: X (30%)". A line that
 * did not leave PayPal (mock, PAYOUTS_MODE=simulated, or the sandbox
 * answering PAYOUT_NOT_AVAILABLE) carries a "Simulated payout" badge.
 * Every amount comes from the API; nothing here computes money.
 */
import { useQuery } from '@tanstack/react-query'
import { Info, Layers } from 'lucide-react'
import Avatar from '../ui'
import * as api from '../../services/api'
import type { PayoutReceiptLine, PayoutReceipts } from '../../services/api'
import type { DealView } from '../../contracts/types'
import { money } from '../../lib/deals'
import { initialsOf } from '../../lib/initials'
import { DealCardShell } from './common'

const pctText = (bp: number) => `${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%`

export function SimulatedBadge({ title }: { title?: string }) {
  return (
    <span
      className="status-chip shrink-0 bg-st-production-bg text-st-production"
      title={
        title || 'No money left PayPal for this line: PayPal Payouts is simulated for this account.'
      }
      data-testid="simulated-payout-badge"
    >
      Simulated payout
    </span>
  )
}

function shortId(id: string) {
  return id.length > 22 ? `${id.slice(0, 20)}…` : id
}

function Line({
  l,
  currency,
  showName,
}: {
  l: PayoutReceiptLine
  currency: string
  showName: boolean
}) {
  return (
    <li className="flex items-start gap-3 px-3 py-2.5" data-testid="team-payout-line">
      {showName && (
        <Avatar
          initials={initialsOf(l.displayName)}
          size="sm"
          tone="tint"
          className="mt-0.5 shrink-0"
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-ink">
          {showName ? l.displayName : l.stepLabel}
        </p>
        <p className="text-xs text-umber">
          {showName ? `${l.stepLabel} · ` : ''}
          {pctText(l.shareBp)} share
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate font-mono text-xs text-label" title={l.batchId}>
            Batch {shortId(l.batchId)}
          </span>
          {l.simulated && <SimulatedBadge />}
        </div>
      </div>
      <p className="t-num shrink-0 text-[14px] text-ink">{money(l.amountMinor, currency)}</p>
    </li>
  )
}

function Body({ r }: { r: PayoutReceipts }) {
  const cur = r.currency
  const all = r.scope === 'all'
  const simulatedReason =
    r.batches.find((b) => b.simulated)?.reason ||
    r.lines.find((l) => l.simulated && l.reason)?.reason
  return (
    <div className="space-y-4">
      {r.me && (
        <div
          className="rounded-xl border border-teal/20 bg-tint px-4 py-3"
          data-testid="your-share"
        >
          <p className="micro-label !text-teal">Your share</p>
          <p className="mt-0.5 font-headline text-[19px] font-semibold text-ink">
            Your share: <span className="t-num">{money(r.me.shareOfMilestoneMinor, cur)}</span>{' '}
            <span className="t-num text-umber">({pctText(r.me.shareBp)})</span>
          </p>
          <p className="mt-0.5 text-[12px] text-umber">
            Paid so far <span className="t-num text-ink">{money(r.me.paidMinor, cur)}</span> of{' '}
            <span className="t-num">{money(r.me.shareOfMilestoneMinor, cur)}</span>
            {r.me.role === 'lead' ? ' · as lead you take any cents left over by the split' : ''}
          </p>
        </div>
      )}

      {all && r.team.length > 0 && (
        <div
          className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-umber"
          data-testid="team-split"
        >
          {r.team.map((m) => (
            <span key={m.userId}>
              <span className="text-ink">{m.displayName}</span> {pctText(m.shareBp)}
              {m.role === 'lead' ? ' (lead)' : ''}:{' '}
              <span className="t-num">{money(m.paidMinor, cur)}</span> of{' '}
              <span className="t-num">{money(m.shareOfMilestoneMinor, cur)}</span>
            </span>
          ))}
        </div>
      )}

      {r.lines.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-3 text-[12.5px] text-umber">
          Nothing paid out yet
        </p>
      ) : all && r.batches.length ? (
        <div className="space-y-3">
          {r.batches.map((b) => {
            const lines = r.lines.filter((l) => l.batchId === b.batchId)
            return (
              <div
                key={b.batchId}
                className="overflow-hidden rounded-xl border border-line"
                data-testid="team-payout-batch"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-canvas/60 px-3 py-2">
                  <p className="flex min-w-0 items-center gap-1.5 text-[12.5px] font-medium text-ink">
                    <Layers
                      size={13}
                      strokeWidth={1.75}
                      className="shrink-0 text-umber"
                      aria-hidden="true"
                    />
                    {b.stepLabel}
                    <span className="font-normal text-umber">
                      · {b.members} {b.members === 1 ? 'person' : 'people'}
                    </span>
                  </p>
                  <span className="t-num text-[12.5px] text-ink">{money(b.amountMinor, cur)}</span>
                </div>
                <ul className="divide-y divide-line">
                  {lines.map((l) => (
                    <Line key={`${l.batchId}-${l.userId}`} l={l} currency={cur} showName />
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {r.lines.map((l) => (
            <Line key={`${l.batchId}-${l.userId}`} l={l} currency={cur} showName={all} />
          ))}
        </ul>
      )}

      {r.lines.some((l) => l.simulated) && (
        <p className="flex items-start gap-1.5 text-xs text-umber">
          <Info size={13} strokeWidth={1.75} className="mt-px shrink-0" aria-hidden="true" />
          <span>
            Simulated payout: the batch and every receipt are recorded, but no money left PayPal.{' '}
            {simulatedReason
              ? `Why: ${simulatedReason}.`
              : 'PayPal Payouts is not available to this sandbox account.'}
          </span>
        </p>
      )}
    </div>
  )
}

export default function TeamPayoutCard({
  deal,
  orgId,
  milestoneKey,
}: {
  deal: DealView
  orgId: string
  milestoneKey: string
}) {
  const m = deal.milestones.find((x) => x.key === milestoneKey)
  // refetch when money moves on this milestone
  const q = useQuery({
    queryKey: [
      'payout-receipts',
      orgId,
      deal.id,
      milestoneKey,
      m?.paidOutMinor ?? 0,
      m?.payouts?.length ?? 0,
    ],
    queryFn: () => api.getPayoutReceipts(orgId, deal.id, milestoneKey),
    enabled: !!orgId,
    staleTime: 10_000,
  })
  const r = q.data
  return (
    <DealCardShell
      title="Team payout"
      label="One PayPal Payouts batch per release"
      testId={`team-payout-${milestoneKey}`}
      meta={
        r && r.lines.length > 0 ? (
          r.lines.every((l) => l.simulated) ? (
            <SimulatedBadge />
          ) : (
            <span className="status-chip bg-st-live-bg text-st-live">Paid</span>
          )
        ) : null
      }
      footer={
        <p className="text-[12px] text-umber">
          {r?.scope === 'own'
            ? 'You see your own receipt lines. The brand sees every line.'
            : 'Shares are floored to the cent; any cents left over go to the lead, so every batch adds up exactly.'}
        </p>
      }
    >
      {q.isLoading ? (
        <div className="space-y-2" aria-busy="true">
          <div className="skeleton h-14 w-full rounded-xl" />
          <div className="skeleton h-10 w-full rounded-xl" />
        </div>
      ) : q.isError ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-st-failed-bg px-3 py-2 text-[12.5px] text-st-failed">
          <span>{(q.error as Error)?.message || 'Could not load the team payout'}</span>
          <button className="btn-secondary btn-xs" onClick={() => void q.refetch()}>
            Retry
          </button>
        </div>
      ) : r ? (
        <Body r={r} />
      ) : null}
    </DealCardShell>
  )
}
