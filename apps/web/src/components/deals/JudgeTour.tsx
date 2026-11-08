/**
 * JudgeTour: one small "Tour" button on the demo deal. It opens three steps;
 * each selects the right reel, opens the right section and scrolls to it.
 * Nothing here moves money.
 *
 *   1. the money trail and the PayPal ids behind it
 *   2. the dispute split card (checklist arithmetic, two taps)
 *   3. the copilot asked to "Capture $450 on reel 1": policy blocks it
 */
import { useEffect, useRef, useState } from 'react'
import { Check, Compass } from 'lucide-react'

const KEY = 'yv.judgeTour.dismissed'

export const JUDGE_TOUR_ASK = 'Capture $450 on reel 1'

/** Scroll to the first match once it renders, with a short highlight ring. */
export function scrollToWhenReady(selector: string, tries = 20) {
  const el = document.querySelector(selector)
  if (!el) {
    if (tries > 0) window.setTimeout(() => scrollToWhenReady(selector, tries - 1), 100)
    return
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  el.classList.add('ring-2', 'ring-teal/40')
  window.setTimeout(() => el.classList.remove('ring-2', 'ring-teal/40'), 1800)
}

export default function JudgeTour({
  onMoney,
  onDispute,
  onAsk,
}: {
  onMoney: () => void
  onDispute: () => void
  onAsk: (text: string) => void
}) {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(KEY) === '1'
    } catch {
      return false
    }
  })
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState<number[]>([])
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', off)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', off)
      document.removeEventListener('keydown', esc)
    }
  }, [open])
  if (hidden) return null
  const dismiss = () => {
    try {
      localStorage.setItem(KEY, '1')
    } catch {
      /* storage unavailable: hide for this visit only */
    }
    setHidden(true)
  }
  const steps: { label: string; run: () => void }[] = [
    { label: 'Where the money is', run: onMoney },
    { label: 'The dispute split', run: onDispute },
    { label: `Ask "${JUDGE_TOUR_ASK}"`, run: () => onAsk(JUDGE_TOUR_ASK) },
  ]
  return (
    <div className="relative" ref={ref} data-testid="judge-tour">
      <button
        type="button"
        className="btn-ghost btn-xs"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
      >
        <Compass size={14} strokeWidth={1.5} aria-hidden="true" />
        Tour
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Judge tour"
          className="absolute right-0 z-30 mt-1 w-64 rounded-xl border border-line bg-surface p-1.5 shadow-pop"
        >
          {steps.map((s, i) => (
            <button
              key={s.label}
              type="button"
              role="menuitem"
              className="menu-item w-full"
              onClick={() => {
                s.run()
                setDone((d) => (d.includes(i) ? d : [...d, i]))
                setOpen(false)
              }}
              data-testid={`judge-tour-step-${i + 1}`}
            >
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${done.includes(i) ? 'bg-teal text-on-accent' : 'bg-ink/[0.06] text-umber'}`}
                aria-hidden="true"
              >
                {done.includes(i) ? <Check size={11} strokeWidth={2.5} /> : i + 1}
              </span>
              {s.label}
            </button>
          ))}
          <button
            type="button"
            role="menuitem"
            className="menu-item w-full text-umber"
            onClick={dismiss}
            data-testid="judge-tour-dismiss"
          >
            Hide tour
          </button>
        </div>
      )}
    </div>
  )
}
