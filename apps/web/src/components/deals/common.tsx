/**
 * Shared bits for the deal cards (Approved = Paid).
 * AI checks facts, people own taste, the deal decides the money.
 */
import type { ReactNode } from 'react'
import { ShieldCheck } from 'lucide-react'
import { MOTTO } from '../../lib/deals'

/** The motto line every deal screen carries. */
export function Motto({ className = '' }: { className?: string }) {
  return (
    <p className={`flex items-center gap-1.5 font-mono text-[11px] text-label ${className}`} data-testid="deal-motto">
      <ShieldCheck size={13} strokeWidth={1.75} className="text-teal" aria-hidden="true" />
      {MOTTO}
    </p>
  )
}

/** A deal card: white surface, hairline border, header row with title + right-side meta. */
export function DealCardShell({
  title,
  label,
  meta,
  children,
  footer,
  testId,
}: {
  title: string
  label?: string
  meta?: ReactNode
  children: ReactNode
  footer?: ReactNode
  testId?: string
}) {
  return (
    <section className="card overflow-hidden" data-testid={testId}>
      <div className="card-head justify-between">
        <div className="min-w-0">
          {label && <p className="micro-label">{label}</p>}
          <h3 className="card-title truncate">{title}</h3>
        </div>
        {meta && <div className="flex shrink-0 items-center gap-2">{meta}</div>}
      </div>
      <div className="p-5">{children}</div>
      {footer && <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">{footer}</div>}
    </section>
  )
}

/** Fix vs Taste tag. Fix cites a failed checklist line; Taste costs a revision round, never pay. */
export function TagPill({ tag }: { tag: 'fix' | 'taste' }) {
  return tag === 'fix' ? (
    <span className="status-chip bg-st-failed-bg text-st-failed">Fix</span>
  ) : (
    <span className="status-chip bg-st-idea-bg text-st-idea">Taste</span>
  )
}

export function PassPill({ passed }: { passed: boolean | null | undefined }) {
  if (passed === true) return <span className="status-chip bg-st-live-bg text-st-live">Pass</span>
  if (passed === false) return <span className="status-chip bg-st-failed-bg text-st-failed">Fail</span>
  return <span className="status-chip bg-ink/[0.05] text-umber">Unmeasured</span>
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'teal' | 'danger' }) {
  return (
    <div className="min-w-0">
      <p className="micro-label">{label}</p>
      <p className={`t-num mt-1 text-[18px] ${tone === 'teal' ? '!text-teal' : tone === 'danger' ? '!text-danger' : ''}`}>{value}</p>
    </div>
  )
}
