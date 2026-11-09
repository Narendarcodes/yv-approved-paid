/**
 * The landing's moving background: the three.js gallery tunnel from the old
 * hero (GalleryTunnel), behind the simple hero.
 *
 * - First paint never waits for it: a static SVG drawing of the same tunnel
 *   paints with the page, and the WebGL chunk (three.js) loads lazily once
 *   the browser is idle. The canvas fades in over the drawing.
 * - prefers-reduced-motion: the static drawing only; three.js is never fetched.
 * - Save-Data / 2g connections and browsers without WebGL also keep the drawing.
 * - A scrim keeps the headline readable; the bottom fades into the page.
 */
import { Suspense, lazy, useEffect, useState } from 'react'

const GalleryTunnel = lazy(() => import('./GalleryTunnel'))

function prefersReduced() {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  )
}

function canAnimate() {
  if (prefersReduced()) return false
  const c = (
    navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }
  ).connection
  if (c?.saveData || /(^|-)2g$/.test(c?.effectiveType ?? '')) return false
  try {
    const cv = document.createElement('canvas')
    const gl = (cv.getContext('webgl2') || cv.getContext('webgl')) as WebGLRenderingContext | null
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    return !!gl
  } catch {
    return false
  }
}

/** The tunnel, frozen: nested frames and the four corner rails, in the line colour. */
export function StaticTunnel({ className = '' }: { className?: string }) {
  const frames = [0, 1, 2, 3, 4, 5, 6, 7]
  // each frame is the tunnel mouth scaled toward the vanishing point (perspective-ish spacing)
  return (
    <svg
      className={className}
      viewBox="0 0 1600 1000"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      data-testid="hero-static"
    >
      <rect width="1600" height="1000" fill="#F7F4EE" />
      <g fill="none" stroke="#E2DDD4" strokeWidth="2">
        {frames.map((i) => {
          const k = 1 / (1 + i * 0.55)
          const w = 1700 * k
          const h = 1060 * k
          return <rect key={i} x={800 - w / 2} y={500 - h / 2} width={w} height={h} />
        })}
        <path d="M-50 -30 L740 463 M1650 -30 L860 463 M-50 1030 L740 537 M1650 1030 L860 537" />
      </g>
      {/* a few slabs, like the live tunnel's coloured tiles */}
      <g opacity="0.5">
        <path d="M120 960 L330 960 L560 720 L470 720 Z" fill="#E6F2F0" />
        <path d="M1480 40 L1290 40 L1080 270 L1160 270 Z" fill="#EFE9DF" />
        <path d="M0 300 L0 520 L330 560 L330 420 Z" fill="#E6F2F0" />
        <path d="M1600 640 L1600 820 L1290 700 L1290 600 Z" fill="#035E5E" opacity="0.18" />
      </g>
    </svg>
  )
}

export default function HeroBackground({ className = '' }: { className?: string }) {
  const [live, setLive] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!canAnimate()) return
    // wait for idle so the headline, CTA and product shot paint first
    const idle = 'requestIdleCallback' in window
    const id = idle
      ? window.requestIdleCallback(() => setLive(true), { timeout: 1500 })
      : window.setTimeout(() => setLive(true), 600)
    // someone switches reduced motion on mid-visit: drop the canvas
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => {
      if (mq.matches) {
        setLive(false)
        setReady(false)
      }
    }
    mq.addEventListener?.('change', onChange)
    return () => {
      if (idle) window.cancelIdleCallback(id)
      else window.clearTimeout(id)
      mq.removeEventListener?.('change', onChange)
    }
  }, [])

  return (
    <div
      className={`pointer-events-none overflow-hidden ${className}`}
      aria-hidden="true"
      data-testid="hero-bg"
    >
      <StaticTunnel
        className={`absolute inset-0 h-full w-full transition-opacity duration-700 ${ready ? 'opacity-0' : 'opacity-100'}`}
      />
      {live && (
        <Suspense fallback={null}>
          <GalleryTunnel className="absolute inset-0" onReady={() => setReady(true)} />
        </Suspense>
      )}
      {/* legibility: a soft wash behind the copy, and a fade into the page at the bottom */}
      <div className="absolute inset-0 bg-canvas/70 sm:bg-[radial-gradient(ellipse_48%_42%_at_30%_32%,rgba(247,244,238,0.93),rgba(247,244,238,0.6)_55%,rgba(247,244,238,0)_85%)]" />
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-canvas" />
    </div>
  )
}
