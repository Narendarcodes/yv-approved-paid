/**
 * Team payout receipts for one milestone: one line per member per payout batch,
 * read from what the engine stored when the batch ran (milestone.payouts).
 *
 *   receiptsOf(deal, key, { userId, all })
 *     all = true   the brand (client) and deal managers: every member's line
 *     all = false  a member: only their own lines, and no batch totals
 */
import type { DealDoc, Payout } from './types.cts';

const { splitCents, payeeSplits } = require('./split.cts');

const STEP_LABEL: Record<string, string> = {
  release_partial: 'Partial release',
  release_grace: 'Grace release',
  approve: 'Approved',
  auto_approve: 'Auto-approved',
  kill_fee: 'Kill fee',
  dispute_split: 'Dispute split',
  final: 'Final release',
};

export type ReceiptLine = {
  userId: string;
  displayName: string;
  amountMinor: number;
  shareBp: number;
  step: string;
  stepLabel: string;
  batchId: string;
  simulated: boolean;
  /** Why the line was simulated (the batch's reason), when it was. */
  reason?: string;
  status: string;
  at: string;
};

function receiptsOf(deal: DealDoc, key: string, viewer: { userId: string; all: boolean }) {
  const t = deal.terms.milestones.find((x) => x.key === key);
  const m = deal.milestones.find((x) => x.key === key);
  if (!t || !m) return null;
  const payeeOf = (p: Payout) =>
    t.payees.find((x) => (p.userId ? x.userId === p.userId : x.email.toLowerCase() === p.email.toLowerCase()));
  const batchOf = (id: string) => (m.payoutBatches || []).find((b) => b.batchId === id);
  const all: ReceiptLine[] = m.payouts.map((p) => {
    const payee = payeeOf(p);
    const step = p.step || (p.tranche === 'clock_partial' ? 'release_partial' : 'final');
    const simulated = p.simulated ?? batchOf(p.batchId)?.simulated ?? /^SIM-/.test(p.batchId);
    return {
      userId: p.userId || payee?.userId || '',
      displayName: p.displayName || payee?.displayName || p.email,
      amountMinor: p.amountMinor,
      shareBp: p.shareBp ?? payee?.shareBp ?? 0,
      step,
      stepLabel: STEP_LABEL[step] || step,
      batchId: p.batchId,
      simulated: !!simulated,
      ...(simulated && batchOf(p.batchId)?.reason ? { reason: batchOf(p.batchId)!.reason } : {}),
      status: p.status,
      at: p.at,
    };
  });
  const lines = viewer.all ? all : all.filter((l) => l.userId === viewer.userId);
  // what each member is owed from the whole signed milestone amount (same splitCents the batches use)
  const shares = t.payees.length ? splitCents(t.amountMinor, payeeSplits(deal, t.payees)) : [];
  const team = t.payees.map((p, i) => ({
    userId: p.userId,
    displayName: p.displayName || p.email,
    shareBp: p.shareBp,
    role: shares[i]?.role || 'member',
    shareOfMilestoneMinor: shares[i]?.amountCents || 0,
    paidMinor: all.filter((l) => l.userId === p.userId).reduce((a, l) => a + l.amountMinor, 0),
  }));
  const me = team.find((x) => x.userId === viewer.userId) || null;
  return {
    milestoneKey: key,
    title: t.title,
    currency: deal.terms.currency,
    scope: viewer.all ? ('all' as const) : ('own' as const),
    milestoneAmountMinor: t.amountMinor,
    paidOutMinor: viewer.all ? m.paidOutMinor : lines.reduce((a, l) => a + l.amountMinor, 0),
    team: viewer.all ? team : me ? [me] : [],
    me,
    batches: viewer.all
      ? (m.payoutBatches || []).map((b) => ({
          batchId: b.batchId,
          step: b.step,
          stepLabel: STEP_LABEL[b.step] || b.step,
          amountMinor: b.amountMinor,
          simulated: b.simulated,
          reason: b.reason,
          status: b.status,
          at: b.at,
          members: b.items.length,
        }))
      : [],
    lines,
  };
}

module.exports = { receiptsOf, STEP_LABEL };
