/**
 * Wake the API early. The free Render instance sleeps when idle and takes
 * about 30 s to start, so the landing and login pages ping GET /health on
 * load: the server is waking while the visitor reads. "Try the demo" waits
 * for the same ping instead of failing on a cold server.
 */
import { useSyncExternalStore } from 'react'
import { API_BASE } from '../services/api'

/** checking: first ping in flight (< 1.2 s) · waking: the server is starting · ready · down: gave up. */
export type WakeState = 'idle' | 'checking' | 'waking' | 'ready' | 'down'

let state: WakeState = 'idle'
let inflight: Promise<boolean> | null = null
const subs = new Set<() => void>()
const set = (s: WakeState) => {
  state = s
  subs.forEach((f) => f())
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function ping(timeoutMs: number): Promise<boolean> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${API_BASE}/health`, { signal: ctrl.signal, cache: 'no-store' })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}

/** Resolves true once /health answers (polls every ~2.5 s, up to maxMs). Shared across callers. */
export function wakeApi(maxMs = 90_000): Promise<boolean> {
  if (state === 'ready') return Promise.resolve(true)
  if (inflight) return inflight
  set('checking')
  const slow = setTimeout(() => state === 'checking' && set('waking'), 1200)
  inflight = (async () => {
    const start = Date.now()
    try {
      while (Date.now() - start < maxMs) {
        if (await ping(10_000)) {
          set('ready')
          return true
        }
        if (state === 'checking') set('waking')
        await sleep(2500)
      }
      set('down')
      return false
    } finally {
      clearTimeout(slow)
      inflight = null
    }
  })()
  return inflight
}

export function useWakeState(): WakeState {
  return useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => state,
    () => state,
  )
}

export const WAKING_LABEL = 'Waking the server, about 30 s'
