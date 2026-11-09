// Chat timestamps: time only for today's messages, the date too for older ones.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatTime } from '../src/lib/format.ts'

const now = new Date(2026, 10, 9, 8, 40)
const time = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

test("today's message shows the time only", () => {
  const d = new Date(2026, 10, 9, 7, 5)
  assert.equal(chatTime(d.toISOString(), now), time(d))
})

test('an older message shows its date and time', () => {
  const d = new Date(2026, 10, 3, 2, 17)
  const out = chatTime(d.toISOString(), now)
  assert.notEqual(out, time(d))
  assert.ok(out.endsWith(`, ${time(d)}`))
  assert.ok(out.startsWith(d.toLocaleDateString([], { month: 'short', day: 'numeric' })))
})

test('a message from another year carries the year', () => {
  const d = new Date(2025, 11, 31, 23, 0)
  assert.match(chatTime(d.toISOString(), now), /2025/)
})

test('bad input gives an empty string', () => {
  assert.equal(chatTime('nope', now), '')
})
