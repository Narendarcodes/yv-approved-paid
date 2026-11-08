import { RefreshCw } from 'lucide-react'
import Illustration from '../components/Illustration'
import { API_BASE } from '../services/api'

/**
 * Shown instead of the app shell when the API is unreachable, so nobody sees
 * an empty dashboard by mistake. Also the 404 page (notFound), outside the shell.
 */
export default function BackendErrorPage({
  error,
  onRetry,
  notFound = false,
}: {
  error?: string
  onRetry?: () => void
  notFound?: boolean
}) {
  const apiUrl = API_BASE.startsWith('http') ? API_BASE : `${window.location.origin}${API_BASE}`
  return (
    <div
      role="alert"
      className="flex min-h-screen flex-col items-center justify-center bg-canvas px-6 py-16 text-center"
    >
      <Illustration name="error" className="h-36 w-auto" />
      <h1 className="mt-6 text-[20px] font-medium tracking-[-0.01em] text-ink">
        {notFound ? 'Page not found' : "Can't reach the yv. API"}
      </h1>
      {!notFound && (
        <p className="mt-2 font-mono text-xs text-umber" title={error}>
          {apiUrl}
        </p>
      )}
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {!notFound && (
          <button
            type="button"
            onClick={() => (onRetry ? onRetry() : window.location.reload())}
            className="btn-primary"
          >
            <RefreshCw size={16} aria-hidden="true" />
            Retry
          </button>
        )}
        <a href="/" className={notFound ? 'btn-primary' : 'btn-secondary'}>
          Home
        </a>
      </div>
    </div>
  )
}
