/**
 * /deals/:dealId: one deal. A one-line header (title, client, total held, the
 * terms), a rail of reels, and the selected reel on the right. ?reel=<key>
 * picks the reel and ?open=checks,money (or all) opens its sections, so any
 * view of a deal is a link. The cards are the same ones the copilot renders in
 * chat, so the whole demo works with no LLM.
 *
 * Also handles the PayPal return URL /deals/:dealId/fund/:key?paypal=approved|cancelled.
 * AI checks facts, people own taste, the deal decides the money.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Bot } from 'lucide-react'
import { Modal } from '../components/primitives'
import { CardSkeleton, EmptyState, ErrorBanner } from '../components/states'
import { useToast } from '../components/toast'
import DealCard from '../components/deals/DealCard'
import DealCopilot from '../components/deals/DealCopilot'
import DealTeamCard from '../components/deals/DealTeamCard'
import JudgeTour, { scrollToWhenReady } from '../components/deals/JudgeTour'
import ReelRail from '../components/deals/ReelRail'
import ReelPanel, { type SectionId } from '../components/deals/ReelPanel'
import * as api from '../services/api'
import type { DealView } from '../contracts/types'
import { DEMO_DEAL_PATH, money, useDeal, useDealRefresh } from '../lib/deals'

const SECTIONS: SectionId[] = ['checks', 'payout', 'changes', 'money', 'terms']

/** The reel that needs someone first: a decision, a hold to fund, a change order; else the first not paid out. */
function firstReel(deal: DealView): string {
  const keys = deal.terms.milestones.map((t) => t.key)
  const needs = keys.find((k) => {
    const r = deal.milestones.find((m) => m.key === k)
    if (!r) return false
    if (deal.me === 'client' && ['IN_REVIEW', 'SIGNED', 'DISPUTED'].includes(r.state)) return true
    return (
      deal.me === 'client' &&
      deal.changeOrders.some((c) => c.milestoneKey === k && c.status === 'draft')
    )
  })
  const open = keys.find((k) => deal.milestones.find((m) => m.key === k)?.state !== 'PAID_OUT')
  return needs ?? open ?? keys[0]
}

