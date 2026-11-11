/**
 * Deal copilot starters and money-card rules by the viewer's side of the deal
 * (DealView.me). Only the brand (the client) approves and releases money, so
 * crew and observers get starters about their own money and the split, and
 * never a money-moving proposal card. The API enforces the same rule (only
 * the client approves; policy decides every move); this is the UX side.
 */
export type Starter = { label: string; prompt: string }

/** The brand: where the money is, the dispute split, and a money ask policy blocks. */
export const CLIENT_STARTERS: Starter[] = [
  { label: 'Money timeline', prompt: 'Where is the money?' },
  { label: 'Dispute split', prompt: 'Show the dispute split on reel 2' },
  { label: 'Capture $450', prompt: 'Capture $450 on reel 1' },
]

/** Crew (worker, payees) and anyone else who is not the brand on this deal. */
export const CREW_STARTERS: Starter[] = [
  { label: 'My money', prompt: 'Where is my money?' },
  { label: 'Dispute split', prompt: 'Show the dispute split on reel 2' },
]

export function startersFor(me: string | null | undefined): Starter[] {
  return me === 'client' ? CLIENT_STARTERS : CREW_STARTERS
}

/** Copilot actions that propose moving money (capture/pay/release). */
export const MONEY_MOVING_ACTIONS: ReadonlySet<string> = new Set(['proposeCapture'])

/** May this viewer see this copilot card? Money-moving cards are for the brand only. */
export function mayShowAction(name: string, me: string | null | undefined): boolean {
  return me === 'client' || !MONEY_MOVING_ACTIONS.has(name)
}
