/**
 * /deals: every deal the signed-in user is a party to (Approved = Paid).
 * AI checks facts, people own taste, the deal decides the money.
 */
import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { PageHeader } from '../components/ui'
import { EmptyState, ErrorBanner, ListSkeleton } from '../components/states'
import { StatusChip, StatusDot, stageOf } from '../components/status'
import { money, useDeals } from '../lib/deals'

export default function DealsPage() {
  const { data: deals, isLoading, isError, refetch } = useDeals()
  return (
    <div className="fade-in">
      <PageHeader title="Deals" />
      {isLoading ? (
        <ListSkeleton rows={3} height="h-24" />
      ) : isError ? (
        <ErrorBanner message="Your deals did not load." onRetry={() => void refetch()} />
      ) : !deals?.length ? (
        <EmptyState title="No deals yet" illustration="deal" />
      ) : (
        <ul className="card divide-y divide-line overflow-hidden" data-testid="deals-list">
          {deals.map((d) => {
            const total = d.terms.milestones.reduce((a, m) => a + m.amountMinor, 0)
            const captured = d.milestones.reduce((a, m) => a + (m.capturedMinor || 0), 0)
            return (
              <li key={d.id}>
                <Link
                  to={`/deals/${encodeURIComponent(d.id)}`}
                  className="row-link flex items-center gap-4 px-5 py-3.5"
                >
                  <span className="min-w-0 flex-1 truncate text-[15px] text-ink">
                    {d.terms.title}
                  </span>
                  {!d.termsHash && <StatusChip status="DRAFT" label="Draft" />}
                  <span className="hidden items-center gap-1 sm:flex" aria-label="Reels">
                    {d.milestones.map((m) => (
                      <span
                        key={m.key}
                        title={`${m.key}: ${m.state.replace(/_/g, ' ').toLowerCase()}`}
                      >
                        <StatusDot stage={stageOf(m.state)} className="!h-2 !w-2" />
                      </span>
                    ))}
                  </span>
                  <span className="t-num w-[170px] text-right text-[14px] text-umber">
                    <span className="text-ink">{money(captured, d.terms.currency)}</span> of{' '}
                    {money(total, d.terms.currency)}
                  </span>
                  <ArrowRight size={16} strokeWidth={1.5} className="text-label" />
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
