/**
 * PolicyBlockedChip: a blocked decision shown as its rule id + one line.
 * Never a button: a blocked proposal has nothing to tap.
 */
import { Ban } from 'lucide-react'

export type Violation = { rule: string; message: string }

export default function PolicyBlockedChip({ violations, moved = false }: { violations: Violation[]; moved?: boolean }) {
  if (!violations?.length) return null
  return (
    <div className="flex flex-col gap-1.5" data-testid="policy-blocked">
      {violations.map((v) => (
        <div key={`${v.rule}:${v.message}`} className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="status-chip bg-st-failed-bg font-mono text-st-failed">
            <Ban size={12} strokeWidth={2} aria-hidden="true" />
            {v.rule}
          </span>
          <span className="text-umber">{v.message}</span>
        </div>
      ))}
      {!moved && <p className="font-mono text-[11px] text-label">Blocked by policy. No money moved.</p>}
    </div>
  )
}
