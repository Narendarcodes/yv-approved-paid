/**
 * Crew split math. Pure: integer cents in, integer cents out, no floats on an
 * amount.
 *
 *   splitCents(totalCents, splits)   each member's share of one release
 *   payeeSplits(deal, payees)        the signed payees as splits (lead = the deal's worker)
 *
 * Each share is floor(total * share), and the cents left over by flooring go
 * to the lead (the member with role 'lead', or else the first member), so the
 * shares always add up to exactly the total.
 */
import type { DealDoc, Payee } from './types.cts';

export type SplitInput = { memberId: string; pct: number; role?: string };
export type SplitShare = { memberId: string; pct: number; bp: number; role: 'lead' | 'member'; amountCents: number };

class SplitError extends Error {
  code = 'invalid_split';
}

/** 33.33 -> 3333 basis points. Rejects anything finer than 0.01% or outside (0, 100]. */
function pctToBp(pct: unknown): number {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) throw new SplitError(`share ${String(pct)} is not a number`);
  const bp = Math.round(pct * 100);
  if (Math.abs(bp - pct * 100) > 1e-6) throw new SplitError(`share ${pct}% is finer than 0.01%`);
  if (bp < 1 || bp > 10000) throw new SplitError(`share ${pct}% must be between 0.01% and 100%`);
  return bp;
}

function splitCents(totalCents: number, splits: SplitInput[]): SplitShare[] {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new SplitError(`total ${totalCents} must be a whole, non-negative number of cents`);
  if (!Array.isArray(splits) || splits.length === 0) throw new SplitError('a split needs at least one member');
  const seen = new Set<string>();
  const rows = splits.map((s) => {
    const memberId = typeof s?.memberId === 'string' ? s.memberId.trim() : '';
    if (!memberId) throw new SplitError('each member needs an id');
    if (seen.has(memberId)) throw new SplitError(`member ${memberId} appears twice`);
    seen.add(memberId);
    return { memberId, pct: s.pct, bp: pctToBp(s.pct), role: s.role === 'lead' ? 'lead' : 'member' } as const;
  });
  const totalBp = rows.reduce((a, r) => a + r.bp, 0);
  if (totalBp !== 10000) throw new SplitError(`shares must add up to 100% (they add up to ${totalBp / 100}%)`);
  const leads = rows.filter((r) => r.role === 'lead').length;
  if (leads > 1) throw new SplitError('only one member can be the lead');
  const leadAt = leads === 1 ? rows.findIndex((r) => r.role === 'lead') : 0;
  // BigInt so total * bp never loses precision, whatever the total
  const out: SplitShare[] = rows.map((r, i) => ({
    memberId: r.memberId,
    pct: r.bp / 100,
    bp: r.bp,
    role: i === leadAt ? 'lead' : 'member',
    amountCents: Number((BigInt(totalCents) * BigInt(r.bp)) / BigInt(10000)),
  }));
  const leftover = totalCents - out.reduce((a, s) => a + s.amountCents, 0);
  out[leadAt].amountCents += leftover;
  return out;
}

/** The signed payees of a milestone as splits. The lead is a payee marked lead, else the deal's worker, else the first payee. */
function payeeSplits(deal: DealDoc, payees: Payee[]): SplitInput[] {
  const marked = payees.find((p) => p.role === 'lead');
  const lead = marked || payees.find((p) => p.userId === deal.terms.worker.userId) || payees[0];
  return payees.map((p) => ({ memberId: p.userId, pct: p.shareBp / 100, role: p === lead ? 'lead' : 'member' }));
}

module.exports = { splitCents, payeeSplits, pctToBp, SplitError };
