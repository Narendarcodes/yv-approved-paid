// Unit tests for the dashboard attention strip totals (read-only sums over payables / my-money rows).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attentionOf, awaitingReview, isDueThisWeek, isOverdue } from '../src/lib/attention.ts'

const NOW = Date.parse('2026-11-08T15:00:00Z')
const day = 24 * 3600 * 1000
const row = (o) => ({
  dealId: 'd',
  milestoneKey: 'k',
  title: 't',
  dealTitle: 'D',
  currency: 'USD',
  heldMinor: 0,
  releasedMinor: 0,
  paidOutMinor: 0,
  state: 'FUNDED',
  clockStatus: null,
  businessDaysLeft: null,
  deadline: null,
  ...o,
})

test('held sums heldMinor per currency and counts reels', () => {
  const a = attentionOf(
    [
      row({ heldMinor: 20000 }),
      row({ heldMinor: 15000 }),
      row({ heldMinor: 5000, currency: 'INR' }),
    ],
    [],
    NOW,
  )
  assert.deepEqual(a.held, { USD: 35000, INR: 5000 })
  assert.equal(a.heldCount, 3)
  assert.equal(a.empty, false)
})

test('due this week: live clock, open state, deadline within 7 days', () => {
  const soon = row({
    state: 'IN_REVIEW',
    clockStatus: 'running',
    deadline: new Date(NOW + 2 * day).toISOString(),
  })
  const far = row({
    state: 'IN_REVIEW',
    clockStatus: 'running',
    deadline: new Date(NOW + 9 * day).toISOString(),
  })
  const approved = row({
    state: 'APPROVED',
    clockStatus: 'running',
    deadline: new Date(NOW + day).toISOString(),
  })
  assert.equal(isDueThisWeek(soon, NOW), true)
  assert.equal(isDueThisWeek(far, NOW), false)
  assert.equal(isDueThisWeek(approved, NOW), false)
  assert.equal(attentionOf([soon, far, approved], [], NOW).dueThisWeek, 1)
})

test('overdue: clock in grace or partly released while still in review', () => {
  assert.equal(isOverdue(row({ state: 'IN_REVIEW', clockStatus: 'grace' })), true)
  assert.equal(isOverdue(row({ state: 'IN_REVIEW', clockStatus: 'released_partial' })), true)
  assert.equal(isOverdue(row({ state: 'IN_REVIEW', clockStatus: 'running' })), false)
  assert.equal(isOverdue(row({ state: 'PAID_OUT', clockStatus: 'released_full' })), false)
})

test('on the way: released minus paid out; my-money fallback only without payables', () => {
  const a = attentionOf(
    [row({ releasedMinor: 40000, paidOutMinor: 40000 }), row({ releasedMinor: 10000 })],
    [],
    NOW,
  )
  assert.deepEqual(a.onTheWay, { USD: 10000 })
  assert.equal(a.onTheWaySource, 'payables')
  const b = attentionOf(
    [],
    [
      { currency: 'USD', status: 'releasing', expectedMinor: 7000 },
      { currency: 'USD', status: 'clock_running', expectedMinor: 9000 },
    ],
    NOW,
  )
  assert.deepEqual(b.onTheWay, { USD: 7000 })
  assert.equal(b.onTheWaySource, 'my-money')
  assert.equal(attentionOf([], [], NOW).empty, true)
})

test('awaiting review lists IN_REVIEW reels, overdue first, then nearest deadline', () => {
  const a = row({
    milestoneKey: 'a',
    state: 'IN_REVIEW',
    clockStatus: 'running',
    deadline: new Date(NOW + 3 * day).toISOString(),
  })
  const b = row({
    milestoneKey: 'b',
    state: 'IN_REVIEW',
    clockStatus: 'running',
    deadline: new Date(NOW + day).toISOString(),
  })
  const c = row({
    milestoneKey: 'c',
    state: 'IN_REVIEW',
    clockStatus: 'grace',
    deadline: new Date(NOW - day).toISOString(),
  })
  const d = row({ milestoneKey: 'd', state: 'FUNDED' })
  assert.deepEqual(
    awaitingReview([a, b, c, d]).map((r) => r.milestoneKey),
    ['c', 'b', 'a'],
  )
})
