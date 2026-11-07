// Unit tests for the payables plain-language filter parser (node:test, no vitest in apps/web).
// Run: npm test   (node --experimental-strip-types --test tests/)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseFilter,
  parseClause,
  matchesAll,
  matches,
  filtersToText,
  daysToLapse,
  LAPSING_SOON_DAYS,
} from '../src/lib/payablesFilter.ts'

const NOW = Date.parse('2026-11-07T12:00:00Z')
const DAY = 24 * 3600 * 1000
const strip = (fs) =>
  fs.map((f) => {
    const rest = { ...f }
    delete rest.text
    delete rest.label
    return rest
  })

test('held over $300', () => {
  assert.deepEqual(strip(parseFilter('held over $300')), [{ kind: 'held', op: 'gt', minor: 30000 }])
  assert.equal(parseClause('held over $300').label, 'Held > $300')
  assert.deepEqual(strip(parseFilter('held > 1,250.50')), [
    { kind: 'held', op: 'gt', minor: 125050 },
  ])
  assert.deepEqual(strip(parseFilter('Held at least ₹1.5k')), [
    { kind: 'held', op: 'gte', minor: 150000 },
  ])
  assert.deepEqual(strip(parseFilter('held under $50')), [{ kind: 'held', op: 'lt', minor: 5000 }])
  assert.deepEqual(strip(parseFilter('over $300 held')), [{ kind: 'held', op: 'gt', minor: 30000 }])
})

test('waiting 3+ days / 3 or more days left', () => {
  assert.deepEqual(strip(parseFilter('waiting 3+ days')), [{ kind: 'waiting', op: 'gte', days: 3 }])
  assert.deepEqual(strip(parseFilter('waiting 3 or more days')), [
    { kind: 'waiting', op: 'gte', days: 3 },
  ])
  assert.deepEqual(strip(parseFilter('waiting over 2 days')), [
    { kind: 'waiting', op: 'gt', days: 2 },
  ])
  assert.deepEqual(strip(parseFilter('3 or more days left')), [
    { kind: 'daysLeft', op: 'gte', days: 3 },
  ])
  assert.deepEqual(strip(parseFilter('3+ days left')), [{ kind: 'daysLeft', op: 'gte', days: 3 }])
  assert.deepEqual(strip(parseFilter('2 business days left')), [
    { kind: 'daysLeft', op: 'lte', days: 2 },
  ])
  assert.deepEqual(strip(parseFilter('less than 2 days left')), [
    { kind: 'daysLeft', op: 'lt', days: 2 },
  ])
  assert.equal(parseClause('3 or more days left').label, 'Clock ≥ 3 days left')
})

test('in grace, failed checks, lapsing soon, ready to approve', () => {
  assert.deepEqual(strip(parseFilter('in grace')), [{ kind: 'grace' }])
  assert.deepEqual(strip(parseFilter('grace period')), [{ kind: 'grace' }])
  assert.deepEqual(strip(parseFilter('failed checks')), [{ kind: 'failedChecks' }])
  assert.deepEqual(strip(parseFilter('with failed checks')), [{ kind: 'failedChecks' }])
  assert.deepEqual(strip(parseFilter('lapsing soon')), [
    { kind: 'lapsing', days: LAPSING_SOON_DAYS },
  ])
  assert.deepEqual(strip(parseFilter('hold expiring soon')), [
    { kind: 'lapsing', days: LAPSING_SOON_DAYS },
  ])
  assert.deepEqual(strip(parseFilter('ready to approve')), [{ kind: 'approvable' }])
})

test('editor Ravi', () => {
  assert.deepEqual(strip(parseFilter('editor Ravi')), [{ kind: 'person', name: 'ravi' }])
  assert.equal(parseClause('editor Ravi').label, 'Team: Ravi')
  assert.deepEqual(strip(parseFilter('team sana')), [{ kind: 'person', name: 'sana' }])
})

