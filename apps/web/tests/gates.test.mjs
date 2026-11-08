// Unit tests for the project stage gate checklist (button state + "What's missing" rows).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advanceState, dealOptions, gateRows, gateTarget } from '../src/lib/gates.ts'

const PID = 'p1'
const item = (key, done, href = `/projects/${PID}#brief`) => ({
  key,
  label: key,
  done,
  href,
  action: 'Open',
})
const gate = (items, o = {}) => ({
  next: 'IN_PROGRESS',
  gated: true,
  ready: items.every((i) => i.done),
  items,
  ...o,
})

test('locked while any item is open; the button state counts them', () => {
  const g = gate([
    item('brief_items', true),
    item('deal_signed', false, '/deals/d1?open=terms'),
    item('money_held', false, '/deals/d1?open=money'),
  ])
  assert.deepEqual(advanceState(g), { locked: true, open: 2, total: 3 })
})

test('ready gate, a move inside a stage, or no gate yet: not locked', () => {
  assert.equal(advanceState(gate([item('a', true)])).locked, false)
  assert.equal(
    advanceState({ next: 'UNDER_REVIEW', gated: false, ready: true, items: [] }).locked,
    false,
  )
  assert.equal(advanceState(null).locked, false)
  assert.equal(advanceState(undefined).locked, false)
})

test('rows: open items first, each linking where the work gets done', () => {
  const g = gate([
    item('brief_items', true),
    item('deal_signed', false, '/deals/deal_demo_team_draft?reel=greeting&open=terms'),
    item('editor_assigned', false, `/projects/${PID}#assign`),
  ])
  const rows = gateRows(g, PID)
  assert.deepEqual(
    rows.map((r) => [r.key, r.done]),
    [
      ['deal_signed', false],
      ['editor_assigned', false],
      ['brief_items', true],
    ],
  )
  assert.deepEqual(rows[0].target, {
    kind: 'route',
    to: '/deals/deal_demo_team_draft?reel=greeting&open=terms',
  })
  assert.deepEqual(rows[1].target, { kind: 'anchor', id: 'assign' })
})

test('no rows for a move that is not gated', () => {
  assert.deepEqual(
    gateRows({ next: 'UNDER_REVIEW', gated: false, ready: true, items: [] }, PID),
    [],
  )
  assert.deepEqual(gateRows(null, PID), [])
})

test('an anchor only for this project; another project page is a route', () => {
  assert.deepEqual(gateTarget('/projects/p1#versions', 'p1'), { kind: 'anchor', id: 'versions' })
  assert.deepEqual(gateTarget('/projects/p2#versions', 'p1'), {
    kind: 'route',
    to: '/projects/p2#versions',
  })
  assert.deepEqual(gateTarget('/projects/p1/review', 'p1'), {
    kind: 'route',
    to: '/projects/p1/review',
  })
})

test('deal picker lists every milestone of every deal', () => {
  const opts = dealOptions([
    {
      id: 'd1',
      terms: { title: 'Diwali', milestones: [{ key: 'reel1', title: 'Reel 1' }, { key: 'reel2' }] },
    },
    { id: 'd2', terms: { milestones: [] } },
  ])
  assert.deepEqual(
    opts.map((o) => [o.value, o.label]),
    [
      ['d1::reel1', 'Diwali · Reel 1'],
      ['d1::reel2', 'Diwali · reel2'],
    ],
  )
})
