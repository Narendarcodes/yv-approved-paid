/**
 * Who sees whose payout lines.
 *
 *   onCrew(deal, userId)                 a payee of any milestone (or named on a stored payout)
 *   onDeal(deal, userId)                 a party (client / worker) or on the crew
 *   canReadDeal(deal, userId, admin)     on the deal, or an org admin (payables.view_org)
 *   seesAllPayouts(deal, userId, admin)  the brand (client), or an org admin who is not on the crew
 *   redactDeal(deal, userId)             a crew member's view: only their own payouts and batch lines
 *   redactLedger(deal, entries, userId)  a crew member's ledger: their own payout lines, nobody else's
 *   ownsLedgerEntry(deal, entry, userId) is this payout ledger line the viewer's own
 *
 * Strict crew scoping: deal.manage is a crew grant, not a brand one, so it never
 * opens a deal the user is not on, and never shows a teammate's amount. Only the
 * brand (client) and org admins see every line. Same rule as the payout-receipts
 * endpoint: a crew member sees only their own payout lines. Other members'
 * payout lines are dropped (not shown as blanked rows) and payout batches
 * (totals and every member's item) are left out, as on the receipts endpoint,
 * so nothing on the page adds up to a teammate's amount. Signed terms (payees and shares) are not touched: they
 * are the contract and its hash, and the draft editor sends them back.
 */
import type { DealDoc, MilestoneRuntime, Payout } from './types.cts';
import type { LedgerEntry } from './ledger.cts';

const { totals } = require('./ledger.cts');

function onCrew(deal: DealDoc, userId: string): boolean {
  return (
    deal.terms.milestones.some((t) => t.payees.some((p) => p.userId === userId)) ||
    deal.milestones.some((m) => m.payouts.some((p) => p.userId === userId))
  );
}

/** A party to the deal (client or worker) or a payee of any milestone. */
function onDeal(deal: DealDoc, userId: string): boolean {
  return (
    deal.terms.client.userId === userId ||
    deal.terms.worker.userId === userId ||
    onCrew(deal, userId)
  );
}

/** May this user open the deal at all? On it, or an org admin. A deal manager off the deal may not. */
function canReadDeal(deal: DealDoc, userId: string, admin: boolean): boolean {
  return admin || onDeal(deal, userId);
}

/** Every crew member's payout lines: the brand (client), or an org admin who is not on the crew. */
function seesAllPayouts(deal: DealDoc, userId: string, admin: boolean): boolean {
  if (deal.terms.client.userId === userId) return true;
  return admin && !onCrew(deal, userId);
}

/** The viewer's payee emails on this milestone (legacy payout lines carry only an email). */
function emailsOf(deal: DealDoc, key: string, userId: string): Set<string> {
  const t = deal.terms.milestones.find((x) => x.key === key);
  return new Set(
    (t?.payees || []).filter((p) => p.userId === userId).map((p) => p.email.toLowerCase()),
  );
}

function ownPayout(p: Payout, userId: string, emails: Set<string>): boolean {
  return p.userId ? p.userId === userId : emails.has(String(p.email || '').toLowerCase());
}

function redactMilestone(deal: DealDoc, m: MilestoneRuntime, userId: string): MilestoneRuntime {
  const emails = emailsOf(deal, m.key, userId);
  const payouts = (m.payouts || []).filter((p) => ownPayout(p, userId, emails));
  return {
    ...m,
    payouts,
    paidOutMinor: payouts.reduce((a, p) => a + p.amountMinor, 0),
    // batch totals and items are the whole crew's: a member reads their own lines (payouts) instead
    ...(m.payoutBatches ? { payoutBatches: [] } : {}),
  };
}

/** A crew member's copy of the deal: own payout lines only. Pure; the stored deal is untouched. */
function redactDeal(deal: DealDoc, userId: string): DealDoc {
  return {
    ...deal,
    milestones: deal.milestones.map((m) => redactMilestone(deal, m, userId)),
    // a payout waiting for a tap names every member's amount (payouts never wait today; be safe)
    pendingApprovals: (deal.pendingApprovals || []).filter((p) => p.action.kind !== 'payout'),
  };
}

/**
 * A payout ledger line is the viewer's own when its idempotency key ends with
 * their user id (one line per member: `<batch key>:<userId>`), or, for an older
 * one-line-per-batch entry, when every stored payout of that batch is theirs.
 */
function ownsLedgerEntry(deal: DealDoc, e: LedgerEntry, userId: string): boolean {
  if (e.type !== 'payout') return true;
  if ((e.idempotencyKey || '').endsWith(`:${userId}`)) return true;
  const m = deal.milestones.find((x) => x.key === e.milestoneKey);
  if (!m || !e.paypalRef) return false;
  const emails = emailsOf(deal, m.key, userId);
  const inBatch = m.payouts.filter((p) => p.batchId === e.paypalRef);
  return inBatch.length > 0 && inBatch.every((p) => ownPayout(p, userId, emails));
}

/** Blocked or pending lines for a payout batch carry the whole batch total: crew members do not get them. */
function batchLevelPayoutLine(e: LedgerEntry): boolean {
  return e.type !== 'payout' && (e.idempotencyKey || '').startsWith('payout:');
}

function visibleTo(deal: DealDoc, e: LedgerEntry, userId: string): boolean {
  return !batchLevelPayoutLine(e) && ownsLedgerEntry(deal, e, userId);
}

/** A crew member's ledger: entries filtered, totals recomputed from what is left. The chain is verified on the full ledger by the caller. */
function redactLedger(deal: DealDoc, entries: LedgerEntry[], userId: string) {
  const mine = entries.filter((e) => visibleTo(deal, e, userId));
  return { entries: mine, totals: totals(mine) };
}

module.exports = {
  onCrew,
  onDeal,
  canReadDeal,
  seesAllPayouts,
  redactDeal,
  redactLedger,
  ownsLedgerEntry,
  visibleTo,
};
