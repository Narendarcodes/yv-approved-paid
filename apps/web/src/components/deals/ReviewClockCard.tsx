/**
 * ReviewClockCard: the Fair Review Clock on one milestone, the same card for
 * both sides. One line: state, business days left (or what silence pays the
 * editor, and when), and the client's actions. The chevron opens the detail:
 * progress bar with the 50% / 80% / 24 h marks, the plain-English silence
 * rule, rounds used, and the shared timeline.
 *
 * Client: Approve & release (confirms the exact amount), Request changes (the
 * picker requires a brief item or failed check), Dispute (confirms that it
 * freezes the rest). Polls every 15 s. Every amount and date comes from the API.
 */
import { useMemo, useState } from 'react'
import { AlertTriangle, ChevronDown, CircleCheck, Gavel, Receipt } from 'lucide-react'
import { Modal } from '../primitives'
import { useToast } from '../toast'
import * as api from '../../services/api'
import type { ClockChangesReply, ClockView } from '../../services/api'
import type { DealView } from '../../contracts/types'
import { milestonePair, money } from '../../lib/deals'
import {
  byWord,
  countdown,
  eventText,
  inZone,
  progressOf,
  useMilestoneClock,
} from '../../lib/clock'
import { HINT } from '../../lib/copy'

type Dialog = null | 'approve' | 'changes' | 'dispute'

function StatusPill({ v }: { v: ClockView }) {
  const s =
    v.status === 'running' && (v.state.status === 'released_partial' || v.state.status === 'grace')
      ? 'grace'
      : v.status
  const map: Record<string, [string, string]> = {
    waiting_checks: ['Waiting for checks', 'bg-ink/[0.05] text-umber'],
    running: ['Running', 'bg-st-review-bg text-st-review'],
    paused: ['Paused', 'bg-st-production-bg text-st-production'],
    grace: ['In grace', 'bg-st-production-bg text-st-production'],
    approved: ['Approved', 'bg-st-scheduled-bg text-st-scheduled'],
    released: ['Released', 'bg-st-live-bg text-st-live'],
    disputed: ['Disputed', 'bg-st-failed-bg text-st-failed'],
    stopped: ['Stopped', 'bg-ink/[0.05] text-umber'],
  }
  const [label, cls] = map[s] || [s, 'bg-ink/[0.05] text-umber']
  return (
    <span className={`status-chip ${cls}`} data-testid="clock-status">
      <span className="status-dot" aria-hidden="true" />
      {label}
    </span>
  )
}

