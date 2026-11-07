/** Small pieces shared by the money grids: the narrow-screen hook and the status pill. */
import { useEffect, useState } from 'react'
import { StatusChip, type Stage } from '../status'

/** True below `px` wide (the grids hide their less important columns there). */
export function useNarrow(px = 760): boolean {
  const q = `(max-width: ${px}px)`
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(q).matches,
  )
  useEffect(() => {
    const mq = window.matchMedia(q)
    const on = () => setNarrow(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [q])
  return narrow
}

/** One plain status for a milestone row: the review clock's phase wins over the raw state while it counts. */
export function payableStatus(
  state: string,
  clockStatus: string | null,
): { label: string; stage: Stage } {
  if (state === 'IN_REVIEW' && clockStatus) {
    if (clockStatus === 'running') return { label: 'In review · clock running', stage: 'review' }
    if (clockStatus === 'paused') return { label: 'In review · clock paused', stage: 'review' }
    if (clockStatus === 'grace') return { label: 'In grace', stage: 'production' }
    if (clockStatus === 'released_partial')
      return { label: 'In grace · part released', stage: 'production' }
    if (clockStatus === 'waiting_checks') return { label: 'Checks running', stage: 'review' }
  }
  const map: Record<string, { label: string; stage: Stage }> = {
    DRAFT: { label: 'Draft', stage: 'idea' },
    SIGNED: { label: 'Signed · not funded', stage: 'brief' },
    FUNDED: { label: 'Held · in production', stage: 'production' },
    STYLE_SAMPLE: { label: 'Style sample', stage: 'production' },
    SUBMITTED: { label: 'Delivered', stage: 'review' },
    CHECKS: { label: 'Checks running', stage: 'review' },
    IN_REVIEW: { label: 'In review', stage: 'review' },
    CHANGES_REQUESTED: { label: 'Changes requested', stage: 'production' },
    APPROVED: { label: 'Approved', stage: 'scheduled' },
    AUTO_APPROVED: { label: 'Auto-approved', stage: 'scheduled' },
    CAPTURED: { label: 'Captured · paying', stage: 'scheduled' },
    PAID_OUT: { label: 'Paid', stage: 'live' },
    DISPUTED: { label: 'Disputed', stage: 'failed' },
    KILLED: { label: 'Killed', stage: 'neutral' },
    CANCELLED: { label: 'Cancelled', stage: 'neutral' },
  }
  return map[state] || { label: state.replace(/_/g, ' ').toLowerCase(), stage: 'neutral' }
}

export function StatusPill({ label, stage }: { label: string; stage: Stage }) {
  return <StatusChip stage={stage} label={label} />
}

/** "8 Nov" (no time) for dates in dense cells. */
export function shortDate(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