test('combinations joined with and / & / commas keep their order and source text', () => {
  const f = parseFilter('held over $100 and in grace')
  assert.deepEqual(strip(f), [{ kind: 'held', op: 'gt', minor: 10000 }, { kind: 'grace' }])
  assert.equal(filtersToText(f), 'held over $100 and in grace')
  const g = parseFilter('editor Ravi & failed checks, lapsing soon AND waiting 3+ days')
  assert.deepEqual(
    g.map((x) => x.kind),
    ['person', 'failedChecks', 'lapsing', 'waiting'],
  )
})

test('a clause it cannot read becomes a visible unknown chip that filters nothing', () => {
  const f = parseFilter('held over $100 and wobbly vibes')
  assert.equal(f[1].kind, 'unknown')
  assert.match(f[1].label, /wobbly vibes/)
  assert.equal(matches({ heldMinor: 0, failedChecks: 0 }, f[1], NOW), true)
  assert.deepEqual(parseFilter('   '), [])
  // "held over abc" is not a number: unknown, not a silent zero
  assert.equal(parseClause('held over $abc').kind, 'unknown')
})

test('matchesAll applies every filter to a row', () => {
  const rows = [
    {
      id: 'a',
      heldMinor: 40000,
      clockStatus: 'running',
      businessDaysLeft: 2,
      waitingDays: 1,
      failedChecks: 0,
      editorName: 'Ravi (demo editor)',
      team: [{ name: 'Ravi (demo editor)' }],
      holdLapsesAt: new Date(NOW + 20 * DAY).toISOString(),
      approvable: true,
    },
    {
      id: 'b',
      heldMinor: 7500,
      clockStatus: 'released_partial',
      businessDaysLeft: 0,
      waitingDays: 4,
      failedChecks: 0,
      editorName: 'Ravi (demo editor)',
      team: [{ name: 'Ravi (demo editor)' }, { name: 'Sana (demo motion)' }],
      holdLapsesAt: new Date(NOW + 3 * DAY).toISOString(),
    },
    {
      id: 'c',
      heldMinor: 30000,
      clockStatus: null,
      businessDaysLeft: null,
      waitingDays: 5,
      failedChecks: 2,
      editorName: 'Kiran',
      team: [{ name: 'Kiran' }],
      holdLapsesAt: new Date(NOW + 4 * DAY).toISOString(),
    },
    {
      id: 'd',
      heldMinor: 0,
      clockStatus: 'approved',
      businessDaysLeft: 0,
      waitingDays: null,
      failedChecks: 0,
      editorName: 'Ravi',
      team: [],
      holdLapsesAt: null,
    },
  ]
  const ids = (q) => rows.filter((r) => matchesAll(r, parseFilter(q), NOW)).map((r) => r.id)
  assert.deepEqual(ids('held over $300'), ['a'])
  assert.deepEqual(ids('held over $100 and in grace'), [])
  assert.deepEqual(ids('held over $50 and in grace'), ['b'])
  assert.deepEqual(ids('waiting 3+ days'), ['b', 'c'])
  assert.deepEqual(ids('2 or more days left'), ['a'])
  assert.deepEqual(ids('failed checks'), ['c'])
  assert.deepEqual(ids('editor sana'), ['b'])
  assert.deepEqual(ids('editor Ravi'), ['a', 'b', 'd'])
  assert.deepEqual(ids('lapsing soon'), ['b', 'c'])
  assert.deepEqual(ids('lapsing soon and editor ravi'), ['b'])
  assert.deepEqual(ids('ready to approve'), ['a'])
  assert.deepEqual(ids(''), ['a', 'b', 'c', 'd'])
})

test('daysToLapse', () => {
  assert.equal(daysToLapse(new Date(NOW + 5 * DAY + 1000).toISOString(), NOW), 5)
  assert.equal(daysToLapse(null, NOW), null)
})
