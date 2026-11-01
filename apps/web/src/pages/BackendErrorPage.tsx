import { RefreshCw, WifiOff } from 'lucide-react'
import { API_BASE } from '../services/api'

/** Shown instead of the app shell when the API is unreachable (ported from postiz-absorption d8a4aba). */
export default function BackendErrorPage({ error, onRetry }: { error?: string; onRetry?: () => void }) {
  const apiUrl = API_BASE.startsWith('http') ? API_BASE : `${window.location.origin}${API_BASE}`
  return (
    <div role="alert" className="flex min-h-screen flex-col items-center justify-center bg-canvas px-6 py-16 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-warning/10 text-warning">
        <WifiOff size={28} aria-hidden="true" />
      </span>
      <h1 className="mt-4 font-headline text-xl font-semibold tracking-tight text-ink">Can't reach the yv. API</h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-umber">
        The API at <span className="font-mono text-xs text-ink">{apiUrl}</span> is not responding. Your workspace is
        hidden until the connection is back, so you never see an empty dashboard by mistake.
      </p>
      {error && <p className="mt-2 font-mono text-xs text-umber">Details: {error}</p>}
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <button
          type="button"
          onClick={() => (onRetry ? onRetry() : window.location.reload())}
          className="btn-primary inline-flex items-center gap-2"
        >
          <RefreshCw size={16} aria-hidden="true" />
          Retry connection
        </button>
        <a href="/" className="btn-secondary">
          Back to home
        </a>
      </div>
    </div>
  )
}
