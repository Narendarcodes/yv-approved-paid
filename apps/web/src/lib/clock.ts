/**
 * Fair Review Clock helpers for the deal page: the polled clock view, dates in
 * the reviewer's timezone, timeline labels and the progress maths. Every amount
 * and date comes from the API (signed terms + frozen schedule); nothing here
 * computes money.
 */
import { useQuery } from '@tanstack/react-query'
import * as api from '../services/api'
import type { ClockEvent, ClockTermsSpec, ClockView } from '../services/api'
import type { DealMilestoneTerms, DealView } from '../contracts/types'
import { money } from './deals'

/** How often an open deal page re-reads a clock (the API also pushes ledger lines). */
export const CLOCK_POLL_MS = 15_000

/** The setup panel's defaults: 3 business days, 50% partial, 3 grace days, 2 rounds. */
export const CLOCK_DEFAULTS: Required<Omit<ClockTermsSpec, 'backupReviewerId'>> = {
  reviewWindowBusinessDays: 3,
  partialReleasePct: 50,
  graceBusinessDays: 3,
  includedRevisionRounds: 2,
}

/** A milestone's signed clock terms (generated contract types predate terms.clock). */
export function clockTermsOf(t: DealMilestoneTerms | undefined): ClockTermsSpec | undefined {
  return (t as (DealMilestoneTerms & { clock?: ClockTermsSpec }) | undefined)?.clock
}

export function useMilestoneClock(orgId: string | null, dealId: string | undefined, key: string, enabled = true) {
  return useQuery({
    queryKey: ['deal-clock', orgId, dealId, key],
    queryFn: () => api.getMilestoneClock(orgId as string, dealId as string, key),
    enabled: enabled && !!orgId && !!dealId,
    refetchInterval: CLOCK_POLL_MS,
    refetchIntervalInBackground: false,
  })
}

/** "Wed 11 Nov, 6:00 PM IST" in the reviewer's timezone. */
export function inZone(iso: string | null | undefined, tz: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  try {
    const day = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(d)
    const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(d)
    let zone =
      new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? tz
    if (/^GMT[+-]/.test(zone))
      zone = new Intl.DateTimeFormat('en-IN', { timeZone: tz, timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? zone
    return `${day.replace(',', '')}, ${time} ${zone}`
  } catch {
    return d.toLocaleString()
  }
}

/** Short headline for the big countdown. */
export function countdown(v: ClockView): { big: string; small?: string } {
  const n = v.state.businessDaysLeft
  const days = `${n} business day${n === 1 ? '' : 's'} left`
  if (v.status === 'waiting_checks') return { big: 'Not started', small: 'Starts when the automatic checks pass' }
  if (v.status === 'approved') return { big: 'Approved' }
  if (v.status === 'released') return { big: 'Released' }
  if (v.status === 'disputed') return { big: 'Disputed' }
  if (v.status === 'stopped') return { big: 'Stopped' }
  if (v.status === 'paused') return { big: days, small: 'Paused while the editor makes changes' }
  if (v.state.status === 'released_partial' || v.state.status === 'grace') return { big: 'In grace', small: 'The review window ended with no reply' }
  if (v.state.status === 'released_full') return { big: 'Released' }
  return { big: days }
}

/**
 * Where the review window stands, 0..1, on the schedule's own timeline (pauses
 * stop it), plus the reminder markers: 50%, 80% and 24 h before the deadline.
 */
export function progressOf(v: ClockView, nowMs = Date.now()) {
  if (!v.startedAt || !v.state.deadline) return null
  const start = Date.parse(v.startedAt)
  const deadline = Date.parse(v.state.deadline) - v.state.shiftMs
  const win = Math.max(1, deadline - start)
  const eff = nowMs - v.pausedMs
  const clamp = (x: number) => Math.min(1, Math.max(0, x))
  const grace = v.state.graceDeadline ? Date.parse(v.state.graceDeadline) - v.state.shiftMs : deadline
  return {
    window: clamp((eff - start) / win),
    grace: grace > deadline ? clamp((eff - deadline) / (grace - deadline)) : eff >= deadline ? 1 : 0,
    hasGrace: grace > deadline,
    markers: [
      { id: 'remind_50', at: 0.5, label: '50%' },
      { id: 'remind_80', at: 0.8, label: '80%' },
      { id: 'final_24h', at: clamp((deadline - 24 * 3600 * 1000 - start) / win), label: '24 h' },
    ],
  }
}

/** Who did it, as a role word (identity-blind, like the rest of the deal UI). */
export function byWord(deal: DealView, by?: string): string {
  if (!by || by === 'system') return 'Clock'
  if (by === deal.terms.client.userId) return 'Client'
  if (by === deal.terms.worker.userId) return 'Editor'
  return 'Reviewer'
}

/** One timeline line in plain words. */
export function eventText(e: ClockEvent, currency: string): string {
  const amt = e.amountMinor !== undefined ? money(e.amountMinor, currency) : ''
  switch (e.id) {
    case 'started':
      return 'Review clock started: automatic checks passed'
    case 'remind_50':
      return 'Reminder: half the review window used'
    case 'remind_80':
      return 'Reminder: 80% of the review window used'
    case 'final_24h':
      return amt ? `Final reminder: 24 hours before ${amt} releases` : 'Final reminder: 24 hours left'
    case 'release_partial':
      return `Partial release: ${amt} to the team`
    case 'release_grace':
      return amt ? `Grace ended: the remaining ${amt} releases` : 'Grace ended: the rest releases'
    case 'changes_requested':
      return `Changes requested${e.note ? ` (${e.note})` : ''}; clock paused`
    case 'resumed':
      return 'Clock resumed: the redelivery passed the checks'
    case 'checks_failed':
      return 'Redelivery failed a check; clock stays paused'
    case 'approved':
      return 'Approved: the full amount releases'
    case 'disputed':
      return 'Disputed: the clock stopped, the rest is frozen'
    case 'released':
      return 'No reply in time: counted as approved'
    case 'killed':
      return 'Milestone cancelled: the clock stopped'
    case 'hold_reauthorized':
      return 'PayPal hold renewed'
    case 'hold_lapsing':
      return 'PayPal hold lapses before the clock ends: the client was asked to re-fund'
    default:
      return e.id.replace(/_/g, ' ')
  }
}
