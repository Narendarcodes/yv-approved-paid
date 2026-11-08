/**
 * Shared bits for the deal cards (Approved = Paid).
 * AI checks facts, people own taste, the deal decides the money.
 */
import type { ReactNode } from 'react'
import { PAYPAL_ENV, paypalEnv } from '../../lib/deals'

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
      {footer && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-3">
          {footer}
        </div>
      )}
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
  if (passed === false)
    return <span className="status-chip bg-st-failed-bg text-st-failed">Fail</span>
  return <span className="status-chip bg-ink/[0.05] text-umber">Unmeasured</span>
}

export function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: ReactNode
  tone?: 'teal' | 'danger'
}) {
  return (
    <div className="min-w-0">
      <p className="micro-label">{label}</p>
      <p
        className={`t-num mt-1 text-[18px] ${tone === 'teal' ? '!text-teal' : tone === 'danger' ? '!text-danger' : ''}`}
      >
        {value}
      </p>
    </div>
  )
}

/** A PayPal id in mono with its environment tag (PayPal sandbox / simulated / mock). Nothing here is a live charge. */
export function PaypalId({ id, className = '' }: { id: string; className?: string }) {
  const env = PAYPAL_ENV[paypalEnv(id)]
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
      <span className="truncate font-mono text-[12.5px] text-ink" title={id}>
        {id}
      </span>
      <span
        className="shrink-0 rounded-[5px] border border-st-production/20 bg-st-production-bg px-1.5 py-px text-xs text-st-production"
        title={env.title}
        data-testid="paypal-env"
      >
        {env.tag}
      </span>
    </span>
  )
}
export const PaypalInvoiceId = PaypalId
