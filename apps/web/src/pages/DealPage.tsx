/**
 * /deals/:dealId: one deal, as cards. The same card components the copilot
 * renders in chat render here directly, so the whole demo works with no LLM.
 *
 * Also handles the PayPal return URL /deals/:dealId/fund/:key?paypal=approved|cancelled.
 * AI checks facts, people own taste, the deal decides the money.
 */
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Bot, Receipt } from 'lucide-react'
import { PageHeader } from '../components/ui'
import { CardSkeleton, EmptyState, ErrorBanner } from '../components/states'
import { StatusChip } from '../components/status'
import { useToast } from '../components/toast'
import DealCard from '../components/deals/DealCard'
import LiveChecksCard from '../components/deals/LiveChecksCard'
import ReviewMergeCard from '../components/deals/ReviewMergeCard'
import MoneyTimeline from '../components/deals/MoneyTimeline'
import ChangeOrderCard from '../components/deals/ChangeOrderCard'
import DisputeSplitCard from '../components/deals/DisputeSplitCard'
import DealCopilot from '../components/deals/DealCopilot'
import DealTeamCard from '../components/deals/DealTeamCard'
import JudgeTour from '../components/deals/JudgeTour'
import ReviewClockCard from '../components/deals/ReviewClockCard'
import ClockTermsCard from '../components/deals/ClockTermsCard'
import TeamPayoutCard from '../components/deals/TeamPayoutCard'
import { clockTermsOf } from '../lib/clock'
import * as api from '../services/api'
import { DEMO_DEAL_PATH, invoiceSent, money, useDeal, useDealRefresh } from '../lib/deals'

