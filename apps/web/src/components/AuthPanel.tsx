/**
 * AuthPanel: the left half of sign-in and sign-up on wide screens. The logo,
 * three short value lines, the illustration with a small static product
 * glimpse (a reel in review with its clock and held money), and the hackathon
 * credit. Hidden below lg, where the form stands alone.
 */
import { CalendarCheck, ShieldCheck, Sparkles } from 'lucide-react'
import BrandLogo from './BrandLogo'
import Illustration, { type IllustrationName } from './Illustration'
import { HackathonCredit } from './Sponsors'

const VALUES = [
  { icon: CalendarCheck, text: 'Plan the payday before work starts' },
  { icon: Sparkles, text: 'AI checks facts, people own taste' },
  { icon: ShieldCheck, text: 'Paid on time through PayPal' },
] as const

/** Static, decorative: what a reel looks like mid-review. Not live data. */
function ProductGlimpse() {
  return (
    <div
      className="w-[300px] rounded-[12px] border border-line bg-surface p-3.5 shadow-pop"
      aria-hidden="true"
      data-testid="auth-glimpse"
    >
      <div className="flex items-center gap-3">
        <span className="h-9 w-14 shrink-0 rounded-md bg-teal/90" />
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-ink">Reel 3: 15s story cut</p>
          <p className="text-[11.5px] text-umber">v2 · checks passed</p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-1.5 whitespace-nowrap text-[12px]">
        <span className="status-chip bg-st-review-bg text-st-review">In review</span>
        <span className="text-umber">2 business days left</span>
        <span className="t-num ml-auto text-ink">$200 held</span>
      </div>
    </div>
  )
}

export default function AuthPanel({ illustration }: { illustration: IllustrationName }) {
  return (
    <div className="relative hidden w-[44%] max-w-[640px] flex-col border-r border-line bg-cream px-12 py-10 lg:flex">
      <BrandLogo to="/" size={36} />
      <div className="flex flex-1 flex-col justify-center gap-10 py-8">
        <ul className="space-y-3" data-testid="auth-values">
          {VALUES.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-center gap-3 text-[15px] text-ink">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface text-teal">
                <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
              </span>
              {text}
            </li>
          ))}
        </ul>
        <div className="relative mx-auto w-full max-w-[400px]">
          <Illustration name={illustration} className="h-auto w-full max-w-[320px]" />
          <div className="absolute -bottom-6 -right-8 xl:-right-14">
            <ProductGlimpse />
          </div>
        </div>
      </div>
      <HackathonCredit />
    </div>
  )
}