function Bar({ v }: { v: ClockView }) {
  const p = progressOf(v)
  if (!p) return null
  const inGrace = p.window >= 1 && p.hasGrace && v.status === 'running'
  // two marks closer than ~8% of the bar: the later label drops a line so they never overlap
  const sorted = [...p.markers].sort((a, b) => a.at - b.at)
  const lifted = new Set(
    sorted.filter((m, i) => i > 0 && m.at - sorted[i - 1].at < 0.08).map((m) => m.id),
  )
  return (
    <div className="mt-4" data-testid="clock-progress">
      <div
        className="relative h-2 rounded-full bg-ink/[0.06]"
        role="progressbar"
        aria-label="Review window used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(p.window * 100)}
      >
        <div
          className={`absolute inset-y-0 left-0 rounded-full ${v.status === 'paused' ? 'bg-st-production' : 'bg-teal'}`}
          style={{ width: `${p.window * 100}%` }}
        />
        {p.markers.map((m) => (
          <span
            key={m.id}
            className="absolute -top-1 h-4 w-px bg-ink/40"
            style={{ left: `${m.at * 100}%` }}
            aria-hidden="true"
          />
        ))}
      </div>
      <div
        className={`relative mt-1 font-mono text-xs text-label ${lifted.size ? 'h-8' : 'h-4'}`}
        aria-hidden="true"
      >
        {p.markers.map((m) => (
          <span
            key={m.id}
            className={`absolute whitespace-nowrap ${lifted.has(m.id) ? 'top-4' : 'top-0'} ${m.at > 0.9 ? '-translate-x-full' : m.at < 0.08 ? '' : '-translate-x-1/2'} ${v.doneSteps.includes(m.id) ? 'text-ink' : ''}`}
            style={{ left: `${m.at * 100}%` }}
          >
            {m.label}
          </span>
        ))}
      </div>
      {inGrace && (
        <div className="mt-2">
          <p className="micro-label">Grace</p>
          <div
            className="relative mt-1 h-1.5 rounded-full bg-ink/[0.06]"
            role="progressbar"
            aria-label="Grace period used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(p.grace * 100)}
          >
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-st-production"
              style={{ width: `${p.grace * 100}%` }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

export default function ReviewClockCard({
  deal,
  orgId,
  milestoneKey,
  onChanged,
}: {
  deal: DealView
  orgId: string
  milestoneKey: string
  onChanged?: () => void
}) {
  const toast = useToast()
  const q = useMilestoneClock(orgId, deal.id, milestoneKey)
  const pair = milestonePair(deal, milestoneKey)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [busy, setBusy] = useState(false)
  const [citation, setCitation] = useState('')
  const [text, setText] = useState('')
  const [pickError, setPickError] = useState<string | null>(null)
  const [reply, setReply] = useState<ClockChangesReply | null>(null)
  const [open, setOpen] = useState(false)
  const v = q.data
  const cur = deal.terms.currency

  // what a change request may cite: every brief line, plus the failed checks on the latest version
  const options = useMemo(() => {
    if (!pair) return []
    const latest = pair.runtime.versions[pair.runtime.versions.length - 1]
    const failed = new Set([
      ...(latest?.checks?.failed ?? []),
      ...(latest?.checks?.unmeasured ?? []),
    ])
    const brief = pair.terms.checklist.map((c) => ({
      id: c.id,
      text: c.text,
      kind: failed.has(c.id) ? ('failed' as const) : ('brief' as const),
    }))
    const extra = [...failed]
      .filter((id) => !pair.terms.checklist.some((c) => c.id === id))
      .map((id) => ({ id, text: id, kind: 'failed' as const }))
    return [
      ...brief.filter((o) => o.kind === 'failed'),
      ...extra,
      ...brief.filter((o) => o.kind === 'brief'),
    ]
  }, [pair])

  if (!pair || q.isLoading) {
    return q.isLoading ? (
      <div className="card flex items-center gap-3 px-4 py-3" aria-busy="true">
        <div className="skeleton h-5 w-20" />
        <div className="skeleton h-4 w-56" />
      </div>
    ) : null
  }
  if (q.isError) {
    return (
      <div className="card flex flex-wrap items-center gap-3 p-4 text-[13px]" role="alert">
        <AlertTriangle size={16} className="text-danger" aria-hidden="true" />
        <span className="min-w-0 flex-1 text-ink">The review clock did not load.</span>
        <button className="btn-secondary btn-xs" onClick={() => void q.refetch()}>
          Retry
        </button>
      </div>
    )
  }
  if (!v) return null

  const { runtime } = pair
  const tz = v.terms.tz
  const cd = countdown(v)
  const live = v.status === 'running' || v.status === 'paused'
  const inReview = v.milestoneState === 'IN_REVIEW'
  const isClient = deal.me === 'client'
  const isEditor = deal.me === 'worker'
  const held = Math.max(
    0,
    Math.min(v.amounts?.amountMinor ?? 0, runtime.funding?.authorizedMinor ?? 0) -
      runtime.capturedMinor,
  )
  const total = v.amounts?.amountMinor ?? 0
  const graceNow = v.state.status === 'released_partial' || v.state.status === 'grace'
  const roundsLeft = v.includedRevisionRounds - v.revisionsUsed
  const roundItem =
    deal.terms.rateCard.find((r) => r.id === 'revision_round') ||
    deal.terms.rateCard.find((r) => /revision/i.test(`${r.id} ${r.label}`))
  const latest = runtime.versions[runtime.versions.length - 1]

  const refresh = () => {
    void q.refetch()
    onChanged?.()
  }
  const close = () => {
    setDialog(null)
    setPickError(null)
    setReply(null)
    setCitation('')
    setText('')
  }

  const doApprove = async () => {
    setBusy(true)
    try {
      await api.clockApprove(orgId, deal.id, milestoneKey)
      toast(
        'success',
        'Approved and released',
        `${money(held, cur)} releases to the team through policy.`,
      )
      close()
      refresh()
    } catch (e: any) {
      toast('danger', 'Could not approve', e?.message || 'Try again')
    } finally {
      setBusy(false)
    }
  }
  const doChanges = async () => {
    if (!citation) {
      setPickError('Choose the brief item first')
      return
    }
    setBusy(true)
    setPickError(null)
    try {
      const r = await api.clockRequestChanges(orgId, deal.id, milestoneKey, {
        citation,
        text: text.trim() || undefined,
      })
      if (r.changeOrderRequired) {
        setReply(r)
      } else {
        toast('success', 'Changes requested', 'The clock is paused until the editor redelivers.')
        close()
      }
      refresh()
    } catch (e: any) {
      setPickError(e?.message || 'Could not send the change request')
    } finally {
      setBusy(false)
    }
  }
  const doDispute = async () => {
    setBusy(true)
    try {
      await api.clockDispute(orgId, deal.id, milestoneKey)
      toast(
        'warning',
        'Dispute opened',
        `The clock stopped; ${money(held, cur)} stays frozen in the hold.`,
      )
      close()
      refresh()
    } catch (e: any) {
      toast('danger', 'Could not open the dispute', e?.message || 'Try again')
    } finally {
      setBusy(false)
    }
  }

  // editor: what silence pays, and when
  const silence =
    isEditor && live && v.amounts
      ? graceNow
        ? [{ amount: v.amounts.remainderCents, at: v.state.graceDeadline }]
        : [
            ...(v.amounts.partialAmountCents > 0
              ? [{ amount: v.amounts.partialAmountCents, at: v.state.deadline }]
              : []),
            { amount: v.amounts.remainderCents, at: v.state.graceDeadline },
          ]
      : []

  const when =
    live && v.state.deadline
      ? graceNow
        ? `grace ends ${inZone(v.state.graceDeadline, tz)}`
        : `ends ${inZone(v.state.deadline, tz)}`
      : cd.small

  return (
    <>
      <section className="card overflow-hidden" data-testid="review-clock-card">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
          <StatusPill v={v} />
          <p className="min-w-0 flex-1 text-[14px] text-ink">
            <span className="font-medium" data-testid="clock-countdown">
              {cd.big}
            </span>
            {silence.length > 0 ? (
              <span className="text-umber" data-testid="clock-silence">
                {' '}
                · <span className="t-num">{money(silence[0].amount, cur)}</span> to you{' '}
                {inZone(silence[0].at, tz)}
              </span>
            ) : (
              when && <span className="text-umber"> · {when}</span>
            )}
          </p>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {isClient && live && (
              <>
                <button
                  className="btn-primary btn-xs"
                  disabled={busy || !inReview || !latest}
                  onClick={() => setDialog('approve')}
                >
                  <CircleCheck size={14} strokeWidth={2} />
                  Approve &amp; release
                </button>
                <button
                  className="btn-ghost btn-xs"
                  disabled={busy || !inReview}
                  onClick={() => setDialog('changes')}
                >
                  Request changes
                </button>
                <button
                  className="icon-btn icon-btn-sm text-umber hover:text-danger"
                  disabled={busy}
                  onClick={() => setDialog('dispute')}
                  aria-label="Dispute"
                  title="Dispute"
                >
                  <Gavel size={15} strokeWidth={1.75} />
                </button>
              </>
            )}
            <button
              className="icon-btn icon-btn-sm text-umber"
              aria-expanded={open}
              aria-label="Clock details"
              title="Clock details"
              onClick={() => setOpen((o) => !o)}
              data-testid="clock-timeline-toggle"
            >
              <ChevronDown
                size={15}
                className={`transition-transform ${open ? 'rotate-180' : ''}`}
                aria-hidden="true"
              />
            </button>
          </div>
        </div>

        {isClient && live && inReview && (
          <p className="-mt-1 px-4 pb-3 text-[12px] text-umber" data-testid="decision-hint">
            {HINT.clockSilence}
          </p>
        )}
        {open && (
          <div className="border-t border-line px-4 pb-4 pt-1">
            {live && <Bar v={v} />}
            <p className="mt-3 text-[13px] leading-snug text-ink" data-testid="clock-line">
              {v.state.line}
            </p>
            {silence.length > 1 && (
              <ul className="mt-2 space-y-0.5 text-[13px] text-umber">
                {silence.map((s, i) => (
                  <li key={i}>
                    <span className="t-num text-ink">{money(s.amount, cur)}</span> on{' '}
                    {inZone(s.at, tz)}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <span
                className={`chip ${roundsLeft <= 0 ? 'chip-warning' : 'chip-neutral'}`}
                data-testid="clock-rounds"
              >
                Revisions {v.revisionsUsed} of {v.includedRevisionRounds}
              </span>
              {v.amounts && v.terms.partialReleasePct > 0 && (
                <span className="chip chip-neutral">
                  {v.terms.partialReleasePct}% on silence · {v.terms.graceBusinessDays} grace day
                  {v.terms.graceBusinessDays === 1 ? '' : 's'}
                </span>
              )}
              <span className="chip chip-neutral">
                Held {money(held, cur)} of {money(total, cur)}
              </span>
            </div>
            <ol className="mt-4 space-y-2" data-testid="clock-timeline">
              {v.timeline.length === 0 && (
                <li className="text-[13px] text-umber">Starts when the checks pass</li>
              )}
              {[...v.timeline]
                .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
                .map((e, i) => (
                  <li key={`${e.id}-${i}`} className="flex gap-2.5 text-[13px]">
                    <span
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${e.id.startsWith('release') ? 'bg-st-live' : e.kind === 'action' ? 'bg-teal' : 'bg-ink/30'}`}
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <p className="text-ink">{eventText(e, cur)}</p>
                      <p className="text-xs text-umber">
                        {inZone(e.at, tz)} · {byWord(deal, e.by)}
                        {e.note &&
                        !['changes_requested'].includes(e.id) &&
                        e.note !== 'automatic checks passed'
                          ? ` · ${e.note}`
                          : ''}
                      </p>
                    </div>
                  </li>
                ))}
            </ol>
          </div>
        )}
      </section>

      <Modal open={dialog === 'approve'} onClose={close} title="Approve and release">
        <p className="text-[14px] text-ink">
          Approve version <span className="font-mono">{latest?.id}</span> and release{' '}
          <span className="t-num font-semibold">{money(held, cur)}</span> to the team now
          {held < total
            ? ` (the rest of ${money(total, cur)}; ${money(total - held, cur)} was already released)`
            : ''}
          .
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button className="btn-secondary" onClick={close}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={busy}
            onClick={doApprove}
            data-testid="confirm-approve"
          >
            Release {money(held, cur)}
          </button>
        </div>
      </Modal>

      <Modal open={dialog === 'dispute'} onClose={close} title="Open a dispute">
        <p className="text-[14px] text-ink">
          This stops the review clock and freezes the{' '}
          <span className="t-num font-semibold">{money(held, cur)}</span> still held. Nothing more
          releases on silence until the dispute is settled.
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button className="btn-secondary" onClick={close}>
            Cancel
          </button>
          <button className="btn-danger" disabled={busy} onClick={doDispute}>
            Dispute and freeze
          </button>
        </div>
      </Modal>

      <Modal
        open={dialog === 'changes'}
        onClose={close}
        title={reply ? 'Paid change order' : 'Request changes'}
      >
        {reply ? (
          <div data-testid="change-order-result">
            <div className="flex items-start gap-2.5 rounded-[10px] border border-st-production/25 bg-st-production-bg px-3 py-2.5">
              <Receipt
                size={16}
                className="mt-0.5 shrink-0 text-st-production"
                aria-hidden="true"
              />
              <p className="text-[13.5px] text-ink">
                {reply.changeOrder ? (
                  <>
                    All {v.includedRevisionRounds} included rounds are used, so this is a paid
                    change order:{' '}
                    <span className="t-num font-semibold">
                      {money((reply.changeOrder as any).amountMinor, cur)}
                    </span>{' '}
                    from the signed rate card,{' '}
                    {reply.invoice?.outcome === 'done'
                      ? 'invoiced in PayPal.'
                      : 'not invoiced yet.'}
                  </>
                ) : (
                  <>
                    All included rounds are used and{' '}
                    {reply.reason || 'no change order could be priced'}.
                  </>
                )}
              </p>
            </div>
            <div className="mt-5 flex justify-end">
              <button className="btn-primary" onClick={close}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              void doChanges()
            }}
            data-testid="change-picker"
          >
            <label className="label block" htmlFor="clock-change-cite">
              Which brief item?
            </label>
            <p className="mt-0.5 text-[12px] text-umber">{HINT.requestChanges}</p>
            <select
              id="clock-change-cite"
              className="input mt-1 w-full"
              required
              aria-required="true"
              aria-invalid={!!pickError}
              value={citation}
              onChange={(e) => {
                setCitation(e.target.value)
                setPickError(null)
              }}
            >
              <option value="" disabled>
                Choose one
              </option>
              {options.some((o) => o.kind === 'failed') && (
                <optgroup label="Failed checks">
                  {options
                    .filter((o) => o.kind === 'failed')
                    .map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.text}
                      </option>
                    ))}
                </optgroup>
              )}
              <optgroup label="Brief">
                {options
                  .filter((o) => o.kind === 'brief')
                  .map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.text}
                    </option>
                  ))}
              </optgroup>
            </select>
            <label className="label mt-4 block" htmlFor="clock-change-text">
              Note
            </label>
            <textarea
              id="clock-change-text"
              className="input mt-1 !h-20 w-full py-2"
              maxLength={2000}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="What should change?"
            />
            <p
              className={`mt-3 text-[13px] ${roundsLeft <= 0 ? 'text-st-production' : 'text-umber'}`}
            >
              {roundsLeft <= 0
                ? `Paid change order${roundItem ? ` · ${money(roundItem.unitPriceMinor, cur)}` : ''}`
                : `Round ${v.revisionsUsed + 1} of ${v.includedRevisionRounds}`}
            </p>
            {pickError && (
              <p
                className="mt-3 text-[12.5px] text-danger"
                role="alert"
                data-testid="change-picker-error"
              >
                {pickError}
              </p>
            )}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={close}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn-primary"
                disabled={busy}
                data-testid="send-changes"
              >
                Send change request
              </button>
            </div>
          </form>
        )}
      </Modal>
    </>
  )
}
