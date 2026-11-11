/* global DOMException, Response, AbortController, FormData, URL */
// The API client's fetch timeout: a hung request fails with TimeoutError (React Query then retries) instead of spinning.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fetchWithTimeout, TimeoutError, API_TIMEOUT_MS } from '../src/lib/fetchTimeout.ts'

const hang = (_url, opts) =>
  new Promise((_ok, fail) => {
    opts?.signal?.addEventListener('abort', () => fail(new DOMException('aborted', 'AbortError')))
  })

test('a request that never answers fails with TimeoutError after the timeout', async () => {
  const real = globalThis.fetch
  globalThis.fetch = hang
  try {
    const t0 = Date.now()
    await assert.rejects(fetchWithTimeout('http://x/api/v1/orgs', {}, 50), (e) => {
      assert.ok(e instanceof TimeoutError)
      assert.match(e.message, /took too long/)
      return true
    })
    assert.ok(Date.now() - t0 < 1000)
  } finally {
    globalThis.fetch = real
  }
})

test('a quick answer passes through and the timer is cleared', async () => {
  const real = globalThis.fetch
  globalThis.fetch = async () => new Response('{"ok":1}', { status: 200 })
  try {
    const r = await fetchWithTimeout('http://x/api/v1/orgs', {}, 50)
    assert.equal(r.status, 200)
    assert.deepEqual(await r.json(), { ok: 1 })
  } finally {
    globalThis.fetch = real
  }
})

test('a caller signal or an upload keeps its own timing (no timeout wrapper)', async () => {
  const real = globalThis.fetch
  let seen = null
  globalThis.fetch = async (_u, o) => {
    seen = o
    return new Response(null, { status: 204 })
  }
  try {
    const ac = new AbortController()
    await fetchWithTimeout('http://x', { signal: ac.signal }, 10)
    assert.equal(seen.signal, ac.signal)
    const fd = new FormData()
    await fetchWithTimeout('http://x', { method: 'POST', body: fd }, 10)
    assert.equal(seen.signal, undefined)
  } finally {
    globalThis.fetch = real
  }
  assert.ok(API_TIMEOUT_MS >= 10_000)
})

test('the money grids register TooltipModule (My share uses tooltipValueGetter)', () => {
  const src = readFileSync(new URL('../src/components/grid/agGrid.ts', import.meta.url), 'utf8')
  assert.match(src, /import \{[^}]*TooltipModule[^}]*\} from 'ag-grid-community'/s)
  assert.match(src, /registerModules\(\[[^\]]*TooltipModule/s)
})

test('the org lookups throw instead of resolving null (no cached null org)', () => {
  const data = readFileSync(new URL('../src/lib/data.ts', import.meta.url), 'utf8')
  const deals = readFileSync(new URL('../src/lib/deals.ts', import.meta.url), 'utf8')
  assert.match(data, /export async function primaryOrgId\(\): Promise<string> \{/)
  assert.match(data, /throw new NoOrgError\(\)/)
  assert.match(deals, /export async function dealOrgId\(\): Promise<string> \{/)
})
