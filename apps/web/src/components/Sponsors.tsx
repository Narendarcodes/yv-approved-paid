/**
 * Hackathon credit and the PayPal sandbox chip. Text marks only: no sponsor
 * logos are bundled, so no trademark artwork ships with the app.
 */

export const BUILT_WITH = [
  { name: 'PayPal', what: 'Orders, Payouts, Invoicing · sandbox' },
  { name: 'Render', what: 'API, agent, Workflows clock' },
  { name: 'AG Grid', what: 'Payables' },
  { name: 'APIMatic', what: 'typed PayPal SDK' },
] as const

/** "Built for the PayPal AI Hackathon" plus quiet "Built with" marks. */
export function HackathonCredit({ className = '' }: { className?: string }) {
  return (
    <div className={`text-[12px] leading-5 text-umber ${className}`} data-testid="hackathon-credit">
      <p className="text-ink">Built for the PayPal AI Hackathon</p>
      <p>
        Built with{' '}
        {BUILT_WITH.map((s, i) => (
          <span key={s.name}>
            {i > 0 && <span aria-hidden="true"> · </span>}
            <span className="font-medium text-ink/80">{s.name}</span> <span>({s.what})</span>
          </span>
        ))}
      </p>
    </div>
  )
}

/** Wherever money moves: test money only. */
export function SandboxChip({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-xs border border-line-strong px-1.5 py-px text-[12px] leading-4 text-umber ${className}`}
      title="PayPal sandbox: test money only. Ids marked mock or simulated are not PayPal objects."
      data-testid="sandbox-chip"
    >
      PayPal sandbox
    </span>
  )
}
