/**
 * PolicyBlockedChip: a blocked decision shown as one chip per rule (rule id +
 * plain-words name) with its reasons under it. Repeated reasons collapse and
 * raw minor units are shown as currency. Never a button: a blocked proposal
 * has nothing to tap.
 */
import { Ban } from 'lucide-react'
import { groupViolations, type PolicyViolation } from '../../lib/deals'

export type Violation = PolicyViolation

export default function PolicyBlockedChip({
  violations,
  moved = false,
  currency = 'USD',
  showFooter = true,
}: {
  violations: Violation[]
  moved?: boolean
  currency?: string
  /** Print "Blocked by policy. No money moved." under the list. */
  showFooter?: boolean
}) {
  const groups = groupViolations(violations, currency)
  if (!groups.length) return null
  return (
    <div className="flex flex-col gap-2" data-testid="policy-blocked">
      <ul className="flex flex-col gap-2">
        {groups.map((g) => (
          <li key={g.rule} className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-2.5">
            <span className="status-chip shrink-0 bg-st-failed-bg text-st-failed" title={g.rule}>
              <Ban size={12} strokeWidth={2} aria-hidden="true" />
              <span className="font-mono">{g.id}</span>
              <span className="opacity-80">{g.name}</span>
            </span>
            <span className="min-w-0 text-[12.5px] leading-snug text-umber sm:pt-0.5">
              {g.messages.map((m) => (
                <span key={m} className="block">
                  {m}
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
      {showFooter && !moved && (
        <p className="font-mono text-xs text-label">Blocked by policy. No money moved.</p>
      )}
    </div>
  )
}
