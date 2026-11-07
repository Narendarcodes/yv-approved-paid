/**
 * Policy engine. Every money action an agent proposes passes through
 * evaluate() before any PayPal call. It is deterministic code, not a model:
 * the LLM can propose, only this decides.
 *
 * Rules (ids appear in violations and in the red-team eval):
 *   P1_state         the milestone is in a state where this action is legal
 *   P2_actor         only the Money Agent ('system') executes money moves
 *   P3_amount        the amount is exactly what the signed deal implies (never more)
 *   P4_terms_locked  terms are signed by both sides and unchanged since (hash match)
 *   P5_already_ran   the same action (idempotency key) has not run before
 *   P6_version       a capture is for the exact approved, checked version
 *   P7_human_tap     big captures and every refund wait for one human tap
 *   P8_currency      the action's currency (if given) is the deal's currency
 *   P9_auth_window   the PayPal authorization is live (honor period / 29-day validity)
 *   P10_payee        payouts go only to payees named in the signed deal, within what was captured
 *   P11_rate_card    change orders are priced from the signed rate card, never invented
 *   P12_milestone    the milestone exists in the signed deal
 *   P13_flagged      no payout while PayPal reports a denied or reversed capture on the milestone
 */
import type { DealDoc, MoneyAction, PolicyDecision, MilestoneRuntime, MilestoneTerms, Role } from './types.cts';

const { hashOf } = require('./canonical.cts');
const { percentOf } = require('./money.cts');

const DAY = 24 * 3600 * 1000;
const HONOR_DAYS = 3;
const AUTH_VALID_DAYS = 29;

export type PolicyContext = {
  actor: Role;
  now: string; // ISO
  /** Idempotency keys a human approved with one tap. */
  humanApprovals?: string[];
  /** For dispute splits and mutual voids: what both sides accepted. */
  agreedSplitMinor?: number;
  mutualConsent?: boolean;
  /** Invoice actions carry the change-order id so two identical asks are two invoices. */
  changeOrderId?: string;
};

function idempotencyKey(deal: DealDoc, a: MoneyAction, m?: MilestoneRuntime, ctx?: PolicyContext): string {
  const base = `${deal.id}:${a.milestoneKey}`;
  switch (a.kind) {
    case 'authorize':
      return `authorize:${base}`;
    case 'reauthorize':
      return `reauthorize:${base}:${(m?.funding?.reauthorizations || []).length + 1}`;
    case 'capture':
      // the Fair Review Clock's grace release carries its step id (PayPal-Request-Id clock:<deal>:<milestone>:<step>)
      if (a.reason === 'clock_grace') return `clock:${base}:release_grace`;
      return `capture:${base}`; // one full capture per milestone, whatever the version
    case 'partial_capture':
      if (a.reason === 'clock_partial') return `clock:${base}:release_partial`;
      return `partial_capture:${base}:${a.reason}`;
    case 'void':
      return `void:${base}:${m?.funding?.authorizationId || 'none'}`;
    case 'refund':
      return `refund:${base}:${a.captureId}`;
    case 'payout':
      return a.tranche ? `payout:${base}:${a.email.toLowerCase()}:${a.tranche}` : `payout:${base}:${a.email.toLowerCase()}`;
    case 'invoice':
      return `invoice:${base}:${ctx?.changeOrderId || 'none'}`;
    default:
      return `unknown:${base}`;
  }
}

function termsLocked(deal: DealDoc): boolean {
  if (!deal.termsHash) return false;
  if (hashOf(deal.terms) !== deal.termsHash) return false;
  const parties = new Set(deal.signatures.filter((s) => s.termsHash === deal.termsHash).map((s) => s.party));
  return parties.has('client') && parties.has('worker');
}

/** What the Fair Review Clock's partial release captured on this milestone. */
function clockPartialCaptured(m: MilestoneRuntime): number {
  return m.captures.filter((c) => c.reason === 'clock_partial').reduce((a, c) => a + c.amountMinor, 0);
}
function paidTo(m: MilestoneRuntime, email: string): number {
  return m.payouts.filter((p) => p.email.toLowerCase() === email.toLowerCase()).reduce((a, p) => a + p.amountMinor, 0);
}

function remainingAuthorized(m: MilestoneRuntime): number {
  return Math.max(0, (m.funding?.authorizedMinor || 0) - m.capturedMinor);
}

