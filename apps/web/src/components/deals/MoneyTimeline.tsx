/**
 * MoneyTimeline: the hash-chained ledger as a vertical timeline. Held,
 * captured, paid out, invoiced, and every BLOCKED attempt with its rule id and
 * "No money moved". Totals and the chain badge come from GET .../ledger; new
 * lines arrive live over Socket.IO (deal:join -> deal:ledger).
 *
 * Button: one-tap release for a move waiting on a human (pendingApprovals).
 * AI checks facts, people own taste, the deal decides the money.
 */
import { useState } from 'react'
import { Link2, Link2Off, Radio } from 'lucide-react'
import { useToast } from '../toast'
import { ErrorBanner, Skeleton } from '../states'
import * as api from '../../services/api'
import type { DealLedgerEntry, DealView } from '../../contracts/types'
import { money, useDealLedger, when } from '../../lib/deals'
import { DealCardShell, Stat } from './common'
import PolicyBlockedChip from './PolicyBlockedChip'

const LABEL: Record<DealLedgerEntry['type'], string> = {
  authorize: 'Held on PayPal',
  reauthorize: 'Hold renewed',
  capture: 'Captured',
  partial_capture: 'Partial capture',
  void: 'Hold released',
  refund: 'Refunded',
  payout: 'Paid out',
  invoice: 'Invoice drafted',
  blocked: 'Blocked',
  pending_approval: 'Waiting for one tap',
  webhook: 'PayPal confirmed',
  state: 'State',
}
const DOT: Partial<Record<DealLedgerEntry['type'], string>> = {
  authorize: 'bg-st-production',
  capture: 'bg-teal',
  partial_capture: 'bg-teal',
  payout: 'bg-st-live',
  blocked: 'bg-danger',
  pending_approval: 'bg-warning',
  invoice: 'bg-st-brief',
}

export default function MoneyTimeline({
  deal,
  orgId,
  milestoneKey,
  onChanged,
}: {
  deal: DealView
  orgId: string
  /** Show only one milestone's lines (the totals stay deal-wide). */
  milestoneKey?: string
  onChanged?: () => void
}) {
  const toast = useToast()
  const ledger = useDealLedger(orgId, deal.id)
  const [busy, setBusy] = useState<string | null>(null)
  const cur = deal.terms.currency
  const entries = (ledger.data?.entries ?? []).filter((e) => !milestoneKey || e.milestoneKey === milestoneKey)
  const pending = deal.pendingApprovals.filter((p) => !milestoneKey || (p.action as any)?.milestoneKey === milestoneKey)

  const release = async (key: string) => {
    setBusy(key)
    try {
      await api.approvePending(orgId, deal.id, key)
      toast('success', 'Released', 'The Money Agent ran it through policy.')
      onChanged?.()
    } catch (e: any) {
      toast('danger', 'Could not release', e?.message || 'Try again')
    } finally {
      setBusy(null)
    }
  }

  const t = ledger.data?.totals
  return (
    <DealCardShell
      testId="money-timeline"
      label="Money timeline"
      title={deal.terms.title}
      meta={
        <>
          {ledger.live && (
            <span className="inline-flex items-center gap-1 font-mono text-[11px] text-teal" title="Live: new ledger lines appear as they are written">
              <Radio size={12} strokeWidth={2} /> LIVE
            </span>
          )}
          {ledger.data &&
            (ledger.data.chain.ok ? (
              <span className="status-chip bg-st-scheduled-bg text-st-scheduled" data-testid="chain-ok">
                <Link2 size={12} strokeWidth={2} /> Chain verified
              </span>
            ) : (
              <span className="status-chip bg-st-failed-bg text-st-failed">
                <Link2Off size={12} strokeWidth={2} /> Chain broken at #{ledger.data.chain.brokenAt}
              </span>
            ))}
        </>
      }
    >
      {ledger.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : ledger.isError ? (
        <ErrorBanner message="The ledger did not load." onRetry={() => void ledger.refetch()} />
      ) : (
        <>
          {t && (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Held" value={money(t.heldMinor, cur)} />
              <Stat label="Captured" value={money(t.capturedMinor, cur)} tone="teal" />
              <Stat label="Paid out" value={money(t.paidOutMinor, cur)} />
              <Stat label="Blocked" value={t.blockedCount} tone={t.blockedCount ? 'danger' : undefined} />
            </div>
          )}

          {pending.length > 0 && (
            <div className="mt-4 space-y-2">
              {pending.map((p) => (
                <div key={p.key} className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
                  <span className="text-[13px] text-ink">{p.reason}</span>
                  <button className="btn-primary ml-auto !h-8 text-[12px]" disabled={busy === p.key} onClick={() => release(p.key)}>
                    Release (one tap)
                  </button>
                </div>
              ))}
            </div>
          )}

          {entries.length === 0 ? (
            <p className="mt-4 text-[13px] text-umber">No money has moved yet. The first line appears when the client funds a milestone.</p>
          ) : (
            <ol className="relative mt-5 space-y-4 border-l border-line pl-5" aria-label="Ledger">
              {entries.map((e) => (
                <li key={e.seq} className="relative" data-testid={`ledger-${e.type}`}>
                  <span
                    className={`absolute -left-[25px] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-surface ${DOT[e.type] ?? 'bg-umber/50'}`}
                    aria-hidden="true"
                  />
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className={`text-[13px] font-medium ${e.type === 'blocked' ? 'text-danger' : 'text-ink'}`}>{LABEL[e.type]}</span>
                    {e.moved && e.amountMinor > 0 && <span className="t-num !text-[14px]">{money(e.amountMinor, e.currency || cur)}</span>}
                    <span className="font-mono text-[11px] text-label">
                      #{e.seq} · {e.milestoneKey} · {when(e.at)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[12px] text-umber">{e.explanation}</p>
                  {e.type === 'blocked' && (
                    <div className="mt-1.5">
                      <PolicyBlockedChip violations={e.policy?.violations ?? []} />
                      {!e.policy?.violations?.length && <p className="font-mono text-[11px] text-label">No money moved.</p>}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </DealCardShell>
  )
}