export default function DealPage() {
  const { dealId, key: fundKey } = useParams()
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const toast = useToast()
  const { data: deal, orgId, isLoading, isError, refetch } = useDeal(dealId)
  const refresh = useDealRefresh(orgId, dealId)
  const confirmed = useRef(false)
  // copilot open on wide screens, closed on small ones
  const [copilot, setCopilot] = useState(
    () =>
      typeof window === 'undefined' || window.matchMedia?.('(min-width: 1024px)').matches !== false,
  )
  const [autoAsk, setAutoAsk] = useState<{ text: string; nonce: number } | null>(null)
  const isDemoDeal = `/deals/${dealId}` === DEMO_DEAL_PATH

  // PayPal sent the buyer back: confirm the hold once, then drop the return path.
  useEffect(() => {
    if (!fundKey || !orgId || !dealId || confirmed.current) return
    confirmed.current = true
    const outcome = search.get('paypal')
    const done = () => navigate(`/deals/${encodeURIComponent(dealId)}`, { replace: true })
    if (outcome !== 'approved') {
      toast('info', 'Funding cancelled', 'No hold was placed.')
      done()
      return
    }
    api
      .confirmDealFunding(orgId, dealId, fundKey)
      .then((r) =>
        toast(
          r.result?.outcome === 'done' ? 'success' : 'warning',
          r.result?.outcome === 'done' ? 'Hold placed on PayPal' : 'Hold not placed yet',
          'An authorization, not a charge.',
        ),
      )
      .catch((e: any) => toast('danger', 'Could not confirm the hold', e?.message || 'Try again'))
      .finally(() => {
        void refresh()
        done()
      })
  }, [fundKey, orgId, dealId, search, navigate, toast, refresh])

  const changed = () => void refresh()
  const toReview = (key: string) =>
    document.getElementById(`review-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  const toChangeOrder = (id: string) =>
    document.getElementById(`co-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  // change orders waiting on the client, and what has been billed so far (amounts from the deal, never typed)
  const waitingCos = deal?.changeOrders.filter((c) => c.status === 'draft') ?? []
  const invoicedCos = deal?.changeOrders.filter((c) => c.status === 'invoiced') ?? []

  return (
    <div className="fade-in">
      <Link
        to="/deals"
        className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-umber hover:text-ink"
      >
        <ArrowLeft size={14} strokeWidth={2} /> All deals
      </Link>
      {isLoading ? (
        <div className="space-y-4">
          <CardSkeleton lines={4} />
          <CardSkeleton lines={6} />
        </div>
      ) : isError || !orgId ? (
        <ErrorBanner
          message="This deal did not load. It may not exist, or you may not be a party to it."
          onRetry={() => void refetch()}
        />
      ) : !deal ? (
        <EmptyState title="Deal not found" hint="Open one from the deals list." />
      ) : (
        <>
          <PageHeader
            title={deal.terms.title}
            actions={
              <button
                className="btn-secondary"
                onClick={() => setCopilot((v) => !v)}
                aria-expanded={copilot}
              >
                <Bot size={15} strokeWidth={1.75} />
                {copilot ? 'Hide copilot' : 'Ask the copilot'}
              </button>
            }
          />
          {isDemoDeal && (
            <JudgeTour
              onAsk={(text) => {
                setCopilot(true)
                setAutoAsk((prev) => ({ text, nonce: (prev?.nonce ?? 0) + 1 }))
              }}
            />
          )}
          {(waitingCos.length > 0 || invoicedCos.length > 0) && (
            <div
              className={`mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-4 py-3 ${waitingCos.length ? 'border-st-production/25 bg-st-production-bg' : 'border-line bg-surface'}`}
              data-testid="change-order-banner"
            >
              <Receipt
                size={16}
                strokeWidth={1.75}
                className={waitingCos.length ? 'text-st-production' : 'text-teal'}
                aria-hidden="true"
              />
              <p className="min-w-0 flex-1 text-[13px] text-ink">
                {waitingCos.length ? (
                  <>
                    {waitingCos.length === 1
                      ? 'A change order is'
                      : `${waitingCos.length} change orders are`}{' '}
                    waiting for the client:{' '}
                    <span className="t-num">
                      {money(
                        waitingCos.reduce((a, c) => a + c.amountMinor, 0),
                        deal.terms.currency,
                      )}
                    </span>{' '}
                    from the signed rate card.
                  </>
                ) : (
                  <>
                    {invoicedCos.length === 1
                      ? 'One change order'
                      : `${invoicedCos.length} change orders`}{' '}
                    invoiced in PayPal:{' '}
                    <span className="t-num">
                      {money(
                        invoicedCos.reduce((a, c) => a + c.amountMinor, 0),
                        deal.terms.currency,
                      )}
                    </span>
                    ,{' '}
                    {invoicedCos.every((c) => invoiceSent(c.invoiceId))
                      ? 'sent and not paid yet'
                      : 'drafted and not charged yet'}
                    .
                  </>
                )}
              </p>
              {waitingCos.length ? (
                <button
                  className="btn-primary btn-xs"
                  onClick={() => toChangeOrder(waitingCos[0].id)}
                >
                  {deal.me === 'client' ? 'Review & accept' : 'View'}{' '}
                  <ArrowRight size={13} strokeWidth={2} />
                </button>
              ) : (
                <Link to="/invoices" className="btn-secondary btn-xs">
                  View invoices <ArrowRight size={13} strokeWidth={2} />
                </Link>
              )}
            </div>
          )}
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_420px]">
            <div className="min-w-0 space-y-5">
              <DealCard deal={deal} orgId={orgId} onChanged={changed} />
              <DealTeamCard deal={deal} orgId={orgId} onChanged={changed} />
              {deal.terms.milestones.map((t) => {
                const r = deal.milestones.find((m) => m.key === t.key)
                if (!r) return null
                const cos = deal.changeOrders.filter((c) => c.milestoneKey === t.key)
                // a milestone on the Fair Review Clock: the clock card owns approve / changes / dispute
                const clocked = !!clockTermsOf(t) && !!deal.termsHash
                const showTerms = !deal.termsHash || !!clockTermsOf(t)
                return (
                  <section key={t.key} className="space-y-4" aria-labelledby={`ms-${t.key}`}>
                    <div className="flex items-center gap-3 pt-2">
                      <h2
                        id={`ms-${t.key}`}
                        className="font-headline text-[17px] font-semibold text-ink"
                      >
                        {t.title}
                      </h2>
                      <StatusChip status={r.state} />
                    </div>
                    {clocked && (
                      <ReviewClockCard
                        deal={deal}
                        orgId={orgId}
                        milestoneKey={t.key}
                        onChanged={changed}
                      />
                    )}
                    <LiveChecksCard
                      deal={deal}
                      orgId={orgId}
                      milestoneKey={t.key}
                      onChanged={changed}
                      onRequestChanges={() => toReview(t.key)}
                      hideDecisions={clocked}
                    />
                    {showTerms && (
                      <ClockTermsCard
                        deal={deal}
                        orgId={orgId}
                        milestoneKey={t.key}
                        onChanged={changed}
                      />
                    )}
                    {(r.proposals?.review || (r.state === 'IN_REVIEW' && !clocked)) && (
                      <div id={`review-${t.key}`}>
                        <ReviewMergeCard
                          deal={deal}
                          orgId={orgId}
                          milestoneKey={t.key}
                          onChanged={changed}
                        />
                      </div>
                    )}
                    {cos.map((c) => (
                      <div key={c.id} id={`co-${c.id}`} className="scroll-mt-20">
                        <ChangeOrderCard
                          deal={deal}
                          orgId={orgId}
                          changeOrderId={c.id}
                          onChanged={changed}
                        />
                      </div>
                    ))}
                    {(r.proposals?.dispute || r.state === 'DISPUTED') && (
                      <DisputeSplitCard
                        deal={deal}
                        orgId={orgId}
                        milestoneKey={t.key}
                        onChanged={changed}
                      />
                    )}
                    {!!deal.termsHash &&
                      t.payees.length > 0 &&
                      (r.payouts.length > 0 || deal.me === 'worker') && (
                        <TeamPayoutCard deal={deal} orgId={orgId} milestoneKey={t.key} />
                      )}
                  </section>
                )
              })}
            </div>
            <div className="min-w-0 space-y-5">
              {copilot && <DealCopilot deal={deal} orgId={orgId} autoAsk={autoAsk} />}
              <MoneyTimeline deal={deal} orgId={orgId} onChanged={changed} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
