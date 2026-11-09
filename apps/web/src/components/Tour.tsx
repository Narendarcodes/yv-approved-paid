/**
 * Tour: the first-visit guided tour. Role-aware steps (lib/tour.ts), each
 * anchored to a real element with a spotlight and a small popover; a bottom
 * sheet on narrow screens or when the anchor is not on screen (the sidebar on
 * a phone). Esc skips, arrow keys move, focus stays in the popover.
 *
 * Runs once per user (a localStorage flag; there is no user prefs endpoint)
 * and restarts from the avatar menu via TOUR_START_EVENT. A step whose anchor
 * is missing goes to its route and waits; if it still never shows, the tour
 * moves on. Nothing here moves money or changes data.
 */
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useViewer } from '../lib/viewer'
import { DEMO_DEAL_PATH, isDemoJudge } from '../lib/deals'
import {
  TOUR_START_EVENT,
  atRoute,
  initialTour,
  seenKey,
  stepLabel,
  stepsFor,
  tourReducer,
} from '../lib/tour'

/** How long a step waits for its anchor (after any navigation) before moving on. */
const ANCHOR_WAIT_MS = 4000
const AUTO_START_MS = 700
const PAD = 6
const GAP = 12
const POP_W = 320
const NARROW = 640

type Box = { top: number; left: number; width: number; height: number }

const reducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

const visibleBox = (el: Element): Box | null => {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
    ? { top: r.top, left: r.left, width: r.width, height: r.height }
    : null
}

/** The first rendered match; an element that exists but has no box (display: none) still counts as found. */
function findAnchor(selector: string): Element | null {
  const all = Array.from(document.querySelectorAll(selector))
  return all.find((el) => visibleBox(el)) ?? all[0] ?? null
}

function readSeen(userId: string): boolean {
  try {
    return localStorage.getItem(seenKey(userId)) === '1'
  } catch {
    return false
  }
}
function writeSeen(userId: string) {
  try {
    localStorage.setItem(seenKey(userId), '1')
  } catch {
    /* storage unavailable: the tour may show again next visit */
  }
}

