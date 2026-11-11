// Crew dashboard + chat helpers: the Money strip reads my money only, Waiting on is the viewer's own rows, chat picks one Team Chat and never hangs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crewMoneyOf, ownBlocked } from '../src/lib/attention.ts'
import { pickChatProject, withTimeout } from '../src/lib/chatLoad.ts'

const NOW = Date.parse('2026-11-11T14:30:00Z')
const row = (o) => ({
  currency: 'USD',
  status: 'clock_running',
  expectedMinor: 0,
  releasedMinor: 0,
  expected: [],
  ...o,
})

test('crewMoneyOf: still to come, paid, releasing and the next dated release (own rows only)', () => {
  const c = crewMoneyOf(
    [
      row({ expectedMinor: 28000, expected: [{ amountMinor: 28000, at: '2026-11-14T12:00:00Z' }] }),
      row({ status: 'paid', releasedMinor: 31500 }),
      row({
        status: 'releasing',
        expectedMinor: 10500,
        expected: [{ amountMinor: 10500, at: null }],
      }),
      row({ status: 'cancelled', expectedMinor: 9999 }),
      row({ expectedMinor: 100, expected: [{ amountMinor: 100, at: '2026-11-01T00:00:00Z' }] }),
    ],
    NOW,
  )
  assert.deepEqual(c.expected, { USD: 28000 + 10500 + 100 })
  assert.equal(c.expectedCount, 3)
  assert.deepEqual(c.paid, { USD: 31500 })
  assert.deepEqual(c.releasing, { USD: 10500 })
  assert.equal(c.next, '2026-11-14T12:00:00Z') // the past date is skipped
  assert.equal(c.onApproval, true)
})

test('crewMoneyOf: no rows is all zero, no next date', () => {
  const c = crewMoneyOf([], NOW)
  assert.deepEqual(c.expected, {})
  assert.equal(c.next, null)
  assert.equal(c.onApproval, false)
})

test("ownBlocked: only the viewer's own person row, never a teammate's, a role's or the client's", () => {
  const blocked = [
    { kind: 'user', id: 'leo', name: 'Leo Carter', count: 2 },
    { kind: 'user', id: 'maya', name: 'Maya', count: 3 },
    { kind: 'role', name: 'Reviewers', count: 4 },
    { kind: 'client', name: 'Lumen Coffee', count: 1 },
    { kind: 'user', name: 'Leo Carter', count: 9 }, // no id: not matched by name
  ]
  assert.deepEqual(
    ownBlocked(blocked, 'leo').map((b) => b.count),
    [2],
  )
  assert.deepEqual(ownBlocked(blocked, ''), [])
})

test('pickChatProject: the oldest exact "Team Chat", ignoring look-alikes', () => {
  const p = pickChatProject([
    { id: 'b', title: 'Team Chat', createdAt: '2026-10-02' },
    { id: 'x', title: 'Team Chat notes', createdAt: '2026-01-01' },
    { id: 'a', title: 'Team Chat', createdAt: '2026-09-01' },
  ])
  assert.equal(p.id, 'a')
  assert.equal(pickChatProject([{ id: 'x', title: 'team chat' }]), undefined)
})

test('withTimeout: a load that never settles rejects; a quick one resolves', async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 30), /timeout/)
  assert.equal(await withTimeout(Promise.resolve(7), 30), 7)
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 30), /boom/)
})
