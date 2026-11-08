/**
 * ReelPanel: the selected reel. On top, the delivered cut, the one next action
 * and the clock state in one line. Under it, quiet sections that open on
 * demand: checks, team payout, change orders, money trail, review terms.
 * Action cards (review merge, dispute split) sit with the next action, since
 * they are the next action. Every amount comes from the deal; nothing here
 * computes money.
 */
import { ArrowRight, Film, Wallet } from 'lucide-react'
import type { DealView } from '../../contracts/types'
import { StatusChip } from '../status'
import * as api from '../../services/api'
import { clockTermsOf } from '../../lib/clock'
import { money, shortHash } from '../../lib/deals'
import ReviewClockCard from './ReviewClockCard'
import LiveChecksCard from './LiveChecksCard'
import ClockTermsCard from './ClockTermsCard'
import ReviewMergeCard from './ReviewMergeCard'
import ChangeOrderCard from './ChangeOrderCard'
import DisputeSplitCard from './DisputeSplitCard'
import TeamPayoutCard from './TeamPayoutCard'
import MoneyTimeline from './MoneyTimeline'
import DealSection from './DealSection'
import { useFundMilestone } from './DealCard'

export type SectionId = 'checks' | 'payout' | 'changes' | 'money' | 'terms'

/** What the state means in money, next to the state chip. */
function stateLine(deal: DealView, key: string): string {
  const t = deal.terms.milestones.find((m) => m.key === key)
  const r = deal.milestones.find((m) => m.key === key)
  if (!t || !r) return ''
  const cur = deal.terms.currency
  const held = Math.max(
    0,
    Math.min(t.amountMinor, r.funding?.authorizedMinor ?? 0) - r.capturedMinor,
  )
  switch (r.state) {
    case 'DRAFT':
      return 'Not signed'
    case 'SIGNED':
      return 'Waiting for the hold'
    case 'FUNDED':
    case 'STYLE_SAMPLE':
      return `${money(held, cur)} held`
    case 'SUBMITTED':
    case 'CHECKS':
      return 'Checks running'
    case 'IN_REVIEW':
      return `${money(held, cur)} held`
    case 'CHANGES_REQUESTED':
      return 'Editor is making changes'
    case 'APPROVED':
    case 'AUTO_APPROVED':
    case 'CAPTURED':
      return `${money(r.capturedMinor, cur)} captured`
    case 'PAID_OUT':
      return `${money(r.paidOutMinor, cur)} paid out`
    case 'DISPUTED':
      return `${money(held, cur)} frozen`
    default:
      return ''
  }
}

/** The delivered cut: the first evidence frame of the latest checked version, or a quiet placeholder. */
function CutTile({ deal, orgId, mkey }: { deal: DealView; orgId: string; mkey: string }) {
  const r = deal.milestones.find((m) => m.key === mkey)
  const versions = r?.versions ?? []
  const latest = versions[versions.length - 1]
  const frame = [...versions]
    .reverse()
    .flatMap((v) => v.checks?.results ?? [])
    .flatMap((x) => x.evidence ?? [])
    .find((e) => e.screenshot)?.screenshot
  return (
    <div
      className="relative flex aspect-video w-[120px] shrink-0 sm:w-[168px] items-center justify-center overflow-hidden rounded-lg border border-line bg-canvas"
      data-testid="reel-cut"
    >
      {frame ? (
        <img
          src={api.dealEvidenceUrl(orgId, deal.id, frame)}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
        />
      ) : (
        <Film size={20} strokeWidth={1.5} className="text-label" aria-hidden="true" />
      )}
      {latest && (
        <span
          className="absolute bottom-1 left-1 rounded bg-ink/70 px-1.5 py-px text-xs text-on-accent"
          title={latest.sha256}
        >
          {latest.id} · {shortHash(latest.sha256, 6)}
        </span>
      )}
    </div>
  )
}

