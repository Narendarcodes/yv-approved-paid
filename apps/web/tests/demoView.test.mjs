// Unit tests for the judge demo's Brand view / Crew view switch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEMO_VIEWS, demoLanding, demoViewOf, otherDemoView } from '../src/lib/demoView.ts'

test('only the two seeded demo accounts get the switch', () => {
  assert.equal(demoViewOf('judge@yv-demo.example.com'), 'judge')
  assert.equal(demoViewOf(' Editor@YV-demo.example.com '), 'editor')
  for (const e of [
    'motion@yv-demo.example.com',
    'reviewer@yv-demo.example.com',
    'nora@lumen.coffee',
    '',
    null,
    undefined,
  ])
    assert.equal(demoViewOf(e), null)
})

test('the switch offers the other side, with the labels judges see', () => {
  assert.equal(otherDemoView('judge'), 'editor')
  assert.equal(otherDemoView('editor'), 'judge')
  assert.equal(DEMO_VIEWS.judge.label, 'Brand view (Nora)')
  assert.equal(DEMO_VIEWS.editor.label, 'Crew view (Leo)')
})

test('Nora lands on the deal, Leo on My money', () => {
  assert.equal(demoLanding('judge', 'deal_demo_diwali'), '/deals/deal_demo_diwali')
  assert.equal(demoLanding('editor', 'deal_demo_diwali'), '/my-money')
})
