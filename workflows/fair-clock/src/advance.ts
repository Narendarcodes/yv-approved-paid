/**
 * One call to the API's clock driver: POST {API_URL}/api/v1/internal/clock/advance
 * with X-Clock-Secret. The API runs every due Fair Review Clock step and each step
 * is idempotent (keyed per deal, milestone and step), so calling it twice, or
 * retrying after a timeout, never moves money twice.
 *
 * Retryable failures (network, timeout, 408, 429, 5xx) throw, so the workflow
 * step retries them with backoff. Configuration failures (401 bad secret,
 * 404 = CLOCK_SHARED_SECRET unset on the API, other 4xx) do not get better on
 * retry: they come back as { ok: false } and the flow fails once, loudly.
 */

export type ClockConfig = {
  apiUrl: string;
  secret: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type AdvanceResult =
  | { ok: true; status: number; deliveries: number; steps: number }
  | { ok: false; status: number; error: string };

export class RetryableClockError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'RetryableClockError';
    this.status = status;
  }
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): ClockConfig {
  const apiUrl = (env.API_URL || '').trim().replace(/\/+$/, '');
  const secret = env.CLOCK_SHARED_SECRET || '';
  if (!apiUrl)
    throw new Error('API_URL is required (the API origin, e.g. https://yv-api.onrender.com)');
  if (!secret)
    throw new Error('CLOCK_SHARED_SECRET is required (same value as on the API service)');
  return { apiUrl, secret, timeoutMs: Number(env.CLOCK_TIMEOUT_MS) || 20_000 };
}

export const ADVANCE_PATH = '/api/v1/internal/clock/advance';

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export async function postAdvance(cfg: ClockConfig): Promise<AdvanceResult> {
  const f = cfg.fetchImpl || fetch;
  let res: Response;
  try {
    res = await f(`${cfg.apiUrl}${ADVANCE_PATH}`, {
      method: 'POST',
      headers: { 'X-Clock-Secret': cfg.secret, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 20_000),
    });
  } catch (e) {
    // network error or timeout: the API may be cold-starting (free plan), try again
    throw new RetryableClockError(`clock advance did not answer: ${(e as Error).message}`, null);
  }
  const text = await res.text().catch(() => '');
  if (retryableStatus(res.status))
    throw new RetryableClockError(`clock advance failed (${res.status})`, res.status);
  if (!res.ok) {
    let message = text.slice(0, 200);
    try {
      message = JSON.parse(text)?.error?.message || message;
    } catch {
      /* not JSON (an HTML error page); keep the raw start */
    }
    return { ok: false, status: res.status, error: message || `HTTP ${res.status}` };
  }
  let data: { advanced?: unknown[]; steps?: number } = {};
  try {
    data = JSON.parse(text)?.data || {};
  } catch {
    throw new RetryableClockError(
      'clock advance answered 2xx with a body that is not JSON',
      res.status,
    );
  }
  return {
    ok: true,
    status: res.status,
    deliveries: Array.isArray(data.advanced) ? data.advanced.length : 0,
    steps: Number(data.steps) || 0,
  };
}