function authLive(m: MilestoneRuntime, now: number): { ok: boolean; why?: string } {
  const f = m.funding;
  if (!f || !f.authorizationId) return { ok: false, why: 'no PayPal authorization on this milestone' };
  if (f.status !== 'AUTHORIZED' && f.status !== 'PARTIALLY_CAPTURED') return { ok: false, why: `authorization is ${f.status}` };
  if (f.expiresAt && now >= Date.parse(f.expiresAt)) return { ok: false, why: 'authorization expired (29-day limit)' };
  return { ok: true };
}

function evaluate(deal: DealDoc, action: MoneyAction, ctx: PolicyContext): PolicyDecision {
  const violations: { rule: string; message: string }[] = [];
  const v = (rule: string, message: string) => violations.push({ rule, message });
  const now = Date.parse(ctx.now);

  const terms: MilestoneTerms | undefined = deal.terms.milestones.find((x) => x.key === action.milestoneKey);
  const m: MilestoneRuntime | undefined = deal.milestones.find((x) => x.key === action.milestoneKey);
  const key = idempotencyKey(deal, action, m, ctx);

  if (!terms || !m) {
    v('P12_milestone', `milestone ${action.milestoneKey} is not in the signed deal`);
    return { allowed: false, violations, needsHumanApproval: false, idempotencyKey: key };
  }

  // P2: money moves are executed by the Money Agent only. Humans approve; they never call PayPal directly.
  if (ctx.actor !== 'system') v('P2_actor', `${ctx.actor} cannot execute ${action.kind}; only the Money Agent can`);

  // P4: signed, locked, unchanged terms.
  if (!termsLocked(deal)) v('P4_terms_locked', 'deal terms are not signed by both sides or changed after signing');

  // P5: idempotency.
  if (deal.executedKeys.includes(key)) v('P5_already_ran', `${action.kind} already ran for this milestone (${key})`);

  // P8: currency.
  const cur = (action as { currency?: string }).currency;
  if (cur && cur !== deal.terms.currency) v('P8_currency', `currency ${cur} does not match the deal (${deal.terms.currency})`);

  // amounts must be positive safe integers when present
  const amt = (action as { amountMinor?: number }).amountMinor;
  if (amt !== undefined && (!Number.isSafeInteger(amt) || amt <= 0)) v('P3_amount', `amount must be a positive whole number of minor units (got ${amt})`);

  let needsHumanApproval = false;
  const remaining = remainingAuthorized(m);

  switch (action.kind) {
    case 'authorize': {
      if (m.state !== 'SIGNED') v('P1_state', `can only fund a SIGNED milestone (it is ${m.state})`);
      if (m.funding?.authorizationId && m.funding.status !== 'VOIDED' && m.funding.status !== 'EXPIRED')
        v('P5_already_ran', 'milestone already has a live authorization');
      if (action.amountMinor !== terms.amountMinor)
        v('P3_amount', `authorize amount must equal the signed milestone amount (${terms.amountMinor}), got ${action.amountMinor}`);
      break;
    }
    case 'reauthorize': {
      const live = authLive(m, now);
      if (!live.ok) v('P9_auth_window', live.why || 'authorization not live');
      const firstAuth = m.funding?.authorizedAt ? Date.parse(m.funding.authorizedAt) : NaN;
      const honorEnd = m.funding?.honorExpiresAt ? Date.parse(m.funding.honorExpiresAt) : NaN;
      if (!Number.isFinite(firstAuth)) v('P9_auth_window', 'no authorization date');
      else {
        if (now < honorEnd) v('P9_auth_window', 'still inside the 3-day honor period; reauthorize after it lapses');
        if (now >= firstAuth + AUTH_VALID_DAYS * DAY) v('P9_auth_window', 'past day 29; a new authorization is needed instead');
      }
      if (['CAPTURED', 'PAID_OUT', 'CANCELLED'].includes(m.state)) v('P1_state', `nothing to keep alive in ${m.state}`);
      break;
    }
    case 'capture': {
      if (m.state !== 'APPROVED' && m.state !== 'AUTO_APPROVED') v('P1_state', `capture needs an approved milestone (it is ${m.state})`);
      const live = authLive(m, now);
      if (!live.ok) v('P9_auth_window', live.why || 'authorization not live');
      const expected = Math.min(terms.amountMinor, m.funding?.authorizedMinor || 0) - m.capturedMinor;
      if (action.amountMinor !== expected) v('P3_amount', `capture must be exactly ${expected} (signed amount less earlier captures), got ${action.amountMinor}`);
      if (action.amountMinor > remaining) v('P3_amount', `capture ${action.amountMinor} exceeds the held amount ${remaining}`);
      if (!action.final) v('P3_amount', 'an approval capture is the final capture for the milestone');
      // P6: exact approved version.
      const latest = m.versions[m.versions.length - 1];
      if (!latest) v('P6_version', 'no submitted version');
      else {
        if (action.versionId !== latest.id) v('P6_version', `capture names version ${action.versionId}, but the latest submitted version is ${latest.id}`);
        if (action.reason === 'approval' && m.approvedVersionId !== action.versionId)
          v('P6_version', `version ${action.versionId} is not the version the client approved (${m.approvedVersionId || 'none'})`);
        if (action.reason === 'auto_approval' || action.reason === 'clock_grace') {
          if (m.state !== 'AUTO_APPROVED') v('P6_version', 'auto-approval capture without the review window lapsing');
          if (!latest.checks?.passed) v('P6_version', 'auto-approval needs the version to have passed every check');
        }
        if (action.reason === 'clock_grace' && !m.clock?.doneSteps?.includes('release_grace'))
          v('P1_state', 'the review clock has not reached its grace release');
      }
      if (action.amountMinor > deal.terms.humanApprovalThresholdMinor) needsHumanApproval = true;
      break;
    }
    case 'partial_capture': {
      const live = authLive(m, now);
      if (!live.ok) v('P9_auth_window', live.why || 'authorization not live');
      if (action.reason === 'kill_fee') {
        if (m.state !== 'KILLED') v('P1_state', `kill fee needs a KILLED milestone (it is ${m.state})`);
        const fee = percentOf(terms.amountMinor, deal.terms.killFeeBp);
        if (action.amountMinor !== fee) v('P3_amount', `kill fee must be ${deal.terms.killFeeBp / 100}% = ${fee}, got ${action.amountMinor}`);
      } else if (action.reason === 'clock_partial') {
        // the signed review clock ran out with no reply: release exactly the signed partial share, once
        const c = m.clock;
        if (!terms.clock || !c) v('P1_state', 'this milestone has no review clock');
        else {
          if (m.state !== 'IN_REVIEW' || c.status !== 'running') v('P1_state', `the review clock is not running in review (milestone ${m.state}, clock ${c.status})`);
          if (!c.doneSteps.includes('release_partial')) v('P1_state', 'the review clock has not reached its partial release');
          if (action.amountMinor !== c.schedule.partialAmountCents)
            v('P3_amount', `partial release must be exactly ${c.schedule.partialAmountCents} from the signed clock terms, got ${action.amountMinor}`);
        }
      } else {
        if (m.state !== 'DISPUTED') v('P1_state', `a dispute split needs a DISPUTED milestone (it is ${m.state})`);
        if (ctx.agreedSplitMinor === undefined) v('P3_amount', 'no split accepted by both sides');
        else if (action.amountMinor !== ctx.agreedSplitMinor) v('P3_amount', `split must be the accepted ${ctx.agreedSplitMinor}, got ${action.amountMinor}`);
      }
      if (action.amountMinor > remaining) v('P3_amount', `partial capture ${action.amountMinor} exceeds the held amount ${remaining}`);
      if (action.amountMinor > deal.terms.humanApprovalThresholdMinor) needsHumanApproval = true;
      break;
    }
    case 'void': {
      const live = authLive(m, now);
      if (!live.ok) v('P9_auth_window', live.why || 'authorization not live');
      if (action.reason === 'missed_deadline') {
        const due = Date.parse(terms.dueAt) + terms.graceHours * 3600 * 1000;
        if (!['FUNDED', 'STYLE_SAMPLE', 'CHANGES_REQUESTED', 'CANCELLED'].includes(m.state))
          v('P1_state', `deadline void is not allowed in ${m.state} (work was delivered or is being reviewed)`);
        if (now <= due) v('P1_state', 'the deadline plus grace period has not passed yet');
      } else if (action.reason === 'remainder_after_partial') {
        if (!['KILLED', 'CAPTURED', 'DISPUTED'].includes(m.state)) v('P1_state', `remainder void not expected in ${m.state}`);
      } else if (action.reason === 'mutual') {
        if (!ctx.mutualConsent) v('P1_state', 'mutual cancel needs both sides to agree');
      } else if (action.reason === 'dispute_split') {
        if (m.state !== 'DISPUTED' && m.state !== 'CANCELLED') v('P1_state', `dispute void not expected in ${m.state}`);
      } else if (action.reason === 'cancelled') {
        if (!['KILLED', 'CANCELLED'].includes(m.state)) v('P1_state', `cancel void not expected in ${m.state}`);
      }
      break;
    }
    case 'refund': {
      const cap = m.captures.find((c) => c.id === action.captureId);
      if (!cap) v('P3_amount', `capture ${action.captureId} is not on this milestone`);
      else if (action.amountMinor > cap.amountMinor) v('P3_amount', `refund ${action.amountMinor} exceeds the capture ${cap.amountMinor}`);
      needsHumanApproval = true; // every refund
      break;
    }
    case 'payout': {
      const partial = clockPartialCaptured(m);
      if (action.tranche === 'clock_partial') {
        if (partial <= 0) v('P1_state', 'no review-clock partial release was captured on this milestone');
      } else if (m.state !== 'CAPTURED') v('P1_state', `payouts go out after capture (milestone is ${m.state})`);
      const payee = terms.payees.find((p) => p.email.toLowerCase() === action.email.toLowerCase());
      if (!payee) v('P10_payee', `${action.email} is not a payee in the signed deal`);
      if ((deal.alerts || []).some((x) => x.milestoneKey === m.key && /CAPTURE\.(DENIED|REVERSED)$/.test(x.eventType)))
        v('P13_flagged', 'PayPal reported a denied or reversed capture on this milestone; a person has to clear it first');
      const available = m.capturedMinor - m.paidOutMinor;
      if (action.amountMinor > available) v('P10_payee', `payout ${action.amountMinor} exceeds captured-but-unpaid ${available}`);
      if (payee) {
        const share = percentOf(m.capturedMinor, payee.shareBp);
        if (action.amountMinor > share) v('P10_payee', `payout ${action.amountMinor} exceeds this payee's share ${share}`);
        else if (paidTo(m, payee.email) + action.amountMinor > share)
          v('P10_payee', `payout ${action.amountMinor} plus ${paidTo(m, payee.email)} already paid exceeds this payee's share ${share}`);
        if (action.tranche === 'clock_partial' && action.amountMinor > percentOf(partial, payee.shareBp))
          v('P10_payee', `payout ${action.amountMinor} exceeds this payee's share of the partial release ${percentOf(partial, payee.shareBp)}`);
      }
      break;
    }
    case 'invoice': {
      const item = deal.terms.rateCard.find((r) => r.id === action.rateCardItemId);
      if (!item) v('P11_rate_card', `rate card has no item ${action.rateCardItemId}`);
      if (!Number.isInteger(action.quantity) || action.quantity <= 0) v('P11_rate_card', 'quantity must be a positive whole number');
      if (item && action.amountMinor !== item.unitPriceMinor * action.quantity)
        v('P11_rate_card', `price must be ${item.unitPriceMinor} x ${action.quantity} = ${item.unitPriceMinor * action.quantity} from the signed rate card, got ${action.amountMinor}`);
      if (['CANCELLED', 'PAID_OUT', 'DRAFT'].includes(m.state)) v('P1_state', `no change orders on a ${m.state} milestone`);
      if (!ctx.changeOrderId) v('P11_rate_card', 'invoice needs a change-order id');
      break;
    }
    default:
      v('P1_state', `unknown action ${(action as { kind: string }).kind}`);
  }

  if (needsHumanApproval && ctx.humanApprovals?.includes(key)) needsHumanApproval = false;
  return { allowed: violations.length === 0 && !needsHumanApproval, violations, needsHumanApproval: violations.length === 0 && needsHumanApproval, idempotencyKey: key };
}

module.exports = { evaluate, idempotencyKey, termsLocked, HONOR_DAYS, AUTH_VALID_DAYS };
