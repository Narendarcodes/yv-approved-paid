/**
 * Dashboard attention strip: four read-only totals worked out from data the
 * API already sends (GET /deals/payables and GET /deals/my-money). Nothing
 * here moves money or changes a clock; it only adds up rows.
 *
 *   held        - money PayPal holds right now (sum of heldMinor)
 *   dueThisWeek - reels in review whose decision deadline is in the next 7 days
 *   overdue     - reels past their review deadline (clock in grace, or partly released)
 *   onTheWay    - money already released but not yet paid out to the team;
 *                 for someone with no brand-side rows, their own share releasing now
 */

/** The payables fields the strip reads (a subset of the API row). */
export type AttentionPayable = {
  dealId: string
  milestoneKey: string
  title: string
  dealTitle: string
  currency: string
  heldMinor: number
  releasedMinor: number
  paidOutMinor: number
  state: string
  clockStatus: string | null
  businessDaysLeft: number | null
  deadline: string | null
}
export type AttentionMyMoney = { currency: string; status: string; expectedMinor: number }

export type MoneyTotal = Record<string, number>
export type Attention = {
  held: MoneyTotal
  heldCount: number
  dueThisWeek: number
  overdue: number
  onTheWay: MoneyTotal
  onTheWayCount: number
  onTheWaySource: 'payables' | 'my-money'
  /** true when there is nothing to show at all (no deals touch this person) */
  empty: boolean
}

const WEEK_MS = 7 * 24 * 3600 * 1000
const LIVE_CLOCK = ['running', 'paused', 'waiting_checks']
const OVERDUE_CLOCK = ['grace', 'released_partial']
/** States where a decision is still open (an approved or paid reel is never overdue). */
const OPEN = ['SUBMITTED', 'CHECKS', 'IN_REVIEW']

function add(t: MoneyTotal, currency: string, v: number) {
  if (!(v > 0)) return
  const c = currency || 'USD'
  t[c] = (t[c] || 0) + v
}

export function isDueThisWeek(r: AttentionPayable, nowMs: number): boolean {
  if (!OPEN.includes(r.state) || !r.clockStatus || !LIVE_CLOCK.includes(r.clockStatus)) return false
  if (!r.deadline) return false
  const d = Date.parse(r.deadline)
  return Number.isFinite(d) && d >= nowMs && d - nowMs <= WEEK_MS
}

export function isOverdue(r: AttentionPayable): boolean {
  return OPEN.includes(r.state) && !!r.clockStatus && OVERDUE_CLOCK.includes(r.clockStatus)
}

export function attentionOf(
  payables: AttentionPayable[],
  myMoney: AttentionMyMoney[],
  nowMs: number,
): Attention {
  const held: MoneyTotal = {}
  const onTheWay: MoneyTotal = {}
  let heldCount = 0
  let dueThisWeek = 0
  let overdue = 0
  let onTheWayCount = 0
  for (const r of payables) {
    if (r.heldMinor > 0) {
      add(held, r.currency, r.heldMinor)
      heldCount++
    }
    if (isDueThisWeek(r, nowMs)) dueThisWeek++
    if (isOverdue(r)) overdue++
    const owed = Math.max(0, (r.releasedMinor || 0) - (r.paidOutMinor || 0))
    if (owed > 0) {
      add(onTheWay, r.currency, owed)
      onTheWayCount++
    }
  }
  let source: Attention['onTheWaySource'] = 'payables'
  if (!payables.length) {
    source = 'my-money'
    for (const m of myMoney) {
      if (m.status === 'releasing' && m.expectedMinor > 0) {
        add(onTheWay, m.currency, m.expectedMinor)
        onTheWayCount++
      }
    }
  }
  return {
    held,
    heldCount,
    dueThisWeek,
    overdue,
    onTheWay,
    onTheWayCount,
    onTheWaySource: source,
    empty: !payables.length && !myMoney.length,
  }
}

/** Reels waiting on a brand decision, nearest deadline first (overdue ones lead). */
export function awaitingReview(payables: AttentionPayable[]): AttentionPayable[] {
  const at = (r: AttentionPayable) => (r.deadline ? Date.parse(r.deadline) : Infinity)
  return payables
    .filter((r) => r.state === 'IN_REVIEW')
    .sort((a, b) => Number(isOverdue(b)) - Number(isOverdue(a)) || at(a) - at(b))
}

/** The my-money fields the crew strip reads (a subset of the API row). */
export type CrewMoneyRow = AttentionMyMoney & {
  releasedMinor: number
  expected: { amountMinor: number; at: string | null }[]
}
export type CrewMoney = {
  /** still to come to me (my share minus what is paid) */
  expected: MoneyTotal
  expectedCount: number
  /** already paid to me */
  paid: MoneyTotal
  paidCount: number
  /** my share releasing right now (approved, payout on its way) */
  releasing: MoneyTotal
  releasingCount: number
  /** the nearest dated release still ahead (ISO), or null */
  next: string | null
  /** something is due on approval only (no date yet) */
  onApproval: boolean
}

/**
 * A crew member's own money, from GET /deals/my-money only: what is still to
 * come, what is paid and what is releasing now. Never a teammate's amount (the
 * API sends only the viewer's rows).
 */
export function crewMoneyOf(rows: CrewMoneyRow[], nowMs: number): CrewMoney {
  const expected: MoneyTotal = {}
  const paid: MoneyTotal = {}
  const releasing: MoneyTotal = {}
  let expectedCount = 0
  let paidCount = 0
  let releasingCount = 0
  let next: string | null = null
  let onApproval = false
  for (const r of rows) {
    if (['cancelled'].includes(r.status)) continue
    if (r.expectedMinor > 0) {
      add(expected, r.currency, r.expectedMinor)
      expectedCount++
    }
    if (r.releasedMinor > 0) {
      add(paid, r.currency, r.releasedMinor)
      paidCount++
    }
    if (r.status === 'releasing' && r.expectedMinor > 0) {
      add(releasing, r.currency, r.expectedMinor)
      releasingCount++
    }
    for (const e of r.expected || []) {
      if (!e.at) {
        onApproval = true
        continue
      }
      const t = Date.parse(e.at)
      if (Number.isFinite(t) && t >= nowMs && (!next || t < Date.parse(next))) next = e.at
    }
  }
  return {
    expected,
    expectedCount,
    paid,
    paidCount,
    releasing,
    releasingCount,
    next,
    onApproval,
  }
}

/** A crew desk's own Waiting on rows: only what waits on this person (by id), never a teammate's or a role's queue. */
export function ownBlocked<T extends { kind: string; id?: string }>(
  blocked: T[],
  userId: string,
): T[] {
  return userId ? blocked.filter((b) => b.kind === 'user' && b.id === userId) : []
}
