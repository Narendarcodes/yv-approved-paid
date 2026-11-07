/**
 * Plain-language explanation for every money move on the timeline. Built from
 * templates and the numbers the policy engine already checked; a model never
 * writes an amount. Names are the parties' display names from the deal.
 */
import type { DealDoc, MoneyAction, MilestoneTerms } from './types.cts';

const { format } = require('./money.cts');

function fmtDate(iso?: string): string {
  if (!iso) return 'n/a';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function explain(deal: DealDoc, action: MoneyAction, extra: Record<string, unknown> = {}): string {
  const t: MilestoneTerms | undefined = deal.terms.milestones.find((m) => m.key === action.milestoneKey);
  const cur = deal.terms.currency;
  const client = deal.terms.client.displayName;
  const worker = deal.terms.worker.displayName;
  const title = t ? `"${t.title}"` : action.milestoneKey;
  const amt = (n?: number) => (n === undefined ? '' : format(n, cur));
  switch (action.kind) {
    case 'authorize':
      return `Held ${amt(action.amountMinor)} from ${client}'s PayPal for ${title}. Nothing is charged yet: the money is reserved until the work is approved. The hold is valid until ${fmtDate(extra.expiresAt as string)}; I refresh it after the 3-day honor period so it stays good.`;
    case 'reauthorize':
      return `Refreshed the PayPal hold for ${title} because the 3-day honor period ended. Same amount, still not charged; valid until ${fmtDate(extra.expiresAt as string)}.`;
    case 'capture':
      if (action.reason === 'clock_grace')
        return `${client} did not reply before the review clock's grace period ended, and version ${action.versionId} passed every check, so the rest of the hold was released as the signed deal says. Charged ${amt(action.amountMinor)} for ${title}.`;
      return action.reason === 'auto_approval'
        ? `${client} did not respond within the review window, and version ${action.versionId} passed every check, so it counts as approved. Charged ${amt(action.amountMinor)} for ${title}.`
        : `${client} approved version ${action.versionId} of ${title}. Charged exactly the agreed ${amt(action.amountMinor)} from the hold, for that version only.`;
    case 'partial_capture':
      if (action.reason === 'clock_partial')
        return `${client} did not reply within the signed review window for ${title}, and the delivery passed every check, so the agreed partial amount of ${amt(action.amountMinor)} was released to the team. The rest stays held through the grace period.`;
      return action.reason === 'kill_fee'
        ? `${client} stopped ${title}. The signed deal gives ${worker} a ${deal.terms.killFeeBp / 100}% kill fee, so I charged ${amt(action.amountMinor)} and release the rest of the hold.`
        : `Both sides accepted a split for ${title}: ${worker} receives ${amt(action.amountMinor)}; the rest of the hold is released to ${client}.`;
    case 'void': {
      const why: Record<string, string> = {
        missed_deadline: `the deadline plus grace period passed without a delivery, and ${client} chose to cancel`,
        cancelled: 'the milestone was cancelled',
        remainder_after_partial: 'only part of the hold was owed',
        dispute_split: 'the dispute was settled with nothing owed',
        mutual: 'both sides agreed to cancel',
      };
      return `Released the remaining PayPal hold on ${title} back to ${client} because ${why[action.reason] || action.reason}. Nothing more will be charged for it.`;
    }
    case 'refund':
      return `Refunded ${amt(action.amountMinor)} of capture ${action.captureId} on ${title} to ${client}, after a person approved it.`;
    case 'payout': {
      const batch = extra.batch as { batchId: string; simulated: boolean; reason?: string; items: unknown[] } | undefined;
      const item = extra.item as { email: string; displayName?: string; shareBp: number; amountMinor: number } | undefined;
      const who = item ? item.displayName || item.email : `${action.items.length} payee(s)`;
      const share = item ? ` (${item.shareBp / 100}% share)` : '';
      const money = amt(item ? item.amountMinor : action.amountMinor);
      const step = String(extra.stepLabel || action.step);
      const n = batch?.items.length || action.items.length;
      if (batch?.simulated)
        return `Simulated payout: ${money} to ${who}${share} for ${title}, ${step}, in batch ${batch.batchId} (one batch for ${n} ${n === 1 ? 'person' : 'people'}). No money left PayPal: ${batch.reason || 'payouts are simulated'}.`;
      return `Paid ${money} to ${who}${share} for ${title}, ${step}, in one PayPal Payouts batch ${batch?.batchId || ''} for ${n} ${n === 1 ? 'person' : 'people'}.`;
    }
    case 'invoice': {
      const sent = !!extra.invoiceStatus && extra.invoiceStatus !== 'DRAFT';
      return `${sent ? 'Created and sent' : 'Drafted'} a PayPal invoice for a change order on ${title}: ${action.quantity} × ${String(extra.itemLabel || action.rateCardItemId)} at the signed rate-card price, ${amt(action.amountMinor)} in total. ${client} accepted the change order; ${sent ? 'it is charged only when the invoice is paid.' : 'the invoice waits in PayPal as a draft until it is sent.'}`;
    }
    default:
      return 'Money step';
  }
}

function explainBlocked(action: MoneyAction, violations: { rule: string; message: string }[]): string {
  return `Blocked ${action.kind.replace('_', ' ')}: ${violations.map((v) => v.message).join('; ')}. No money moved.`;
}

module.exports = { explain, explainBlocked, fmtDate };
