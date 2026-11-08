/**
 * /deals: every deal the signed-in user is a party to (Approved = Paid).
 * AI checks facts, people own taste, the deal decides the money.
 */
import { Link } from 'react-router-dom'
import { ArrowRight, Handshake } from 'lucide-react'
import { PageHeader } from '../components/ui'
import { EmptyState, ErrorBanner, ListSkeleton } from '../components/states'
import { StatusChip } from '../components/status'
import { money, roleWord, useDeals } from '../lib/deals'

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
        <EmptyState title="No deals yet" />
      ) : (
        <ul className="space-y-3" data-testid="deals-list">
          {deals.map((d) => {
            const total = d.terms.milestones.reduce((a, m) => a + m.amountMinor, 0)
            const captured = d.milestones.reduce((a, m) => a + (m.capturedMinor || 0), 0)
            return (
              <li key={d.id}>
                <Link
                  to={`/deals/${encodeURIComponent(d.id)}`}
                  className="card card-hover flex flex-wrap items-center gap-4 px-5 py-4"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-canvas text-teal">
                    <Handshake size={18} strokeWidth={1.75} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="card-title">{d.terms.title}</p>
                    <p className="mt-0.5 text-[12px] text-umber">
                      You are the {roleWord(d.me).toLowerCase()} · {d.terms.milestones.length}{' '}
                      milestone(s) · {d.termsHash ? 'signed by both' : 'draft'}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {d.milestones.map((m) => (
                        <StatusChip
                          key={m.key}
                          status={m.state}
                          label={`${m.key} · ${m.state.replace(/_/g, ' ').toLowerCase()}`}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="micro-label">Captured / signed</p>
                    <p className="t-num text-[16px]">
                      {money(captured, d.terms.currency)} / {money(total, d.terms.currency)}
                    </p>
                  </div>
                  <ArrowRight size={16} strokeWidth={2} className="text-label" />
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
