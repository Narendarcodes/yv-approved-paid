/**
 * deals/team: who gets paid for a milestone, and their split.
 *
 *   planTeam(deal, input, ctx)   dry run: the payees as they would be signed, plus
 *                                every rule they break (never throws for a rule)
 *   applyTeam(deal, plan)        the new terms with that milestone's payees replaced
 *
 * Payees move money (PayPal Payouts go only to the payees named in the signed
 * deal, P10), so the rules are strict:
 *
 *   T1_client_only     only the deal's client picks the team
 *   T2_signed_terms    once both sides signed, the team is locked with the money
 *                      terms; it is never a direct edit (draft a new deal instead)
 *   T3_shape           1-10 payees, each a distinct person, whole basis points 1..10000
 *   T4_total_100       shares add up to exactly 100% (10000 bp), checked here on the server
 *   T5_member          every payee is an active member of the deal's organization
 *   T6_milestone       the milestone exists
 *
 * People type the shares; no agent route reaches this module, and amounts per
 * payee are computed here from the signed milestone amount, never accepted.
 * Editing a draft clears both signatures (engine.editTerms), so the worker has
 * to sign the new split too.
 */
import type { DealDoc, DealTerms, Payee } from './lib/types.cts';

const User = require('../../models/user.model');
const access = require('../access/index.cts');
const { percentOf } = require('./lib/money.cts');
const { splitCents, payeeSplits } = require('./lib/split.cts');
const { actorRole } = require('./lib/engine.cts');

const MAX_PAYEES = 10;
const OBJECT_ID = /^[0-9a-f]{24}$/i;

export type TeamInput = { payees?: { userId?: unknown; shareBp?: unknown; label?: unknown }[] };
export type TeamViolation = { rule: string; message: string };
export type TeamPlan = {
  allowed: boolean;
  violations: TeamViolation[];
  milestoneKey: string;
  currency: string;
  amountMinor: number;
  totalBp: number;
  /** Signing clears: both sides sign the new split again. */
  clearsSignatures: boolean;
  payees: (Payee & { name: string; amountMinor: number })[];
};

function label(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  const s = v.replace(/\s+/g, ' ').trim().slice(0, 40);
  return s || fallback;
}

async function planTeam(deal: DealDoc, key: string, input: TeamInput, ctx: { orgId: string; userId: string }): Promise<TeamPlan> {
  const violations: TeamViolation[] = [];
  const v = (rule: string, message: string) => violations.push({ rule, message });
  const t = deal.terms.milestones.find((m) => m.key === key);
  const base = {
    milestoneKey: key,
    currency: deal.terms.currency,
    amountMinor: t?.amountMinor ?? 0,
    clearsSignatures: deal.signatures.length > 0,
  };
  if (!t) {
    v('T6_milestone', `milestone ${key} is not in this deal`);
    return { ...base, allowed: false, violations, totalBp: 0, payees: [] };
  }
  if (actorRole(deal, ctx.userId) !== 'client') v('T1_client_only', 'only the client picks the team for a milestone');
  if (deal.termsHash)
    v('T2_signed_terms', 'the team is part of the signed money terms, so it cannot be edited; agree a new deal to change who is paid');

  const rows = Array.isArray(input?.payees) ? input.payees : null;
  if (!rows || rows.length === 0 || rows.length > MAX_PAYEES) v('T3_shape', `name 1 to ${MAX_PAYEES} people`);
  const seen = new Set<string>();
  const payees: TeamPlan['payees'] = [];
  let totalBp = 0;
  for (const r of (rows || []).slice(0, MAX_PAYEES)) {
    const userId = typeof r?.userId === 'string' ? r.userId.trim() : '';
    const shareBp = r?.shareBp;
    if (!OBJECT_ID.test(userId)) {
      v('T3_shape', 'each payee needs a member id');
      continue;
    }
    if (seen.has(userId)) v('T3_shape', 'each person can appear once per milestone');
    seen.add(userId);
    if (!Number.isInteger(shareBp) || (shareBp as number) < 1 || (shareBp as number) > 10000) {
      v('T3_shape', 'each share is a whole number of basis points between 0.01% and 100%');
      continue;
    }
    totalBp += shareBp as number;
    const member = await access.memberOf(userId, ctx.orgId);
    const user = member ? await User.findById(userId).select('name email').lean() : null;
    if (!member || !user) {
      v('T5_member', 'every payee must be an active member of this organization');
      continue;
    }
    // keep the payout email already on the draft for this person, else the worker's PayPal email, else their account email
    const prev = t.payees.find((p) => p.userId === userId);
    const email = prev?.email || (userId === deal.terms.worker.userId && deal.terms.worker.paypalEmail) || user.email;
    payees.push({
      userId,
      email,
      shareBp: shareBp as number,
      displayName: label(r?.label, prev?.displayName || user.name),
      name: user.name,
      amountMinor: percentOf(t.amountMinor, shareBp as number),
    });
  }
  if (rows && rows.length && totalBp !== 10000) v('T4_total_100', `shares must add up to 100% (they add up to ${totalBp / 100}%)`);
  else if (payees.length && payees.reduce((a, p) => a + p.shareBp, 0) === 10000 && new Set(payees.map((p) => p.userId)).size === payees.length) {
    // the same split the payout batches use: floor each share, leftover cents to the lead
    const shares = splitCents(t.amountMinor, payeeSplits(deal, payees));
    payees.forEach((p, i) => (p.amountMinor = shares[i].amountCents));
  }
  return { ...base, allowed: violations.length === 0, violations, totalBp, payees };
}

function applyTeam(deal: DealDoc, plan: TeamPlan): DealTerms {
  const terms: DealTerms = JSON.parse(JSON.stringify(deal.terms));
  const m = terms.milestones.find((x) => x.key === plan.milestoneKey)!;
  m.payees = plan.payees.map((p) => ({ userId: p.userId, email: p.email, shareBp: p.shareBp, displayName: p.displayName }));
  return terms;
}

/** HTTP status for a refused plan: the most specific rule wins. */
function statusOf(plan: TeamPlan): { status: number; code: string } {
  const rules = plan.violations.map((x) => x.rule);
  if (rules.includes('T6_milestone')) return { status: 404, code: 'milestone_not_found' };
  if (rules.includes('T1_client_only')) return { status: 403, code: 'client_only' };
  if (rules.includes('T2_signed_terms')) return { status: 409, code: 'deal_locked' };
  return { status: 422, code: rules.includes('T4_total_100') ? 'shares_not_100' : 'invalid_team' };
}

module.exports = { planTeam, applyTeam, statusOf, MAX_PAYEES };
