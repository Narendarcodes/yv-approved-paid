/**
 * DealSection: a quiet collapsible block on the selected reel (checks, team
 * payout, change orders, money trail, review terms). Cards inside drop their
 * own frame. Open state lives in the URL (?open=checks,money or ?open=all) so
 * a person, a test or an agent can deep-link straight to it.
 */
import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { BareCards } from './common'

export default function DealSection({
  id,
  title,
  meta,
  open,
  onToggle,
  children,
}: {
  id: string
  title: string
  meta?: ReactNode
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <section className="border-t border-line" id={`section-${id}`} data-section={id}>
      <button
        type="button"
        className="flex w-full items-center gap-2 py-3 text-left text-[14px] text-ink hover:text-teal"
        aria-expanded={open}
        aria-controls={`section-${id}-body`}
        onClick={onToggle}
        data-testid={`section-${id}`}
      >
        <ChevronRight
          size={16}
          strokeWidth={1.5}
          className={`shrink-0 text-umber transition-transform ${open ? 'rotate-90' : ''}`}
          aria-hidden="true"
        />
        <span className="flex-1 font-medium">{title}</span>
        {meta && <span className="text-[13px] text-umber">{meta}</span>}
      </button>
      {open && (
        <div id={`section-${id}-body`} className="pb-5 pl-6">
          <BareCards.Provider value={true}>{children}</BareCards.Provider>
        </div>
      )}
    </section>
  )
}
