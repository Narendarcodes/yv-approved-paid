// Unit tests for the deal copilot's starters and money-card rule by side of the deal.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLIENT_STARTERS,
  CREW_STARTERS,
  mayShowAction,
  startersFor,
} from '../src/lib/copilotStarters.ts'

test('the brand keeps the current three starters', () => {
  assert.deepEqual(
    startersFor('client').map((s) => s.prompt),
    ['Where is the money?', 'Show the dispute split on reel 2', 'Capture $450 on reel 1'],
  )
  assert.equal(startersFor('client'), CLIENT_STARTERS)
})

test('crew and observers get their money and the split, no money ask', () => {
  for (const me of ['worker', null, undefined, '']) {
    assert.deepEqual(
      startersFor(me).map((s) => s.prompt),
      ['Where is my money?', 'Show the dispute split on reel 2'],
    )
    assert.equal(startersFor(me), CREW_STARTERS)
  }
  for (const s of CREW_STARTERS) assert.doesNotMatch(s.prompt, /capture|pay |release|charge/i)
})

test('money-moving cards are for the brand only', () => {
  assert.equal(mayShowAction('proposeCapture', 'client'), true)
  for (const me of ['worker', null, undefined]) {
    assert.equal(mayShowAction('proposeCapture', me), false)
    for (const name of ['showMoneyTimeline', 'showDisputeSplit', 'showDeal', 'showChecks'])
      assert.equal(mayShowAction(name, me), true)
  }
})
