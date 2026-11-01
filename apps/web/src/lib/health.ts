import { useEffect, useState } from 'react'
import { API_BASE } from '../services/api'

export interface BackendHealth {
  checking: boolean
  /** null until the first check finishes. */
  healthy: boolean | null
  error?: string
}

/**
 * Pings GET {API_BASE}/health (5s timeout, polled). A network error, timeout or
 * non-2xx answer means the API is unreachable. Auth is not involved: /health is public.
 * Ported from postiz-absorption d8a4aba.
 */
export function useBackendHealth(pollMs = 30000): BackendHealth {
  const [state, setState] = useState<BackendHealth>({ checking: true, healthy: null })

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    let wasHealthy = false
    let failures = 0
    // After the API has answered once, one missed poll (a blip, a deploy) does
    // not tear down the app; two in a row do.
    const fail = (error: string) => {
      failures += 1
      if (!wasHealthy || failures >= 2) setState({ checking: false, healthy: false, error })
    }

    async function check() {
      const ctrl = new AbortController()
      const t = window.setTimeout(() => ctrl.abort(), 5000)
      try {
        const res = await fetch(`${API_BASE}/health`, { signal: ctrl.signal })
        if (cancelled) return
        if (res.ok) {
          wasHealthy = true
          failures = 0
          setState({ checking: false, healthy: true })
        } else fail(`Health check returned HTTP ${res.status}`)
      } catch (e: any) {
        if (cancelled) return
        const msg = e?.name === 'AbortError' ? 'Health check timed out' : e?.message || 'Backend unreachable'
        fail(msg)
      } finally {
        window.clearTimeout(t)
      }
    }

    check()
    if (pollMs > 0) timer = window.setInterval(check, pollMs)
    return () => {
      cancelled = true
      if (timer) window.clearInterval(timer)
    }
  }, [pollMs])

  return state
}
