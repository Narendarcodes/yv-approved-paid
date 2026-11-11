/**
 * fetch with a timeout, so a request to a sleeping or stuck server fails
 * (and React Query retries with backoff) instead of spinning forever.
 */
/** Requests that hang longer than this fail. */
export const API_TIMEOUT_MS = 25_000

/** Raised when a request takes longer than API_TIMEOUT_MS. */
export class TimeoutError extends Error {
  constructor(url: string) {
    super(`The server took too long to answer (${url.replace(/^.*\/api\/v1/, '')})`)
    this.name = 'TimeoutError'
  }
}

/**
 * fetch with a timeout. Uploads (FormData) and callers that pass their own
 * signal keep their own timing.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  ms = API_TIMEOUT_MS,
): Promise<Response> {
  if (options.signal || options.body instanceof FormData) return fetch(url, options)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  try {
    return await fetch(url, { ...options, signal: ac.signal })
  } catch (e) {
    if (ac.signal.aborted) throw new TimeoutError(url)
    throw e
  } finally {
    clearTimeout(timer)
  }
}
