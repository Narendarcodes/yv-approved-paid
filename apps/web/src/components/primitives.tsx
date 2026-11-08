import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'

export { PageHeader } from './ui'

// Generic tones share the status palette so every pill in the app reads alike.
const tones = {
  teal: 'bg-st-scheduled-bg text-st-scheduled',
  neutral: 'bg-ink/[0.05] text-umber',
  success: 'bg-st-live-bg text-st-live',
  warning: 'bg-st-production-bg text-st-production',
  danger: 'bg-st-failed-bg text-st-failed',
} as const

export default function Chip({
  label,
  tone = 'neutral',
  dot = false,
}: {
  label: string
  tone?: keyof typeof tones
  dot?: boolean
}) {
  return (
    <span className={`status-chip ${tones[tone]}`}>
      {dot && <span className="status-dot" aria-hidden="true" />}
      {label}
    </span>
  )
}

export function statusTone(status: string): keyof typeof tones {
  const s = status.toLowerCase()
  if (
    ['approved', 'published', 'live', 'received', 'done', 'closed', 'inputs ready', 'current'].some(
      (k) => s.includes(k),
    )
  )
    return 'teal'
  if (
    [
      'review',
      'scheduled',
      'revision',
      'waiting',
      'in progress',
      'production',
      'submitted',
      'pending',
    ].some((k) => s.includes(k))
  )
    return 'warning'
  if (['blocked', 'overdue', 'cancelled', 'missing', 'expired'].some((k) => s.includes(k)))
    return 'danger'
  if (['idea', 'assigned', 'backlog', 'draft', 'concept'].some((k) => s.includes(k)))
    return 'neutral'
  return 'success'
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string; count?: number }[]
  active: string
  onChange: (id: string) => void
}) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-line" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={active === t.id}
          onClick={() => onChange(t.id)}
          className={`-mb-px flex items-center gap-1.5 whitespace-nowrap rounded-t-md border-b-2 px-3 py-2.5 text-sm font-medium transition-[color,border-color,background-color] duration-200 ${
            active === t.id
              ? 'border-teal text-ink'
              : 'border-transparent text-umber hover:border-line-strong hover:text-ink'
          }`}
        >
          {t.label}
          {t.count !== undefined && (
            <span
              className={`flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-xs ${
                active === t.id ? 'bg-tint text-teal' : 'bg-ink/5 text-umber'
              }`}
            >
              {t.count}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

export function Modal({
  open,
  onClose,
  title,
  children,
  width = 'max-w-lg',
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  width?: string
}) {
  // Escape closes while open (hooks stay above the early return).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Lock background scroll behind a tall modal.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  if (!open) return null

  // Portal to document.body so `position: fixed` resolves against the
  // VIEWPORT. Without it, transformed ancestors (AppShell's .page-enter
  // wrapper keeps transform via animation fill-mode) become the containing
  // block -> backdrop/modal clipped to the content column.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-[8vh]">
      <div
        className="fixed inset-0 bg-ink/45 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={`modal-in relative w-full ${width} rounded-2xl border border-line bg-surface shadow-pop`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="flex items-center justify-between border-b border-line px-6 py-4">
          <h2 className="font-headline text-lg font-semibold tracking-tight text-ink">{title}</h2>
          <button onClick={onClose} className="icon-btn icon-btn-sm" aria-label="Close">
            <X size={16} strokeWidth={2} />
          </button>
        </header>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="fade-in flex flex-col items-center justify-center rounded-[var(--radius-lg)] border border-line bg-surface px-6 py-14 text-center shadow-card">
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-canvas text-umber [&_svg]:h-5 [&_svg]:w-5">
        {icon}
      </div>
      <h3 className="t-title">{title}</h3>
      <p className="mt-1.5 max-w-[42ch] text-sm leading-relaxed text-umber">{description}</p>
      {action && <div className="mt-5 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />
}

export function StatCard({
  label,
  value,
  icon,
  tone = 'teal',
}: {
  label: string
  value: string | number
  icon: ReactNode
  tone?: 'teal' | 'warning' | 'success' | 'danger'
}) {
  const tones = {
    teal: 'bg-tint text-teal',
    warning: 'bg-warning/10 text-warning',
    success: 'bg-success/10 text-success',
    danger: 'bg-danger/10 text-danger',
  }
  return (
    <div className="card card-hover p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="micro-label">{label}</p>
          <p className="t-num mt-2 text-[30px] leading-none">{value}</p>
        </div>
        <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${tones[tone]}`}>
          {icon}
        </span>
      </div>
    </div>
  )
}
