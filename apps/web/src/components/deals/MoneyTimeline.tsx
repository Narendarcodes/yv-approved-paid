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
import { ChevronRight, Link2, Link2Off, Radio, RefreshCw } from 'lucide-react'
import { useToast } from '../toast'
import { ErrorBanner, Skeleton } from '../states'
import * as api from '../../services/api'
import type { DealLedgerEntry, DealView } from '../../contracts/types'
import { blockedSummary, invoiceSent, money, useDealLedger, when } from '../../lib/deals'
import { DealCardShell, PaypalId, PaypalInvoiceId, Stat } from './common'
import PolicyBlockedChip from './PolicyBlockedChip'

const LABEL: Record<DealLedgerEntry['type'], string> = {
  authorize: 'Held on PayPal',
  reauthorize: 'Hold renewed',
  capture: 'Captured',
  partial_capture: 'Partial capture',
  void: 'Hold released',
  refund: 'Refunded',
  payout: 'Paid out',
  invoice: 'Invoice',
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
  const entries = (ledger.data?.entries ?? []).filter(
    (e) => !milestoneKey || e.milestoneKey === milestoneKey,
  )
  const pending = deal.pendingApprovals.filter(
    (p) => !milestoneKey || (p.action as any)?.milestoneKey === milestoneKey,
  )

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
  // invoice lines move no money, so the API's invoicedMinor counts 0; show what was billed
  const invoicedMinor = entries
    .filter((e) => e.type === 'invoice')
    .reduce((a, e) => a + (e.amountMinor || 0), 0)
  return (
    <DealCardShell
      testId="money-timeline"
      label="Money timeline"
      title={deal.terms.title}
      meta={
        <>
          {ledger.live && (
            <span
              className="inline-flex items-center gap-1 font-mono text-xs text-teal"
              title="Live: new ledger lines appear as they are written"
            >
              <Radio size={12} strokeWidth={2} /> LIVE
            </span>
          )}
          {!ledger.live && ledger.autoRefresh && (
            <span
              className="inline-flex items-center gap-1 font-mono text-xs text-umber"
              title="Live push is not connected; the ledger refreshes every 10 seconds"
              data-testid="ledger-auto-refresh"
            >
              <RefreshCw size={12} strokeWidth={2} /> auto-refresh
            </span>
          )}
          {ledger.data &&
            (ledger.data.chain.ok ? (
              <span
                className="status-chip bg-st-scheduled-bg text-st-scheduled"
                data-testid="chain-ok"
              >
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
              {/* a crew member's ledger holds only their own payout lines (scope 'own'), so this is what reached them */}
              <Stat
                label={ledger.data?.scope === 'own' ? 'Paid to you' : 'Paid out'}
                value={money(t.paidOutMinor, cur)}
              />
              <Stat
                label="Blocked"
                value={t.blockedCount}
                tone={t.blockedCount ? 'danger' : undefined}
              />
            </div>
          )}
          <PaypalHolds deal={deal} milestoneKey={milestoneKey} />
          {invoicedMinor > 0 && (
            <p className="mt-3 flex items-baseline justify-between gap-2 rounded-lg bg-canvas px-3 py-2 text-[12px] text-umber">
              <span>Invoiced for change orders (not charged until paid)</span>
              <span className="t-num !text-[13px]">{money(invoicedMinor, cur)}</span>
            </p>
          )}

          {pending.length > 0 && (
            <div className="mt-4 space-y-2">
              {pending.map((p) => (
                <div
                  key={p.key}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2"
                >
                  <span className="text-[13px] text-ink">{p.reason}</span>
                  <button
                    className="btn-primary ml-auto !h-8 text-[12px]"
                    disabled={busy === p.key}
                    onClick={() => release(p.key)}
                  >
                    Release (one tap)
                  </button>
                </div>
              ))}
            </div>
          )}

          {entries.length === 0 ? (
            <p className="mt-4 text-[13px] text-umber">No money has moved yet</p>
          ) : (
            <ol className="relative mt-5 space-y-4 border-l border-line pl-5" aria-label="Ledger">
              {entries.map((e) => (
                <li key={e.seq} className="relative" data-testid={`ledger-${e.type}`}>
                  <span
                    className={`absolute -left-[25px] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-surface ${DOT[e.type] ?? 'bg-umber/50'}`}
                    aria-hidden="true"
                  />
                  {e.type === 'blocked' ? (
                    <BlockedLine entry={e} currency={cur} />
                  ) : e.type === 'invoice' ? (
                    <InvoiceLine entry={e} deal={deal} />
                  ) : (
                    <>
                      <LineHead entry={e} currency={cur} />
                      <p className="mt-0.5 text-[12px] text-umber">{e.explanation}</p>
                      {e.paypalRef && <PaypalId id={e.paypalRef} className="mt-1 max-w-full" />}
                    </>
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

function LineHead({
  entry: e,
  currency,
  amount,
}: {
  entry: DealLedgerEntry
  currency: string
  amount?: boolean
}) {
  const showAmount = amount ?? (e.moved && e.amountMinor > 0)
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <span
        className={`text-[13px] font-medium ${e.type === 'blocked' ? 'text-danger' : 'text-ink'}`}
      >
        {LABEL[e.type]}
      </span>
      {showAmount && (
        <span className="t-num !text-[14px]">{money(e.amountMinor, e.currency || currency)}</span>
      )}
      <span className="font-mono text-xs text-label">
        #{e.seq} · {e.milestoneKey} · {when(e.at)}
      </span>
    </div>
  )
}

/** A drafted change-order invoice: amount, line item and PayPal id; the long sentence sits behind "Details". */
function InvoiceLine({ entry: e, deal }: { entry: DealLedgerEntry; deal: DealView }) {
  const cur = e.currency || deal.terms.currency
  const co =
    deal.changeOrders.find(
      (c) => c.milestoneKey === e.milestoneKey && c.amountMinor === e.amountMinor && c.invoiceId,
    ) ?? deal.changeOrders.find((c) => c.milestoneKey === e.milestoneKey && c.invoiceId)
  const item = co ? deal.terms.rateCard.find((r) => r.id === co.rateCardItemId) : undefined
  const id = co?.invoiceId ?? e.paypalRef
  return (
    <>
      <LineHead entry={e} currency={cur} amount={e.amountMinor > 0} />
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-umber">
        {co && item && (
          <span>
            {co.quantity} × {item.label} @ {money(item.unitPriceMinor, cur)}
          </span>
        )}
        <span className="status-chip !h-5 bg-ink/[0.05] !text-xs text-umber">
          {invoiceSent(id) ? 'Sent · not paid yet' : 'Draft · not charged'}
        </span>
        {id && <PaypalInvoiceId id={id} />}
      </div>
      <Details>{e.explanation}</Details>
    </>
  )
}

/** A refused move: one human sentence, then the rules behind it on demand. */
function BlockedLine({ entry: e, currency }: { entry: DealLedgerEntry; currency: string }) {
  const s = blockedSummary(e, currency)
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-[13px] font-medium text-danger">{s.title}</span>
        <span className="font-mono text-xs text-label">
          #{e.seq} · {e.milestoneKey} · {when(e.at)}
        </span>
      </div>
      <p className="mt-0.5 text-[12.5px] text-ink/80">{s.reason}</p>
      <p className="mt-0.5 font-mono text-xs text-label">No money moved.</p>
      {s.ruleCount > 0 && (
        <details className="group mt-1.5">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded text-[12px] font-medium text-teal hover:text-teal-press [&::-webkit-details-marker]:hidden">
            <ChevronRight
              size={13}
              strokeWidth={2}
              className="transition-transform group-open:rotate-90"
              aria-hidden="true"
            />
            {s.ruleCount} policy {s.ruleCount === 1 ? 'rule' : 'rules'} failed
          </summary>
          <div className="mt-2">
            <PolicyBlockedChip
              violations={e.policy?.violations ?? []}
              currency={e.currency || currency}
              showFooter={false}
            />
          </div>
        </details>
      )}
    </>
  )
}

function Details({ children }: { children: string }) {
  if (!children) return null
  return (
    <details className="group mt-1">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[12px] text-umber hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={12}
          strokeWidth={2}
          className="transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
        Details
      </summary>
      <p className="mt-1 text-[12px] leading-relaxed text-umber">{children}</p>
    </details>
  )
}

/**
 * The PayPal objects behind each milestone: the hold (authorization id), every
 * capture id, and whether the rest of the hold was voided. Real sandbox ids are
 * tagged "PayPal sandbox"; anything simulated says so on its own tag.
 */
function PaypalHolds({ deal, milestoneKey }: { deal: DealView; milestoneKey?: string }) {
  const rows = deal.milestones.filter(
    (m) => (!milestoneKey || m.key === milestoneKey) && m.funding?.authorizationId,
  )
  if (!rows.length) return null
  return (
    <div className="mt-4 space-y-2 rounded-lg bg-canvas px-3 py-2.5" data-testid="paypal-holds">
      <p className="micro-label">PayPal ids</p>
      {rows.map((m) => {
        const title = deal.terms.milestones.find((t) => t.key === m.key)?.title ?? m.key
        const f = m.funding!
        return (
          <div key={m.key} className="min-w-0 space-y-1 text-[12px] text-umber">
            <p className="flex min-w-0 items-baseline justify-between gap-2">
              <span className="truncate font-medium text-ink">{title}</span>
              {typeof f.authorizedMinor === 'number' && f.authorizedMinor > 0 && (
                <span className="shrink-0 text-[12px]" data-testid={`held-${m.key}`}>
                  Held{' '}
                  <span className="t-num !text-[12px]">
                    {money(f.authorizedMinor, deal.terms.currency)}
                  </span>
                </span>
              )}
            </p>
            <p className="flex min-w-0 flex-wrap items-center gap-x-2">
              <span className="w-[86px] shrink-0">Authorization</span>
              <PaypalId id={f.authorizationId!} className="max-w-full" />
              <span className=" text-xs text-label">{f.status}</span>
            </p>
            {m.captures.map((c) => (
              <p key={c.id} className="flex min-w-0 flex-wrap items-center gap-x-2">
                <span className="w-[86px] shrink-0">Capture</span>
                <PaypalId id={c.id} className="max-w-full" />
                <span className="t-num !text-[12px]">
                  {money(c.amountMinor, deal.terms.currency)}
                </span>
              </p>
            ))}
          </div>
        )
      })}
    </div>
  )
}