export default function Tour() {
  const viewer = useViewer()
  const location = useLocation()
  const navigate = useNavigate()
  const [state, dispatch] = useReducer(tourReducer, initialTour)
  const [anchor, setAnchor] = useState<Element | null>(null)
  const [box, setBox] = useState<Box | null>(null)
  const [ready, setReady] = useState(false)
  const [vw, setVw] = useState(() => window.innerWidth)
  const [vh, setVh] = useState(() => window.innerHeight)
  const [popH, setPopH] = useState(170)
  const popRef = useRef<HTMLDivElement>(null)
  const nextRef = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<Element | null>(null)
  const loc = useRef(location)
  loc.current = location

  const demoDeal = isDemoJudge(viewer.email) ? DEMO_DEAL_PATH : null
  const steps = stepsFor(viewer.role, { demoDeal })
  const running = state.status === 'running'
  const step = running ? steps[state.index] : null

  const start = useCallback(() => {
    if (!viewer.id) return
    writeSeen(viewer.id)
    returnFocus.current = document.activeElement
    dispatch({ type: 'start', count: steps.length })
  }, [viewer.id, steps.length])

  // first visit: start once the shell has settled
  const autoTried = useRef('')
  useEffect(() => {
    if (!viewer.id || autoTried.current === viewer.id) return
    autoTried.current = viewer.id
    if (readSeen(viewer.id)) return
    const t = window.setTimeout(start, AUTO_START_MS)
    return () => window.clearTimeout(t)
  }, [viewer.id, start])

  // the avatar menu's "Take the tour"
  useEffect(() => {
    const on = () => start()
    window.addEventListener(TOUR_START_EVENT, on)
    return () => window.removeEventListener(TOUR_START_EVENT, on)
  }, [start])

  // resolve the current step's anchor: go to its route, wait, else move on
  useEffect(() => {
    if (!step) return
    let cancelled = false
    let timer = 0
    let t0 = Date.now()
    setReady(false)
    setAnchor(null)
    setBox(null)
    // after a navigation the old page's element can still match for a frame; let the new one render first
    let firstDelay = 0
    if (step.route && !atRoute(step.route, loc.current.pathname, loc.current.search)) {
      navigate(step.route)
      t0 = Date.now()
      firstDelay = 300
    }
    const tick = () => {
      if (cancelled) return
      let el = findAnchor(step.target)
      if (el && !visibleBox(el) && step.fallback) {
        const fb = findAnchor(step.fallback)
        if (fb && visibleBox(fb)) el = fb
      }
      if (el) {
        const b = visibleBox(el)
        if (b) {
          const narrow = window.innerWidth < NARROW
          // bring it into view: centred, or near the top when tall or under a bottom sheet
          el.scrollIntoView({ block: 'nearest', behavior: 'auto' })
          const r = el.getBoundingClientRect()
          const h = window.innerHeight
          const offset = narrow || r.height > h * 0.4 ? 72 : (h - r.height) / 2
          window.scrollTo({
            top: Math.max(0, window.scrollY + r.top - offset),
            behavior: reducedMotion() ? 'auto' : 'smooth',
          })
        }
        setAnchor(el)
        setReady(true)
        return
      }
      if (Date.now() - t0 > ANCHOR_WAIT_MS) {
        dispatch({ type: 'missing' })
        return
      }
      timer = window.setTimeout(tick, 100)
    }
    if (firstDelay) timer = window.setTimeout(tick, firstDelay)
    else tick()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, state.index])

  // keep the spotlight on the anchor through scrolling, resizing and layout shifts
  const target = step?.target
  useEffect(() => {
    if (!running || !anchor || !target) return
    let el: Element = anchor
    const measure = () => {
      setVw(window.innerWidth)
      setVh(window.innerHeight)
      // a re-render can swap the node out (a reel change): follow the selector to its replacement
      if (!el.isConnected) el = findAnchor(target) ?? el
      // (a fallback anchor is shell chrome and stays mounted)
      setBox(el.isConnected ? visibleBox(el) : null)
    }
    measure()
    const iv = window.setInterval(measure, 150)
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.clearInterval(iv)
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [running, anchor, target])

  // the popover's height decides above or below; measure it once per step
  useLayoutEffect(() => {
    if (popRef.current) setPopH(popRef.current.offsetHeight)
  }, [ready, state.index, vw])

  // focus the primary button on each step; give focus back when the tour ends
  useEffect(() => {
    if (running && ready) nextRef.current?.focus({ preventScroll: true })
  }, [running, ready, state.index])
  useEffect(() => {
    if (state.status !== 'done') return
    const el = returnFocus.current as HTMLElement | null
    if (el && el.isConnected && typeof el.focus === 'function') el.focus({ preventScroll: true })
  }, [state.status])

  // Esc skips; arrows move
  useEffect(() => {
    if (!running) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        dispatch({ type: 'skip' })
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        dispatch({ type: 'next' })
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        dispatch({ type: 'back' })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [running])

  if (!running || !step) return null

  const last = state.index === state.count - 1
  const narrow = vw < NARROW
  const spot = ready && box
  const sheet = narrow || !spot
  const titleId = `tour-title-${step.id}`
  const bodyId = `tour-body-${step.id}`

  // desktop popover: right of a sidebar item, else below, else above the anchor
  let pos: { top: number; left: number } | null = null
  if (!sheet && box) {
    const clampX = (x: number) => Math.min(Math.max(16, x), vw - POP_W - 16)
    const clampY = (y: number) => Math.min(Math.max(16, y), vh - popH - 16)
    if (box.left + box.width <= 280 && box.left + box.width + GAP + POP_W < vw) {
      pos = { top: clampY(box.top - 8), left: box.left + box.width + PAD + GAP }
    } else if (box.top + box.height + PAD + GAP + popH < vh - 16) {
      pos = { top: box.top + box.height + PAD + GAP, left: clampX(box.left) }
    } else if (box.top - PAD - GAP - popH > 16) {
      pos = { top: box.top - PAD - GAP - popH, left: clampX(box.left) }
    } else {
      pos = { top: clampY(vh - popH - 24), left: clampX(box.left) }
    }
  }

  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !popRef.current) return
    const f = Array.from(popRef.current.querySelectorAll<HTMLElement>('button:not([disabled])'))
    if (!f.length) return
    const i = f.indexOf(document.activeElement as HTMLElement)
    e.preventDefault()
    f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus()
  }

  return (
    <div className="fixed inset-0 z-[70]" data-testid="tour" data-step={step.id}>
      {/* blocks clicks on the page while the tour is open */}
      {spot ? (
        <div className="absolute inset-0" aria-hidden="true" />
      ) : (
        <div className="fade-in absolute inset-0 bg-ink/40" aria-hidden="true" />
      )}
      {spot && (
        <div
          className="pointer-events-none absolute rounded-md shadow-scrim ring-2 ring-teal/60 motion-safe:transition-[top,left,width,height] motion-safe:duration-300 motion-safe:ease-[var(--ease-out)]"
          style={{
            top: box.top - PAD,
            left: box.left - PAD,
            width: box.width + PAD * 2,
            height: box.height + PAD * 2,
          }}
          data-testid="tour-spotlight"
          aria-hidden="true"
        />
      )}
      {ready && (
        <div
          key={step.id}
          ref={popRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={bodyId}
          onKeyDown={trapTab}
          className={
            sheet
              ? 'rise-in absolute inset-x-0 bottom-0 rounded-t-lg border-t border-line bg-surface px-5 pt-4 pb-[max(20px,env(safe-area-inset-bottom))] shadow-pop'
              : 'fade-in absolute rounded-card border border-line bg-surface p-4 shadow-pop'
          }
          style={sheet ? undefined : { top: pos?.top, left: pos?.left, width: POP_W }}
          data-testid="tour-popover"
          data-mode={sheet ? 'sheet' : 'popover'}
        >
          <p
            className="text-[12px] leading-4 text-umber"
            aria-live="polite"
            data-testid="tour-step-label"
          >
            {stepLabel(state)}
          </p>
          <h2 id={titleId} className="mt-1 text-[16px] leading-[22px] font-medium text-ink">
            {step.title}
          </h2>
          <p id={bodyId} className="mt-1 text-[14px] leading-[22px] text-umber">
            {step.body}
          </p>
          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              className="btn-ghost btn-xs text-umber"
              onClick={() => dispatch({ type: 'skip' })}
              data-testid="tour-skip"
            >
              Skip
            </button>
            <span className="flex-1" />
            <button
              type="button"
              className="btn-secondary btn-xs"
              onClick={() => dispatch({ type: 'back' })}
              disabled={state.index === 0}
              data-testid="tour-back"
            >
              Back
            </button>
            <button
              ref={nextRef}
              type="button"
              className="btn-primary btn-xs"
              onClick={() => dispatch({ type: 'next' })}
              data-testid="tour-next"
            >
              {last ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
