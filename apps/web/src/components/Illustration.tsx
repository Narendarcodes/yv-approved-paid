/**
 * Illustration: one of the eight unDraw drawings in public/illustrations,
 * recoloured to the brand teal and warm neutrals. Used only on empty states,
 * the sign-in panel, the landing hero, the "Paid" moment and the error page;
 * never on busy working screens. Decorative by default (alt="").
 * Credits: unDraw (undraw.co), free licence, no attribution required.
 */
export const ILLUSTRATIONS = {
  team: 'Two people building content together',
  deal: 'A handshake over a signed deal',
  wallet: 'An empty wallet',
  paid: 'Money received on a phone',
  review: 'Documents reviewed and approved',
  payments: 'A freelancer holding a payment card',
  calendar: 'A planner at a schedule board',
  error: 'A screen showing an error',
} as const

export type IllustrationName = keyof typeof ILLUSTRATIONS

export default function Illustration({
  name,
  className = 'h-32 w-auto',
  alt = '',
}: {
  name: IllustrationName
  className?: string
  alt?: string
}) {
  return (
    <img
      src={`/illustrations/${name}.svg`}
      alt={alt}
      aria-hidden={alt ? undefined : true}
      className={`select-none ${className}`}
      draggable={false}
      loading="lazy"
      data-illustration={name}
    />
  )
}