/** What is still held across the deal: authorized minus captured, per reel (amounts from the deal). */
function heldOf(deal: DealView): number {
  return deal.terms.milestones.reduce((a, t) => {
    const r = deal.milestones.find((m) => m.key === t.key)
    if (!r) return a
    return (
      a + Math.max(0, Math.min(t.amountMinor, r.funding?.authorizedMinor ?? 0) - r.capturedMinor)
    )
  }, 0)
}
export default function DealPage() {
  const { dealId, key: fundKey } = useParams()
  const [search, setSearch] = useSearchParams()
  const navigate = useNavigate()
  const toast = useToast()
  const { data: deal, orgId, isLoading, isError, refetch } = useDeal(dealId)
  const refresh = useDealRefresh(orgId, dealId)
  const confirmed = useRef(false)
  const [copilot, setCopilot] = useState(false)
  const [termsOpen, setTermsOpen] = useState(false)
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

  const reel = useMemo(() => {
    if (!deal) return ''
    const want = search.get('reel')
    return want && deal.terms.milestones.some((t) => t.key === want) ? want : firstReel(deal)
  }, [deal, search])
  const open = useMemo(() => {
    const raw = search.get('open') || ''
    return new Set<SectionId>(
      raw === 'all'
        ? SECTIONS
        : (raw.split(',') as SectionId[]).filter((x) => SECTIONS.includes(x)),
    )
  }, [search])
  const setParams = useCallback(
    (next: { reel?: string; open?: Set<SectionId> }) => {
      setSearch(
        (prev) => {
          const p = new URLSearchParams(prev)
          if (next.reel) p.set('reel', next.reel)
          if (next.open) {
            if (next.open.size) p.set('open', [...next.open].join(','))
            else p.delete('open')
          }
          return p
        },
        { replace: true },
      )
    },
    [setSearch],
  )
  const toggle = (id: SectionId) => {
    const n = new Set(open)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    setParams({ open: n })
  }
  const openSection = (id: SectionId, scrollTo?: string, reelKey?: string) => {
    setParams({ reel: reelKey, open: new Set([...open, id]) })
    scrollToWhenReady(scrollTo || `#section-${id}`)
  }

  return (
    <div className="fade-in">
      {isLoading ? (
        <div className="space-y-4">
          <CardSkeleton lines={2} />
          <CardSkeleton lines={6} />
        </div>
      ) : isError || !orgId ? (
        <ErrorBanner
          message="This deal did not load. It may not exist, or you may not be a party to it."
          onRetry={() => void refetch()}
        />
      ) : !deal ? (
        <EmptyState title="Deal not found" />
      ) : (
        <>
          <header className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2">
            <Link to="/deals" className="icon-btn icon-btn-sm text-umber" aria-label="All deals">
              <ArrowLeft size={16} strokeWidth={1.5} />
            </Link>
            <h1 className="min-w-0 truncate text-[20px] font-medium tracking-[-0.01em] text-ink">
              {deal.terms.title}
            </h1>
            <p className="order-last flex min-w-0 basis-full flex-wrap items-center gap-x-2 text-[14px] text-umber sm:order-none sm:basis-auto sm:flex-1">
              <span>
                {deal.terms.client.displayName}
                {deal.me === 'client' ? ' (you)' : ''}
              </span>
              <span aria-hidden="true">·</span>
              <span data-testid="deal-held">
                <span className="t-num text-ink">{money(heldOf(deal), deal.terms.currency)}</span>{' '}
                held
              </span>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                className="text-umber underline-offset-2 hover:text-ink hover:underline"
                onClick={() => setTermsOpen(true)}
                data-testid="deal-terms-link"
              >
                Terms
              </button>
            </p>
            <div className="ml-auto flex items-center gap-1">
              {isDemoDeal && (
                <JudgeTour
                  onMoney={() => openSection('money', '[data-testid=money-timeline]')}
                  onDispute={() => {
                    const k = deal.milestones.find(
                      (m) => m.state === 'DISPUTED' || m.proposals?.dispute,
                    )?.key
                    setParams({ reel: k })
                    scrollToWhenReady('[data-testid=dispute-split-card]')
                  }}
                  onAsk={(text) => {
                    setCopilot(true)
                    setAutoAsk((prev) => ({ text, nonce: (prev?.nonce ?? 0) + 1 }))
                  }}
                />
              )}
              <button
                className="btn-ghost btn-xs"
                onClick={() => setCopilot((v) => !v)}
                aria-expanded={copilot}
              >
                <Bot size={14} strokeWidth={1.5} />
                {copilot ? 'Hide copilot' : 'Ask the copilot'}
              </button>
            </div>
          </header>

          {!deal.termsHash && (
            <div className="mb-6 space-y-5">
              <DealCard deal={deal} orgId={orgId} onChanged={changed} />
              <DealTeamCard deal={deal} orgId={orgId} onChanged={changed} />
            </div>
          )}

          <div
            className={`grid gap-6 lg:grid-cols-[208px_minmax(0,1fr)] ${copilot ? 'xl:grid-cols-[208px_minmax(0,1fr)_380px]' : ''}`}
          >
            <ReelRail deal={deal} selected={reel} onSelect={(k) => setParams({ reel: k })} />
            <ReelPanel
              key={reel}
              deal={deal}
              orgId={orgId}
              mkey={reel}
              open={open}
              onToggle={toggle}
              onOpen={(id, to) => openSection(id, to)}
              onChanged={changed}
            />
            {copilot && (
              <div className="min-w-0 lg:col-span-2 xl:col-span-1">
                <DealCopilot deal={deal} orgId={orgId} autoAsk={autoAsk} />
              </div>
            )}
          </div>

          <Modal
            open={termsOpen}
            onClose={() => setTermsOpen(false)}
            title="Terms"
            width="max-w-3xl"
          >
            <div className="space-y-5">
              <DealCard deal={deal} orgId={orgId} onChanged={changed} />
              <DealTeamCard deal={deal} orgId={orgId} onChanged={changed} />
            </div>
          </Modal>
        </>
      )}
    </div>
  )
}
