/**
 * The one status + platform vocabulary for yv.
 *
 * Every project, post and pipeline state maps onto seven semantic stages
 * (idea, brief, production, review, scheduled, live, failed). StatusChip and
 * PlatformIcon are the only components that should render them, so a state
 * looks the same on the dashboard, projects, review, calendar and composer.
 */
import { PLATFORMS, PlatformGlyph } from '../lib/publishing'
import type { PlatformKey } from '../services/api'
import { statusLabel } from '../lib/format'

export type Stage = 'idea' | 'brief' | 'production' | 'review' | 'scheduled' | 'live' | 'failed' | 'neutral'

const STAGE_CLASS: Record<Stage, string> = {
  idea: 'bg-st-idea-bg text-st-idea',
  brief: 'bg-st-brief-bg text-st-brief',
  production: 'bg-st-production-bg text-st-production',
  review: 'bg-st-review-bg text-st-review',
  scheduled: 'bg-st-scheduled-bg text-st-scheduled',
  live: 'bg-st-live-bg text-st-live',
  failed: 'bg-st-failed-bg text-st-failed',
  neutral: 'bg-ink/[0.05] text-umber',
}

export const STAGE_DOT: Record<Stage, string> = {
  idea: 'bg-st-idea',
  brief: 'bg-st-brief',
  production: 'bg-st-production',
  review: 'bg-st-review',
  scheduled: 'bg-st-scheduled',
  live: 'bg-st-live',
  failed: 'bg-st-failed',
  neutral: 'bg-umber/50',
}

const STAGE_OF: Record<string, Stage> = {
  // project lifecycle
  IDEA: 'idea',
  APPROVED_CONCEPT: 'idea',
  ASSIGNED: 'brief',
  WAITING_FOR_INPUTS: 'brief',
  INPUTS_READY: 'brief',
  IN_PROGRESS: 'production',
  REVISION_REQUESTED: 'production',
  REVISION_IN_PROGRESS: 'production',
  FIRST_DRAFT_SUBMITTED: 'review',
  UNDER_REVIEW: 'review',
  REVISION_SUBMITTED: 'review',
  APPROVED: 'scheduled',
  SCHEDULED: 'scheduled',
  PUBLISHED: 'live',
  CLOSED: 'neutral',
  CANCELLED: 'neutral',
  // deal milestones (Approved = Paid; docs/phase4-ui-plan.md section 1)
  DRAFT: 'idea',
  SIGNED: 'brief',
  FUNDED: 'production',
  STYLE_SAMPLE: 'production',
  CHANGES_REQUESTED: 'production',
  SUBMITTED: 'review',
  CHECKS: 'review',
  IN_REVIEW: 'review',
  AUTO_APPROVED: 'scheduled',
  CAPTURED: 'scheduled',
  PAID_OUT: 'live',
  DISPUTED: 'failed',
  KILLED: 'neutral',
  // posts / publications
  scheduled: 'scheduled',
  published: 'live',
  live: 'live',
  failed: 'failed',
  cancelled: 'neutral',
  // pipeline stage keys
  idea: 'idea',
  brief: 'brief',
  production: 'production',
  review: 'review',
  publish: 'scheduled',
}

/** Map any project status, post status or stage key to its semantic stage. */
export function stageOf(status: string | undefined | null): Stage {
  if (!status) return 'neutral'
  return STAGE_OF[status] ?? STAGE_OF[status.toUpperCase()] ?? 'neutral'
}

const POST_LABEL: Record<string, string> = { scheduled: 'Scheduled', published: 'Published', failed: 'Failed', cancelled: 'Cancelled' }

export function StatusChip({
  status,
  label,
  stage,
  className = '',
  testId,
}: {
  status?: string
  /** Override the default label (e.g. "Partially published (1/2)"). */
  label?: string
  /** Force a stage when the status string is not a lifecycle value. */
  stage?: Stage
  className?: string
  testId?: string
}) {
  const st = stage ?? stageOf(status)
  const text = label ?? (status ? POST_LABEL[status] ?? statusLabel(status) : '')
  return (
    <span className={`status-chip ${STAGE_CLASS[st]} ${className}`} data-stage={st} data-testid={testId}>
      <span className="status-dot" aria-hidden="true" />
      {text}
    </span>
  )
}

/** Small coloured dot for dense views (calendar cells, legends). */
export function StatusDot({ stage, className = '' }: { stage: Stage; className?: string }) {
  return <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${STAGE_DOT[stage]} ${className}`} aria-hidden="true" />
}

const ICON_BOX = {
  xs: { box: 'h-5 w-5 rounded-[5px]', icon: 11 },
  sm: { box: 'h-6 w-6 rounded-md', icon: 12 },
  md: { box: 'h-8 w-8 rounded-lg', icon: 15 },
  lg: { box: 'h-11 w-11 rounded-xl', icon: 20 },
} as const

/** Platform icon tile - ink square with a white monochrome glyph. */
export function PlatformIcon({
  platform,
  size = 'md',
  className = '',
}: {
  platform: string
  size?: keyof typeof ICON_BOX
  className?: string
}) {
  const key = (platform || '').toLowerCase()
  const b = ICON_BOX[size]
  const label = PLATFORMS[key as PlatformKey]?.label ?? platform
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center ${b.box} bg-ink text-white ${className}`}
      title={label}
      role="img"
      aria-label={label}
    >
      <PlatformGlyph platform={key} size={b.icon} />
    </span>
  )
}

/** A row of platform icons with overlap, for compact lists. */
export function PlatformIcons({ platforms, size = 'sm' }: { platforms: string[]; size?: keyof typeof ICON_BOX }) {
  const uniq = Array.from(new Set(platforms.map((p) => (p || '').toLowerCase()).filter(Boolean)))
  if (!uniq.length) return null
  return (
    <span className="inline-flex items-center gap-1">
      {uniq.map((p) => (
        <PlatformIcon key={p} platform={p} size={size} />
      ))}
    </span>
  )
}
