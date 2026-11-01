import type { ReactNode } from 'react'
import { useState } from 'react'

const tones: Record<string, string> = {
  teal: 'bg-teal text-on-accent',
  tint: 'bg-tint text-teal',
  ink: 'bg-ink/80 text-on-accent',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-danger/15 text-danger',
}

export default function Avatar({
  initials,
  size = 'md',
  tone = 'teal',
  className = '',
  src,
}: {
  initials: string
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  tone?: keyof typeof tones
  className?: string
  src?: string | null
}) {
  const sizes = {
    xs: 'h-6 w-6 text-[9px]',
    sm: 'h-8 w-8 text-[10px]',
    md: 'h-9 w-9 text-xs',
    lg: 'h-11 w-11 text-sm',
    xl: 'h-20 w-20 text-2xl',
  }
  const dims: Record<string, { w: number; h: number }> = {
    xs: { w: 24, h: 24 },
    sm: { w: 32, h: 32 },
    md: { w: 36, h: 36 },
    lg: { w: 44, h: 44 },
    xl: { w: 96, h: 96 },
  }
  const [failed, setFailed] = useState(false)
  // Reset fallback when src changes — fixes the "stuck D until navigate back" bug
  const [prevSrc, setPrevSrc] = useState(src)
  if (src !== prevSrc) {
    setPrevSrc(src)
    if (failed) setFailed(false)
  }
  if (!src && (!initials || initials === '?')) {
    return <UnassignedChip size={size} className={className} compact />
  }
  const showImg = !!src && !failed
  if (showImg) {
    const d = dims[size]
    return (
      <img
        src={src!}
        alt=""
        width={d.w}
        height={d.h}
        loading="lazy"
        onError={() => setFailed(true)}
        className={`inline-flex shrink-0 rounded-full object-cover ${sizes[size]} ${className} touch-manipulation`}
      />
    )
  }
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-mono font-medium ${sizes[size]} ${tones[tone]} ${className} touch-manipulation`}
      aria-hidden="true"
    >
      {initials}
    </span>
  )
}

export function AvatarStack({ initials, max = 3 }: { initials: string[]; max?: number }) {
  const shown = initials.slice(0, max)
  const extra = initials.length - shown.length
  return (
    <span className="flex -space-x-1.5">
      {shown.map((ini, i) => (
        <span key={i} className="relative rounded-full ring-2 ring-surface transition-transform hover:z-10 hover:-translate-y-0.5" style={{ zIndex: shown.length - i }}>
          <Avatar initials={ini} size="sm" tone={i % 2 === 0 ? 'teal' : 'tint'} />
        </span>
      ))}
      {extra > 0 && (
        <span className="relative inline-flex h-8 w-8 items-center justify-center rounded-full bg-canvas font-mono text-[10px] text-umber ring-2 ring-surface">
          +{extra}
        </span>
      )}
    </span>
  )
}

export function StatusDot({ tone = 'teal' }: { tone?: string }) {
  const color: Record<string, string> = {
    teal: 'bg-teal',
    warning: 'bg-warning',
    success: 'bg-success',
    danger: 'bg-danger',
    neutral: 'bg-umber/50',
  }
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${color[tone] ?? color.teal}`} aria-hidden="true" />
}

export function Spacer({ h = 4 }: { h?: number }) {
  return <div style={{ height: `${h * 4}px` }} aria-hidden="true" />
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0 flex-1 basis-[320px]">
        <h1 className="t-display">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-[62ch] text-sm leading-relaxed text-umber">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

/** Section heading used inside cards - consistent editorial rhythm */
export function SectionHeading({
  title,
  action,
}: {
  title: string
  action?: ReactNode
}) {
  return (
    <div className="card-head justify-between">
      <h2 className="card-title">{title}</h2>
      {action}
    </div>
  )
}

/**
 * Dashed placeholder for "nobody owns this yet". `compact` renders just the
 * dashed circle (for tight avatar slots); otherwise a dashed pill reading
 * "Unassigned".
 */
export function UnassignedChip({
  size = 'xs',
  className = '',
  compact = false,
}: {
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  className?: string
  compact?: boolean
}) {
  const h = { xs: 'h-6', sm: 'h-8', md: 'h-9', lg: 'h-11', xl: 'h-20' }[size]
  const w = { xs: 'w-6', sm: 'w-8', md: 'w-9', lg: 'w-11', xl: 'w-20' }[size]
  if (compact) {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-umber/50 ${h} ${w} ${className}`}
        title="Unassigned"
        aria-label="Unassigned"
        data-testid="unassigned-chip"
      />
    )
  }
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border border-dashed border-umber/50 px-2.5 ${h} font-mono text-[11px] uppercase tracking-wider text-umber ${className}`}
      data-testid="unassigned-chip"
    >
      Unassigned
    </span>
  )
}

/** Assignee avatar: initials when someone owns the work, a dashed "Unassigned" chip otherwise. */
export function AssigneeAvatar({
  member,
  size = 'xs',
  tone = 'tint',
}: {
  member?: { initials: string; name?: string } | null
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
  tone?: keyof typeof tones
}) {
  if (!member) return <UnassignedChip size={size} />
  return <Avatar initials={member.initials} size={size} tone={tone} />
}
