/**
 * One dashboard section. With rows: a card with a header (icon, title, count,
 * link), one helper line, then the rows. Empty: the card collapses to one
 * line (icon, title, the empty line, link) so a quiet day stays short.
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'

export function DashSection({
  title,
  icon,
  helper,
  empty,
  isEmpty,
  count,
  to,
  action,
  testId,
  className = '',
  children,
}: {
  title: string
  icon: ReactNode
  helper: string
  empty: string
  isEmpty: boolean
  count?: number
  to?: string
  action?: string
  testId?: string
  className?: string
  children?: ReactNode
}) {
  const link = to ? (
    <Link to={to} className="card-link group ml-auto shrink-0">
      {action ?? 'Open'}
      <ArrowRight
        size={13}
        strokeWidth={2}
        className="transition-transform group-hover:translate-x-0.5"
      />
    </Link>
  ) : null

  if (isEmpty) {
    return (
      <section
        className={`card flex min-h-[52px] flex-wrap items-center gap-x-3 gap-y-0.5 px-5 py-3 ${className}`}
        data-testid={testId}
        data-empty="true"
      >
        <span className="shrink-0 text-umber" aria-hidden="true">
          {icon}
        </span>
        <h2 className="shrink-0 text-[14px] font-medium text-ink">{title}</h2>
        <p
          className="order-last min-w-0 basis-full pl-7 text-[13px] text-umber sm:order-none sm:flex-1 sm:basis-0 sm:truncate sm:pl-0"
          title={empty}
        >
          {empty}
        </p>
        {link}
      </section>
    )
  }

  return (
    <section className={`card flex flex-col overflow-hidden ${className}`} data-testid={testId}>
      <header className="flex items-start gap-3 border-b border-line px-5 py-3.5">
        <span className="mt-0.5 shrink-0 text-umber" aria-hidden="true">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-[14px] font-medium text-ink">
            {title}
            {typeof count === 'number' && <span className="t-num text-xs text-label">{count}</span>}
          </h2>
          <p className="mt-0.5 text-[12.5px] leading-snug text-umber">{helper}</p>
        </div>
        {link}
      </header>
      {children}
    </section>
  )
}
