/**
 * Landing: one sentence about what yv. does, one product view, one button
 * (try the demo). The team illustration sits beside the product shot.
 */
import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Loader2 } from 'lucide-react'
import { WAKING_LABEL, useWakeState, wakeApi } from '../lib/wake'
import BrandLogo from '../components/BrandLogo'
import Illustration from '../components/Illustration'
import { HackathonCredit } from '../components/Sponsors'

export default function LandingPage() {
  // wake the free Render API while the visitor reads
  const wake = useWakeState()
  useEffect(() => {
    void wakeApi()
  }, [])
  return (
    <div id="top" className="min-h-screen bg-canvas text-ink antialiased">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <BrandLogo to="/" size={34} />
        <Link to="/login" className="btn-ghost btn-sm">
          Sign in
        </Link>
      </header>

      <main className="mx-auto max-w-6xl px-6 pb-20">
        <section className="grid items-center gap-10 pt-8 sm:pt-14 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div>
            <h1 className="max-w-2xl text-[clamp(1.75rem,4vw,2.875rem)] font-medium leading-[1.15] tracking-[-0.02em] text-ink">
              yv. turns a brand content team&apos;s deal into a payday its freelancers can count on.
            </h1>
            <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2">
              <Link to="/login?demo=1" className="btn-primary btn-lg" data-testid="landing-demo">
                Try the demo
                <ArrowRight size={18} strokeWidth={1.75} />
              </Link>
              {wake === 'waking' && (
                <span
                  className="inline-flex items-center gap-2 text-[13px] text-umber"
                  role="status"
                  data-testid="api-waking"
                >
                  <Loader2
                    size={14}
                    strokeWidth={1.75}
                    className="animate-spin"
                    aria-hidden="true"
                  />
                  {WAKING_LABEL}
                </span>
              )}
            </div>
          </div>
          <Illustration
            name="team"
            className="mx-auto hidden h-auto w-full max-w-[340px] lg:block"
          />
        </section>

        <section className="mt-14 sm:mt-16" aria-label="Product">
          <figure className="overflow-hidden rounded-[14px] border border-line bg-surface shadow-pop">
            <img
              src="/landing/deal.png"
              alt="A deal in yv.: the reels on the left, the selected reel with its review clock and Approve & release on the right"
              className="block h-auto w-full"
              width={1440}
              height={900}
            />
          </figure>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-6 text-[13px] text-umber">
          <HackathonCredit className="max-w-3xl" />
          <span>© {new Date().getFullYear()} yv.</span>
          <span className="flex gap-5">
            <Link to="/login" className="hover:text-ink">
              Sign in
            </Link>
            <Link to="/register" className="hover:text-ink">
              Create account
            </Link>
          </span>
        </div>
      </footer>
    </div>
  )
}
