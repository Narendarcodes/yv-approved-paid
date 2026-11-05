/**
 * JudgeTour: a dismissible three-step strip on the demo deal. Each step scrolls
 * to (or opens) the thing a judge should see; nothing here moves money.
 *
 *   1. the money timeline and the PayPal ids behind it
 *   2. the dispute split card (checklist arithmetic, two taps)
 *   3. the copilot asked to "Capture $450 on reel 1": policy blocks it
 */
import { useState } from 'react'
import { Check, Compass, X } from 'lucide-react'

const KEY = 'yv.judgeTour.dismissed'

export const JUDGE_TOUR_ASK = 'Capture $450 on reel 1'

function scrollTo(selector: string) {
  const el = document.querySelector(selector)
  if (!el) return false
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  el.classList.add('ring-2', 'ring-teal/40')
  window.setTimeout(() => el.classList.remove('ring-2', 'ring-teal/40'), 1800)
  return true
}

export default function JudgeTour({ onAsk }: { onAsk: (text: string) => void }) {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(KEY) === '1'
    } catch {
      return false
    }
  })
  const [done, setDone] = useState<number[]>([])
  if (hidden) return null
  const mark = (i: number) => setDone((d) => (d.includes(i) ? d : [...d, i]))
  const dismiss = () => {
    try {
      localStorage.setItem(KEY, '1')
    } catch {
      /* storage unavailable: hide for this visit only */
    }
    setHidden(true)
  }
  const steps: { label: string; run: () => void }[] = [
    {
      label: 'Where the money is',
      run: () => scrollTo('[data-testid=paypal-holds]') || scrollTo('[data-testid=money-timeline]'),
    },
    { label: 'The dispute split', run: () => scrollTo('[data-testid=dispute-split-card]') },
    { label: `Ask: "${JUDGE_TOUR_ASK}"`, run: () => onAsk(JUDGE_TOUR_ASK) },
  ]
  return (
    <div
      className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-teal/25 bg-tint/40 px-4 py-2.5"
      data-testid="judge-tour"
      role="region"
      aria-label="Judge tour"
    >
      <span className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase text-teal">
        <Compass size={14} strokeWidth={2} aria-hidden="true" /> Judge tour
      </span>
      <ol className="flex min-w-0 flex-1 flex-wrap gap-2">
        {steps.map((s, i) => (
          <li key={s.label}>
            <button
              type="button"
              onClick={() => {
                s.run()
                mark(i)
              }}
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[12px] text-ink hover:border-teal hover:text-teal"
              data-testid={`judge-tour-step-${i + 1}`}
            >
              <span
                className={`flex h-4 w-4 items-center justify-center rounded-full font-mono text-[10px] ${done.includes(i) ? 'bg-teal text-on-accent' : 'bg-ink/10 text-umber'}`}
                aria-hidden="true"
              >
                {done.includes(i) ? <Check size={10} strokeWidth={3} /> : i + 1}
              </span>
              {s.label}
            </button>
          </li>
        ))}
      </ol>
      <button
        type="button"
        onClick={dismiss}
        className="icon-btn icon-btn-sm"
        aria-label="Dismiss the judge tour"
        data-testid="judge-tour-dismiss"
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  )
}
