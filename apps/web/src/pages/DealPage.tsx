/**
 * /deals/:dealId: one deal, as cards. The same card components the copilot
 * renders in chat render here directly, so the whole demo works with no LLM.
 *
 * Also handles the PayPal return URL /deals/:dealId/fund/:key?paypal=approved|cancelled.
 * AI checks facts, people own taste, the deal decides the money.
 */
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Bot } from 'lucide-react'
import { PageHeader } from '../components/ui'
import { CardSkeleton, EmptyState, ErrorBanner } from '../components/states'
import { StatusChip } from '../components/status'
import { useToast } from '../components/toast'
import { Motto } from '../components/deals/common'
import DealCard from '../components/deals/DealCard'
import LiveChecksCard from '../components/deals/LiveChecksCard'
import ReviewMergeCard from '../components/deals/ReviewMergeCard'
import MoneyTimeline from '../components/deals/MoneyTimeline'
import ChangeOrderCard from '../components/deals/ChangeOrderCard'
import DisputeSplitCard from '../components/deals/DisputeSplitCard'
import DealCopilot from '../components/deals/DealCopilot'
import * as api from '../services/api'
import { roleWord, useDeal, useDealRefresh } from '../lib/deals'

export default function DealPage() {
  const { dealId, key: fundKey } = useParams()
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const toast = useToast()
  const { data: deal, orgId, isLoading, isError, refetch } = useDeal(dealId)
  const refresh = useDealRefresh(orgId, dealId)
  const confirmed = useRef(false)
  // copilot open on wide screens, closed on small ones
  const [copilot, setCopilot] = useState(() => typeof window === 'undefined' || window.matchMedia?.('(min-width: 1024px)').matches !== false)

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
      .then((r) => toast(r.result?.outcome === 'done' ? 'success' : 'warning', r.result?.outcome === 'done' ? 'Hold placed on PayPal' : 'Hold not placed yet', 'An authorization, not a charge.'))
      .catch((e: any) => toast('danger', 'Could not confirm the hold', e?.message || 'Try again'))
      .finally(() => {
        void refresh()
        done()
      })
  }, [fundKey, orgId, dealId, search, navigate, toast, refresh])

  const changed = () => void refresh()
  const toReview = (key: string) => document.getElementById(`review-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <div className="fade-in">
      <Link to="/deals" className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-umber hover:text-ink">
        <ArrowLeft size={14} strokeWidth={2} /> All deals
      </Link>
      {isLoading ? (
        <div className="space-y-4">
          <CardSkeleton lines={4} />
          <CardSkeleton lines={6} />
        </div>
      ) : isError || !orgId ? (
        <ErrorBanner message="This deal did not load. It may not exist, or you may not be a party to it." onRetry={() => void refetch()} />
      ) : !deal ? (
        <EmptyState title="Deal not found" hint="Open one from the deals list." />
      ) : (
        <>
          <PageHeader
            title={deal.terms.title}
            subtitle={`You are the ${roleWord(deal.me).toLowerCase()} on this deal.`}
            actions={
              <button className="btn-secondary" onClick={() => setCopilot((v) => !v)} aria-expanded={copilot}>
                <Bot size={15} strokeWidth={1.75} />
                {copilot ? 'Hide copilot' : 'Ask the copilot'}
              </button>
            }
          />
          <Motto className="-mt-3 mb-5" />
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_420px]">
            <div className="min-w-0 space-y-5">
              <DealCard deal={deal} orgId={orgId} onChanged={changed} />
              {deal.terms.milestones.map((t) => {
                const r = deal.milestones.find((m) => m.key === t.key)
                if (!r) return null
                const cos = deal.changeOrders.filter((c) => c.milestoneKey === t.key)
                return (
                  <section key={t.key} className="space-y-4" aria-labelledby={`ms-${t.key}`}>
                    <div className="flex items-center gap-3 pt-2">
                      <h2 id={`ms-${t.key}`} className="font-headline text-[17px] font-semibold text-ink">
                        {t.title}
                      </h2>
                      <StatusChip status={r.state} />
                    </div>
                    <LiveChecksCard deal={deal} orgId={orgId} milestoneKey={t.key} onChanged={changed} onRequestChanges={() => toReview(t.key)} />
                    {(r.proposals?.review || r.state === 'IN_REVIEW') && (
                      <div id={`review-${t.key}`}>
                        <ReviewMergeCard deal={deal} orgId={orgId} milestoneKey={t.key} onChanged={changed} />
                      </div>
                    )}
                    {cos.map((c) => (
                      <ChangeOrderCard key={c.id} deal={deal} orgId={orgId} changeOrderId={c.id} onChanged={changed} />
                    ))}
                    {(r.proposals?.dispute || r.state === 'DISPUTED') && (
                      <DisputeSplitCard deal={deal} orgId={orgId} milestoneKey={t.key} onChanged={changed} />
                    )}
                  </section>
                )
              })}
            </div>
            <div className="min-w-0 space-y-5">
              {copilot && <DealCopilot deal={deal} orgId={orgId} />}
              <MoneyTimeline deal={deal} orgId={orgId} onChanged={changed} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
