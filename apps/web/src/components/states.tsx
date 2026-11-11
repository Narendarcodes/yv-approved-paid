/**
 * Async UI states for yv..
 *
 * Skeletons show while real data loads, an ErrorBanner offers a retry when
 * the backend is unreachable, and EmptyState explains when there is simply
 * nothing to show. Pages should never render blank content on slow networks.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { WifiOff, RefreshCw, Inbox } from 'lucide-react'
import Illustration, { type IllustrationName } from './Illustration'

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />
}

/** Card-shaped skeleton: header bar + n text lines. */
export function CardSkeleton({
  lines = 3,
  className = '',
}: {
  lines?: number
  className?: string
}) {
  return (
    <div className={`card overflow-hidden ${className}`} aria-busy="true">
      <div className="card-head">
        <Skeleton className="h-3.5 w-32" />
      </div>
      <div className="space-y-3 p-5">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} className={`h-3 ${['w-full', 'w-5/6', 'w-2/3', 'w-3/4'][i % 4]}`} />
        ))}
      </div>
    </div>
  )
}

/** Row of pulse blocks matching the Dashboard stat-card grid. */
export function StatCardSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card p-5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-3 h-8 w-14" />
        </div>
      ))}
    </div>
  )
}

/** Pulse rows matching list-style pages (projects, my work, members). */
export function ListSkeleton({ rows = 4, height = 'h-16' }: { rows?: number; height?: string }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className={`w-full !rounded-[var(--radius-card)] ${height}`} />
      ))}
    </div>
  )
}

/** API failure with retry. */
export function ErrorBanner({ onRetry, message }: { onRetry?: () => void; message?: string }) {
  return (
    <div
      className="flex flex-col items-center gap-3 rounded-xl border border-danger/25 bg-danger/5 px-6 py-8 text-center"
      role="alert"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-danger/10 text-danger">
        <WifiOff size={18} strokeWidth={1.75} />
      </span>
      <div>
        <p className="text-sm font-medium text-ink">Couldn&apos;t reach the server</p>
        <p className="mt-0.5 text-[13px] text-umber">
          {message || 'Check your internet connection and try again.'}
        </p>
      </div>
      {onRetry && (
        <button onClick={onRetry} className="btn-secondary !h-9 text-[13px]">
          <RefreshCw size={14} strokeWidth={2} />
          Retry
        </button>
      )}
    </div>
  )
}

/** Genuine "nothing here yet" state. */
export function EmptyState({
  title,
  description,
  action,
  illustration,
}: {
  title: string
  /** One helpful line: what fills this, or what to do next. */
  description?: string
  action?: ReactNode
  /** An illustrated empty state for the few places that earn one (deals, payables, my money, projects, review). */
  illustration?: IllustrationName
}) {
  return (
    <div className="fade-in flex flex-col items-center gap-3 rounded-xl border border-line bg-surface px-6 py-10 text-center">
      {illustration ? (
        <Illustration name={illustration} className="mb-2 h-28 w-auto" />
      ) : (
        <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-canvas text-umber">
          <Inbox size={18} strokeWidth={1.75} />
        </span>
      )}
      <div>
        <p className="text-sm font-medium text-ink">{title}</p>
        {description && (
          <p className="mx-auto mt-1 max-w-[42ch] text-[13px] text-umber">{description}</p>
        )}
      </div>
      {action}
    </div>
  )
}

/** True once `active` has stayed true for `ms` (a load that is taking longer than a warm server would). */
export function useSlow(active: boolean, ms = 4000): boolean {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!active) {
      setSlow(false)
      return
    }
    const t = setTimeout(() => setSlow(true), ms)
    return () => clearTimeout(t)
  }, [active, ms])
  return slow
}

/**
 * A load that is slow or already retrying: the hosted API sleeps when idle and
 * takes up to a minute to wake. Says so (instead of a bare skeleton) and offers a retry.
 */
export function WakingServer({ onRetry, attempt = 0 }: { onRetry?: () => void; attempt?: number }) {
  return (
    <div
      className="fade-in flex flex-col items-center gap-3 rounded-xl border border-line bg-surface px-6 py-8 text-center"
      role="status"
      aria-live="polite"
      data-testid="waking-server"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-canvas text-umber">
        <RefreshCw size={18} strokeWidth={1.75} className="animate-spin" />
      </span>
      <div>
        <p className="text-sm font-medium text-ink">Waking the server…</p>
        <p className="mx-auto mt-0.5 max-w-[44ch] text-[13px] text-umber">
          It sleeps when nobody is using it and can take up to a minute to start.
          {attempt > 0 ? ` Trying again (attempt ${attempt + 1}).` : ''}
        </p>
      </div>
      {onRetry && (
        <button onClick={onRetry} className="btn-secondary !h-9 text-[13px]">
          <RefreshCw size={14} strokeWidth={2} />
          Retry now
        </button>
      )}
    </div>
  )
}
