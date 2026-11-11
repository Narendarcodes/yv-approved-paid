/**
 * The two sides of the judge demo (DEMO_MODE=1 API only):
 *
 *   judge   Nora Hayes, Lumen Coffee's content lead: the brand side, lands on the demo deal
 *   editor  Leo Carter, the editor on the crew: lands on "My money" (his payday)
 *
 * POST /auth/demo-login { as } accepts only these two. The switch shows only for
 * the seeded demo accounts, so a real account never sees it.
 */
export type DemoAs = 'judge' | 'editor'

export const DEMO_VIEWS: Record<DemoAs, { label: string; short: string; email: string }> = {
  judge: { label: 'Brand view (Nora)', short: 'Brand view', email: 'judge@yv-demo.example.com' },
  editor: { label: 'Crew view (Leo)', short: 'Crew view', email: 'editor@yv-demo.example.com' },
}

/** Which demo side this signed-in email is, or null for any other account. */
export function demoViewOf(email: string | null | undefined): DemoAs | null {
  const e = (email || '').trim().toLowerCase()
  for (const as of Object.keys(DEMO_VIEWS) as DemoAs[]) if (DEMO_VIEWS[as].email === e) return as
  return null
}

/** The other side of the demo (what the switch offers). */
export function otherDemoView(as: DemoAs): DemoAs {
  return as === 'judge' ? 'editor' : 'judge'
}

/** Where each side lands after signing in: Nora on the deal, Leo on his money. */
export function demoLanding(as: DemoAs, dealId: string): string {
  return as === 'editor' ? '/my-money' : `/deals/${encodeURIComponent(dealId)}`
}