export default function ReelPanel({
  deal,
  orgId,
  mkey,
  open,
  onToggle,
  onOpen,
  onChanged,
}: {
  deal: DealView
  orgId: string
  mkey: string
  open: Set<SectionId>
  onToggle: (id: SectionId) => void
  onOpen: (id: SectionId, scrollTo?: string) => void
  onChanged: () => void
}) {
  const { fund, funding } = useFundMilestone(deal, orgId, onChanged)
  const t = deal.terms.milestones.find((m) => m.key === mkey)
  const r = deal.milestones.find((m) => m.key === mkey)
  if (!t || !r) return null
  const cur = deal.terms.currency
  const cos = deal.changeOrders.filter((c) => c.milestoneKey === mkey)
  const waitingCo = deal.me === 'client' ? cos.find((c) => c.status === 'draft') : undefined
  const clocked = !!clockTermsOf(t) && !!deal.termsHash
  const showTerms = !deal.termsHash || !!clockTermsOf(t)
  const showPayout =
    !!deal.termsHash && t.payees.length > 0 && (r.payouts.length > 0 || deal.me === 'worker')
  const latest = r.versions[r.versions.length - 1]
  const machineN = t.checklist.filter((c) => c.kind !== 'taste').length
  const passedN = latest?.checks
    ? (latest.checks.results?.filter((x) => x.passed && x.status === 'ok').length ??
      machineN - latest.checks.failed.length)
    : null
  const canFund = deal.me === 'client' && r.state === 'SIGNED'
  const reviewPending = !!r.proposals?.review || (r.state === 'IN_REVIEW' && !clocked)
  // a merged review is the next action only while the reel is still in review; after that it is history under Checks
  const reviewNow = reviewPending && ['IN_REVIEW', 'CHANGES_REQUESTED'].includes(r.state)
  const nonClockedReview = !clocked && r.state === 'IN_REVIEW' && deal.me === 'client'

  return (
    <section aria-labelledby={`ms-${mkey}`} className="min-w-0" data-testid="reel-panel">
      <div className="flex items-start gap-4">
        <CutTile deal={deal} orgId={orgId} mkey={mkey} />
        <div className="min-w-0 flex-1 pt-0.5">
          <h2 id={`ms-${mkey}`} className="text-[17px] font-medium text-ink">
            {t.title}
          </h2>
          <p className="t-num mt-1 text-[14px] text-umber">{money(t.amountMinor, cur)}</p>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {waitingCo && (
          <div className="card flex flex-wrap items-center gap-3 px-4 py-3">
            <p className="min-w-0 flex-1 text-[14px] text-ink">
              Change order{' '}
              <span className="t-num text-umber">· {money(waitingCo.amountMinor, cur)}</span>
            </p>
            <button
              className="btn-primary btn-xs"
              onClick={() => onOpen('changes', `#co-${waitingCo.id}`)}
            >
              Review &amp; accept <ArrowRight size={13} strokeWidth={2} />
            </button>
          </div>
        )}
        {clocked ? (
          <ReviewClockCard deal={deal} orgId={orgId} milestoneKey={mkey} onChanged={onChanged} />
        ) : (
          <div
            className="card flex flex-wrap items-center gap-3 px-4 py-3"
            data-testid="reel-state"
          >
            <StatusChip status={r.state} />
            <p className="min-w-0 flex-1 text-[14px] text-ink">{stateLine(deal, mkey)}</p>
            {canFund && (
              <button
                className="btn-primary btn-xs"
                disabled={funding === mkey}
                onClick={() => fund(mkey)}
              >
                <Wallet size={14} strokeWidth={2} />
                Fund with PayPal
              </button>
            )}
            {nonClockedReview && (
              <button className="btn-primary btn-xs" onClick={() => onOpen('checks')}>
                Review
              </button>
            )}
          </div>
        )}
        {reviewNow && (
          <div id={`review-${mkey}`} className="scroll-mt-20">
            <ReviewMergeCard deal={deal} orgId={orgId} milestoneKey={mkey} onChanged={onChanged} />
          </div>
        )}
        {(r.proposals?.dispute || r.state === 'DISPUTED') && (
          <DisputeSplitCard deal={deal} orgId={orgId} milestoneKey={mkey} onChanged={onChanged} />
        )}
      </div>

      <div className="mt-6">
        <DealSection
          id="checks"
          title="Checks"
          meta={passedN === null ? undefined : `${passedN} of ${machineN} passed`}
          open={open.has('checks')}
          onToggle={() => onToggle('checks')}
        >
          <LiveChecksCard
            deal={deal}
            orgId={orgId}
            milestoneKey={mkey}
            onChanged={onChanged}
            onRequestChanges={() =>
              document
                .getElementById(`review-${mkey}`)
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
            hideDecisions={clocked}
          />
          {reviewPending && !reviewNow && (
            <div className="mt-5">
              <ReviewMergeCard
                deal={deal}
                orgId={orgId}
                milestoneKey={mkey}
                onChanged={onChanged}
              />
            </div>
          )}
        </DealSection>
        {showPayout && (
          <DealSection
            id="payout"
            title="Team payout"
            meta={r.paidOutMinor > 0 ? money(r.paidOutMinor, cur) : undefined}
            open={open.has('payout')}
            onToggle={() => onToggle('payout')}
          >
            <TeamPayoutCard deal={deal} orgId={orgId} milestoneKey={mkey} />
          </DealSection>
        )}
        {cos.length > 0 && (
          <DealSection
            id="changes"
            title="Change orders"
            meta={cos.length}
            open={open.has('changes')}
            onToggle={() => onToggle('changes')}
          >
            <div className="space-y-4">
              {cos.map((c) => (
                <div key={c.id} id={`co-${c.id}`} className="scroll-mt-20">
                  <ChangeOrderCard
                    deal={deal}
                    orgId={orgId}
                    changeOrderId={c.id}
                    onChanged={onChanged}
                  />
                </div>
              ))}
            </div>
          </DealSection>
        )}
        <DealSection
          id="money"
          title="Money trail"
          open={open.has('money')}
          onToggle={() => onToggle('money')}
        >
          <MoneyTimeline deal={deal} orgId={orgId} milestoneKey={mkey} onChanged={onChanged} />
        </DealSection>
        {showTerms && (
          <DealSection
            id="terms"
            title="Review terms"
            open={open.has('terms')}
            onToggle={() => onToggle('terms')}
          >
            <ClockTermsCard deal={deal} orgId={orgId} milestoneKey={mkey} onChanged={onChanged} />
          </DealSection>
        )}
      </div>
    </section>
  )
}
