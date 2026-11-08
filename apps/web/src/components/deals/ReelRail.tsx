/**
 * ReelRail: every reel of the deal with its state and signed amount. A
 * vertical list on desktop, a horizontal switcher on mobile. Selecting a reel
 * sets ?reel=<key>, so the selection is a link.
 */
import type { DealView } from '../../contracts/types'
import { StatusChip } from '../status'
import { money } from '../../lib/deals'

export default function ReelRail({
  deal,
  selected,
  onSelect,
}: {
  deal: DealView
  selected: string
  onSelect: (key: string) => void
}) {
  return (
    <nav aria-label="Reels" data-testid="reel-rail" className="min-w-0">
      <ul className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:p-0">
        {deal.terms.milestones.map((t) => {
          const r = deal.milestones.find((m) => m.key === t.key)
          const on = t.key === selected
          return (
            <li
              key={t.key}
              className="shrink-0 lg:shrink"
              ref={
                on ? (el) => el?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) : undefined
              }
            >
              <button
                type="button"
                onClick={() => onSelect(t.key)}
                aria-current={on ? 'true' : undefined}
                data-testid={`reel-tab-${t.key}`}
                className={`w-[184px] rounded-lg border px-3 py-2.5 text-left transition-colors lg:w-full ${
                  on ? 'border-line-strong bg-surface' : 'border-transparent hover:bg-ink/[0.04]'
                }`}
              >
                <span className="block truncate text-[14px] text-ink">{t.title}</span>
                <span className="mt-1.5 flex items-center justify-between gap-2">
                  {r && <StatusChip status={r.state} />}
                  <span className="t-num text-[13px] text-umber">
                    {money(t.amountMinor, deal.terms.currency)}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
