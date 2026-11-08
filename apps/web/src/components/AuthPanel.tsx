/**
 * AuthPanel: the left half of sign-in and sign-up on wide screens. The logo
 * and one illustration; no copy. Hidden below lg, where the form stands alone.
 */
import BrandLogo from './BrandLogo'
import Illustration, { type IllustrationName } from './Illustration'
import { HackathonCredit } from './Sponsors'

export default function AuthPanel({ illustration }: { illustration: IllustrationName }) {
  return (
    <div className="relative hidden w-[44%] max-w-[640px] flex-col border-r border-line bg-cream px-12 py-10 lg:flex">
      <BrandLogo to="/" size={36} />
      <div className="flex flex-1 items-center justify-center">
        <Illustration name={illustration} className="h-auto w-full max-w-[360px]" />
      </div>
      <HackathonCredit />
    </div>
  )
}
