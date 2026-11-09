// Unit tests for the first-visit tour: the state machine, the steps per role and route matching.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  atRoute,
  demoDealSteps,
  initialTour,
  seenKey,
  stepLabel,
  stepsFor,
  tourReducer,
} from '../src/lib/tour.ts'

const run = (actions, s = initialTour) => actions.reduce(tourReducer, s)

test('start opens step 1 of N; zero steps ends at once', () => {
  const s = run([{ type: 'start', count: 3 }])
  assert.deepEqual(s, { status: 'running', index: 0, dir: 1, count: 3 })
  assert.equal(stepLabel(s), 'Step 1 of 3')
  assert.equal(run([{ type: 'start', count: 0 }]).status, 'done')
})

test('next walks forward and finishes after the last step', () => {
  const s = run([{ type: 'start', count: 3 }, { type: 'next' }, { type: 'next' }])
  assert.equal(s.index, 2)
  assert.equal(stepLabel(s), 'Step 3 of 3')
  assert.equal(tourReducer(s, { type: 'next' }).status, 'done')
})

test('back steps back and stops at the first step', () => {
  const s = run([{ type: 'start', count: 3 }, { type: 'next' }, { type: 'back' }])
  assert.equal(s.index, 0)
  assert.equal(s.dir, -1)
  assert.deepEqual(tourReducer(s, { type: 'back' }), s)
})

test('skip ends from any step; actions after done are ignored', () => {
  const s = run([{ type: 'start', count: 5 }, { type: 'next' }, { type: 'skip' }])
  assert.equal(s.status, 'done')
  for (const a of [{ type: 'next' }, { type: 'back' }, { type: 'skip' }, { type: 'missing' }])
    assert.deepEqual(tourReducer(s, a), s)
  assert.deepEqual(tourReducer(initialTour, { type: 'next' }), initialTour)
})

test('a missing anchor skips in the direction of travel', () => {
  // forward: 0 -> 1 (missing) -> 2
  let s = run([{ type: 'start', count: 4 }, { type: 'next' }, { type: 'missing' }])
  assert.equal(s.index, 2)
  // backward: 2 -> 1 (missing) -> 0
  s = run([{ type: 'back' }, { type: 'missing' }], s)
  assert.equal(s.index, 0)
  // missing on the last step going forward finishes
  s = run([{ type: 'start', count: 2 }, { type: 'next' }, { type: 'missing' }])
  assert.equal(s.status, 'done')
})

test('missing at the first step carries on forward, or finishes a one-step tour', () => {
  let s = run([{ type: 'start', count: 3 }, { type: 'missing' }])
  assert.deepEqual([s.index, s.dir, s.status], [1, 1, 'running'])
  s = run([{ type: 'start', count: 3 }, { type: 'next' }, { type: 'back' }, { type: 'missing' }])
  assert.deepEqual([s.index, s.dir], [1, 1])
  assert.equal(run([{ type: 'start', count: 1 }, { type: 'missing' }]).status, 'done')
})

test('every missing step in a row ends the tour, never loops', () => {
  let s = run([{ type: 'start', count: 6 }])
  for (let i = 0; i < 6; i++) s = tourReducer(s, { type: 'missing' })
  assert.equal(s.status, 'done')
})

test('demo user walks the money story on the deal', () => {
  const ids = stepsFor('admin', { demoDeal: '/deals/deal_demo_diwali' }).map((x) => x.id)
  assert.deepEqual(ids, [
    'home',
    'held',
    'payday',
    'checks',
    'clock',
    'payables',
    'chat',
    'brand-brain',
    'again',
  ])
  const route = Object.fromEntries(demoDealSteps('/deals/d1').map((x) => [x.id, x.route]))
  assert.deepEqual(route, {
    held: '/deals/d1',
    payday: '/deals/d1?reel=reel1',
    checks: '/deals/d1?reel=reel3',
    clock: '/deals/d1?reel=reel3',
  })
})

test('each role gets steps that only point at nav it can see', () => {
  const navOf = {
    admin: ['/dashboard', '/deals', '/review', '/payables', '/chat', '/brand-brain'],
    editor: ['/dashboard', '/my-work', '/projects', '/deals', '/my-money', '/chat', '/brand-brain'],
    reviewer: ['/dashboard', '/review', '/deals', '/payables', '/chat', '/brand-brain'],
    publisher: [
      '/dashboard',
      '/publishing/calendar',
      '/publishing/compose',
      '/my-money',
      '/chat',
      '/brand-brain',
    ],
  }
  for (const [role, nav] of Object.entries(navOf)) {
    const steps = stepsFor(role)
    const targets = steps.map((x) => /nav-([^"]+)"/.exec(x.target)?.[1]).filter(Boolean)
    assert.deepEqual(targets, nav, role)
    assert.equal(steps.at(-1).id, 'again', role)
  }
  assert.ok(stepsFor('member').length >= 3)
  // nav steps fall back to the menu button on a phone, where the sidebar has no box
  for (const st of stepsFor('editor'))
    if (st.target.includes('nav-')) assert.equal(st.fallback, '[data-testid="nav-open"]', st.id)
})

test('copy: one short sentence each, sentence case, no emoji', () => {
  const all = ['admin', 'editor', 'reviewer', 'publisher', 'member']
    .flatMap((r) => stepsFor(r))
    .concat(stepsFor('admin', { demoDeal: '/deals/x' }))
  for (const s of all) {
    assert.match(s.body, /^[A-Z][^.!?]*\.$/, s.id)
    assert.ok(s.body.split(/\s+/).length <= 14, `${s.id}: ${s.body}`)
    assert.doesNotMatch(s.body + s.title, /\p{Extended_Pictographic}/u, s.id)
    assert.ok(!/[A-Z]{2,}/.test(s.title.replace('PayPal', '')), s.id)
  }
})

test('atRoute matches path and the query the step needs', () => {
  assert.ok(atRoute('/deals/d', '/deals/d', '?reel=reel1'))
  assert.ok(atRoute('/deals/d?reel=reel3', '/deals/d', '?open=checks&reel=reel3'))
  assert.ok(!atRoute('/deals/d?reel=reel3', '/deals/d', '?reel=reel1'))
  assert.ok(!atRoute('/deals/d', '/payables', ''))
})

test('seen flag is per user', () => {
  assert.notEqual(seenKey('a'), seenKey('b'))
})
