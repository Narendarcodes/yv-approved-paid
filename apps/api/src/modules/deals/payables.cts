/**
 * deals/payables: the money views across an organization's deals.
 *
 *   payableRows(deals, now, names)        one row per milestone (brand / admin board)
 *   myMoneyRows(deals, userId, now, names) a crew member's milestones: their share, what was
 *                                          released to them, and when the rest is expected
 *   planApproval(deal, key, userId, now)  the dry run of one approve: what would be captured,
 *                                          whether policy allows it now or it waits for a tap,
 *                                          and who gets how much (splitCents). Pure: moves nothing.
 *   bulkApprove(svc, orgId, userId, items, dryRun)
 *                                          many approves, each through the single-approve path
 *                                          (clock approve or legacy approve + Money Agent tick)
 *
 * Every amount comes from the signed terms and the runtime: nothing in a request
 * names an amount.
 */
import type { DealDoc, MilestoneRuntime, MilestoneTerms, MoneyAction } from './lib/types.cts';

const engine = require('./lib/engine.cts');
const { evaluate, payoutTranche } = require('./lib/policy.cts');
const { splitCents, payeeSplits } = require('./lib/split.cts');
const { holdPlan } = require('./lib/clock.cts');
const reviewClock = require('./lib/review-clock.cts');

const DAY = 24 * 3600 * 1000;
const DONE_STATES = ['APPROVED', 'AUTO_APPROVED', 'CAPTURED', 'PAID_OUT'];
export type Names = Record<string, string>;

function heldOf(m: MilestoneRuntime): number {
  const f = m.funding;
  if (!f?.authorizationId || (f.status !== 'AUTHORIZED' && f.status !== 'PARTIALLY_CAPTURED'))
    return 0;
  return Math.max(0, (f.authorizedMinor || 0) - m.capturedMinor);
}

function clockInfo(deal: DealDoc, key: string, now: string) {
  const v = reviewClock.viewOf(deal, key, now);
  if (!v) return null;
  const live = v.status === 'running' || v.status === 'paused';
  return {
    status: (live ? v.state.status : v.status) as string,
    businessDaysLeft: v.state.businessDaysLeft as number,
    deadline: (v.state.deadline as string | null) || null,
    graceDeadline: (v.state.graceDeadline as string | null) || null,
    revisionsUsed: v.revisionsUsed as number,
    includedRevisionRounds: v.includedRevisionRounds as number,
    partialAmountMinor: v.amounts?.partialAmountCents ?? null,
    remainderMinor: v.amounts?.remainderCents ?? null,
    doneSteps: v.doneSteps as string[],
    line: v.state.line as string,
  };
}

function failedChecksOf(m: MilestoneRuntime): number {
  const c = m.versions[m.versions.length - 1]?.checks;
  if (!c) return 0;
  return new Set([...(c.failed || []), ...(c.unmeasured || [])]).size;
}

function nameOf(names: Names, userId: string, fallback?: string) {
  return names[userId] || fallback || 'Unknown';
}

/** What a person has to do next on this milestone, in plain words. */
function nextActionOf(
  deal: DealDoc,
  m: MilestoneRuntime,
  failed: number,
): { code: string; label: string } {
  if (deal.pendingApprovals.some((p) => p.action.milestoneKey === m.key))
    return { code: 'tap_capture', label: 'Tap to release the capture' };
  const latest = m.versions[m.versions.length - 1];
  switch (m.state) {
    case 'DRAFT':
      return { code: 'sign', label: 'Sign the deal' };
    case 'SIGNED':
      return { code: 'fund', label: 'Fund the hold' };
    case 'FUNDED':
    case 'STYLE_SAMPLE':
      return { code: 'await_delivery', label: 'Waiting for delivery' };
    case 'CHANGES_REQUESTED':
      return { code: 'await_revision', label: 'Waiting for the revision' };
    case 'SUBMITTED':
    case 'CHECKS':
      return { code: 'await_checks', label: 'Checks running' };
    case 'IN_REVIEW':
      if (!latest?.checks) return { code: 'await_checks', label: 'Checks running' };
      return failed > 0
        ? {
            code: 'review_failed',
            label: `Review: ${failed} failed check${failed === 1 ? '' : 's'}`,
          }
        : { code: 'approve', label: 'Review and approve' };
    case 'APPROVED':
    case 'AUTO_APPROVED':
      return { code: 'capturing', label: 'Capturing' };
    case 'CAPTURED':
      return { code: 'paying', label: 'Paying the team' };
    case 'PAID_OUT':
      return { code: 'done', label: 'Paid' };
    case 'DISPUTED':
      return { code: 'dispute', label: 'Settle the dispute' };
    default:
      return { code: 'none', label: 'Nothing to do' };
  }
}

function payableRows(deals: DealDoc[], now: string, names: Names = {}, viewerId = '') {
  const out: Record<string, unknown>[] = [];
  const nowMs = Date.parse(now);
  for (const d of deals) {
    for (const t of d.terms.milestones) {
      const m = d.milestones.find((x) => x.key === t.key);
      if (!m) continue;
      const c = clockInfo(d, t.key, now);
      const held = heldOf(m);
      const f = m.funding;
      let holdAgeDays: number | null = null;
      let holdLapsesAt: string | null = null;
      if (held > 0 && f?.authorizedAt) {
        holdAgeDays = Math.max(0, Math.floor((nowMs - Date.parse(f.authorizedAt)) / DAY));
        const end = c?.graceDeadline || t.dueAt || now;
        holdLapsesAt = holdPlan(f.authorizedAt, end).lapsesISO;
      }
      const failed = failedChecksOf(m);
      const next = nextActionOf(d, m, failed);
      // how long the brand has had the latest cut in review (calendar days)
      const reviewFrom =
        m.state === 'IN_REVIEW' ? m.reviewStartedAt || m.clock?.startedAt : undefined;
      const waitingDays = reviewFrom
        ? Math.max(0, Math.floor((nowMs - Date.parse(reviewFrom)) / DAY))
        : null;
      out.push({
        dealId: d.id,
        dealTitle: d.terms.title,
        milestoneKey: t.key,
        title: t.title,
        editorName: nameOf(names, d.terms.worker.userId, d.terms.worker.displayName),
        team: t.payees.map((p) => ({
          userId: p.userId,
          name: nameOf(names, p.userId, p.displayName),
          shareBp: p.shareBp,
        })),
        amountMinor: t.amountMinor,
        heldMinor: held,
        releasedMinor: m.capturedMinor,
        paidOutMinor: m.paidOutMinor,
        currency: d.terms.currency,
        state: m.state,
        hasClock: !!t.clock,
        clockStatus: c?.status ?? null,
        businessDaysLeft: c ? c.businessDaysLeft : null,
        deadline: c?.deadline ?? null,
        graceDeadline: c?.graceDeadline ?? null,
        revisionsUsed: c ? c.revisionsUsed : m.revisionRoundsUsed,
        revisionsIncluded: c ? c.includedRevisionRounds : t.revisionRoundsIncluded,
        failedChecks: failed,
        waitingDays,
        holdAgeDays,
        holdLapsesAt,
        nextAction: next.label,
        nextActionCode: next.code,
        approvable:
          (next.code === 'approve' || next.code === 'review_failed') &&
          engine.actorRole(d, viewerId) === 'client',
        me: engine.actorRole(d, viewerId),
      });
    }
  }
  return out;
}

/** The member's share of `total` under the signed split (splitCents, leftover to the lead). */
function shareOf(deal: DealDoc, t: MilestoneTerms, total: number, userId: string): number {
  if (!(total > 0) || !t.payees.length) return 0;
  const s = splitCents(total, payeeSplits(deal, t.payees));
  const i = t.payees.findIndex((p) => p.userId === userId);
  return i < 0 ? 0 : s[i].amountCents;
}

function myMoneyRows(deals: DealDoc[], userId: string, now: string) {
  const out: Record<string, unknown>[] = [];
  for (const d of deals) {
    for (const t of d.terms.milestones) {
      const m = d.milestones.find((x) => x.key === t.key);
      if (!m) continue;
      const payee = t.payees.find((p) => p.userId === userId);
      const mine = m.payouts.filter((p) => p.userId === userId);
      if (!payee && !mine.length) continue;
      const myShareMinor = payee ? shareOf(d, t, t.amountMinor, userId) : 0;
      const releasedMinor = mine.reduce((a, p) => a + p.amountMinor, 0);
      const simulated =
        mine.length > 0 && mine.every((p) => p.simulated ?? /^SIM-/.test(p.batchId));
      const c = clockInfo(d, t.key, now);
      // what is still expected, and by when
      const expected: { amountMinor: number; at: string | null; label: string }[] = [];
      const remaining = Math.max(0, myShareMinor - releasedMinor);
      let status: string;
      if (['KILLED', 'CANCELLED'].includes(m.state)) status = 'cancelled';
      else if (m.state === 'DISPUTED') status = 'disputed';
      else if (m.state === 'PAID_OUT' || (remaining === 0 && releasedMinor > 0)) status = 'paid';
      else if (['APPROVED', 'AUTO_APPROVED', 'CAPTURED'].includes(m.state)) status = 'releasing';
      else if (c && (c.status === 'running' || c.status === 'paused'))
        status = c.status === 'paused' ? 'clock_paused' : 'clock_running';
      else if (c && (c.status === 'grace' || c.status === 'released_partial')) status = 'in_grace';
      else if (['DRAFT', 'SIGNED'].includes(m.state)) status = 'not_funded';
      else status = 'in_progress';
      if (remaining > 0 && !['cancelled', 'disputed'].includes(status)) {
        if (status === 'releasing')
          expected.push({ amountMinor: remaining, at: null, label: 'releasing now' });
        else if (
          c &&
          (c.status === 'running' || c.status === 'grace' || c.status === 'released_partial') &&
          c.deadline &&
          c.graceDeadline
        ) {
          const partialDone =
            c.doneSteps.includes('release_partial') || c.status === 'released_partial';
          const myPartial =
            !partialDone && c.partialAmountMinor ? shareOf(d, t, c.partialAmountMinor, userId) : 0;
          if (myPartial > 0)
            expected.push({
              amountMinor: myPartial,
              at: c.deadline,
              label: 'clock deadline (partial release)',
            });
          if (remaining - myPartial > 0)
            expected.push({
              amountMinor: remaining - myPartial,
              at: c.graceDeadline,
              label: 'grace deadline (the rest)',
            });
        } else expected.push({ amountMinor: remaining, at: null, label: 'on approval' });
      }
      const dated = expected.filter((e) => e.at);
      out.push({
        dealId: d.id,
        dealTitle: d.terms.title,
        milestoneKey: t.key,
        title: t.title,
        currency: d.terms.currency,
        amountMinor: t.amountMinor,
        mySharePct: payee ? payee.shareBp / 100 : 0,
        myShareMinor,
        releasedMinor,
        expectedMinor: expected.reduce((a, e) => a + e.amountMinor, 0),
        expected,
        expectedAt: dated.length ? dated[dated.length - 1].at : null,
        expectedLabel: expected.length ? (dated.length ? null : expected[0].label) : null,
        status,
        state: m.state,
        clockStatus: c?.status ?? null,
        simulated,
        payoutCount: mine.length,
      });
    }
  }
  return out;
}

export type ApprovalPlan = {
  dealId: string;
  milestoneKey: string;
  dealTitle?: string;
  title?: string;
  currency?: string;
  path?: 'clock' | 'legacy';
  outcome: 'would_capture' | 'needs_tap' | 'blocked' | 'already_approved' | 'refused';
  code?: string;
  message: string;
  captureMinor: number;
  payoutMinor: number;
  payees: { userId: string; name: string; shareBp: number; amountMinor: number }[];
  violations: { rule: string; message: string }[];
};

/** Dry run of one approve by this user, exactly as the single approve would act. Pure. */
function planApproval(
  deal: DealDoc,
  key: string,
  userId: string,
  now: string,
  names: Names = {},
): ApprovalPlan {
  const t = deal.terms.milestones.find((x) => x.key === key);
  const m = deal.milestones.find((x) => x.key === key);
  const base = {
    dealId: deal.id,
    milestoneKey: key,
    captureMinor: 0,
    payoutMinor: 0,
    payees: [],
    violations: [],
  };
  if (!t || !m)
    return {
      ...base,
      outcome: 'refused',
      code: 'milestone_not_found',
      message: `no milestone ${key}`,
    };
  const head = {
    ...base,
    dealTitle: deal.terms.title,
    title: t.title,
    currency: deal.terms.currency,
    path: (t.clock ? 'clock' : 'legacy') as 'clock' | 'legacy',
  };
  if (engine.actorRole(deal, userId) !== 'client')
    return {
      ...head,
      outcome: 'refused',
      code: 'forbidden',
      message: 'only the brand (the client on this deal) can approve it',
    };
  if (DONE_STATES.includes(m.state))
    return {
      ...head,
      outcome: 'already_approved',
      code: 'already_approved',
      message: `already approved (${m.state}); nothing more moves`,
    };
  const latest = m.versions[m.versions.length - 1];
  if (m.state !== 'IN_REVIEW')
    return {
      ...head,
      outcome: 'refused',
      code: 'invalid_transition',
      message: `cannot approve from ${m.state}`,
    };
  if (!latest)
    return {
      ...head,
      outcome: 'refused',
      code: 'nothing_delivered',
      message: 'nothing has been delivered yet',
    };
  if (!latest.checks)
    return {
      ...head,
      outcome: 'refused',
      code: 'checks_pending',
      message: 'checks have not finished for this version',
    };
  let after: DealDoc;
  try {
    // the clock approve is the human tap for the capture (release = true); the legacy approve is not
    after = engine.approve(deal, key, userId, latest.id, now, !!t.clock);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return {
      ...head,
      outcome: 'refused',
      code: err.code || 'refused',
      message: err.message || 'refused',
    };
  }
  const p = engine
    .plan(after, now)
    .find(
      (x: { action: MoneyAction }) => x.action.milestoneKey === key && x.action.kind === 'capture',
    );
  if (!p)
    return {
      ...head,
      outcome: 'blocked',
      code: 'nothing_to_capture',
      message: 'approving would not capture anything (no live hold)',
    };
  const action = p.action as Extract<MoneyAction, { kind: 'capture' }>;
  const dec = evaluate(after, action, {
    actor: 'system',
    now,
    humanApprovals: after.humanApprovals,
  });
  const ma = after.milestones.find((x) => x.key === key)!;
  const sim = { ...ma, capturedMinor: ma.capturedMinor + Math.max(0, action.amountMinor) };
  const tr = payoutTranche(after, sim, t, 'approve');
  const payees = t.payees.map((pp) => ({
    userId: pp.userId,
    name: nameOf(names, pp.userId, pp.displayName),
    shareBp: pp.shareBp,
    amountMinor: tr.items.find((i: { userId: string }) => i.userId === pp.userId)?.amountMinor || 0,
  }));
  if (dec.violations.length)
    return {
      ...head,
      outcome: 'blocked',
      code: dec.violations[0].rule,
      message: `blocked by policy: ${dec.violations.map((v: { message: string }) => v.message).join('; ')}`,
      captureMinor: action.amountMinor,
      violations: dec.violations,
    };
  if (dec.needsHumanApproval)
    return {
      ...head,
      outcome: 'needs_tap',
      code: 'P7_human_tap',
      message: `approves now; the ${action.amountMinor} capture is above the deal's tap limit, so it waits for one more human tap before money moves`,
      captureMinor: action.amountMinor,
      payoutMinor: tr.totalMinor,
      payees,
    };
  return {
    ...head,
    outcome: 'would_capture',
    message: 'approves and captures now; the team is paid their signed shares',
    captureMinor: action.amountMinor,
    payoutMinor: tr.totalMinor,
    payees,
  };
}

type Svc = {
  get: (id: string, orgId?: string) => Promise<DealDoc>;
  approve: (
    dealId: string,
    orgId: string,
    userId: string,
    key: string,
    versionId: string,
    release: boolean,
  ) => Promise<DealDoc>;
  tick: (dealId: string, orgId?: string) => Promise<{ deal: DealDoc; out: unknown[] }>;
  clockApprove: (
    dealId: string,
    orgId: string,
    userId: string,
    key: string,
  ) => Promise<{ deal: DealDoc; out: unknown[] }>;
};

export type BulkItem = { dealId: string; milestoneKey: string };

/** Validate and de-duplicate the request's items (max 50). Returns null when the shape is wrong. */
function cleanItems(raw: unknown): BulkItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) return null;
  const seen = new Set<string>();
  const out: BulkItem[] = [];
  for (const i of raw) {
    const dealId = typeof i?.dealId === 'string' ? i.dealId.trim() : '';
    const milestoneKey = typeof i?.milestoneKey === 'string' ? i.milestoneKey.trim() : '';
    if (!dealId || !milestoneKey || dealId.length > 100 || milestoneKey.length > 100) return null;
    const k = `${dealId}\u0000${milestoneKey}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ dealId, milestoneKey });
  }
  return out;
}

function totalsOf(plans: ApprovalPlan[]) {
  const byPerson = new Map<
    string,
    { userId: string; name: string; amountMinor: number; currency: string }
  >();
  const byCurrency: Record<string, number> = {};
  for (const p of plans) {
    if (p.outcome !== 'would_capture' && p.outcome !== 'needs_tap') continue;
    const cur = p.currency || 'USD';
    byCurrency[cur] = (byCurrency[cur] || 0) + p.captureMinor;
    for (const x of p.payees) {
      const k = `${x.userId}:${cur}`;
      const row = byPerson.get(k) || {
        userId: x.userId,
        name: x.name,
        amountMinor: 0,
        currency: cur,
      };
      row.amountMinor += x.amountMinor;
      byPerson.set(k, row);
    }
  }
  return { captureByCurrency: byCurrency, byPerson: [...byPerson.values()] };
}

async function bulkApprove(
  svc: Svc,
  orgId: string,
  userId: string,
  items: BulkItem[],
  opts: { dryRun: boolean; now: () => string; names?: (deals: DealDoc[]) => Promise<Names> },
) {
  const loaded = new Map<string, DealDoc | null>();
  const load = async (id: string) => {
    if (!loaded.has(id)) loaded.set(id, await svc.get(id, orgId).catch(() => null));
    return loaded.get(id) || null;
  };
  for (const i of items) await load(i.dealId);
  const names = opts.names
    ? await opts.names([...loaded.values()].filter(Boolean) as DealDoc[])
    : {};
  const plans: ApprovalPlan[] = [];
  for (const i of items) {
    const d = loaded.get(i.dealId);
    // a deal in another org, or one this user cannot see, reads as not found (no existence leak)
    if (!d) {
      plans.push({
        ...i,
        outcome: 'refused',
        code: 'deal_not_found',
        message: 'deal not found',
        captureMinor: 0,
        payoutMinor: 0,
        payees: [],
        violations: [],
      });
      continue;
    }
    plans.push(planApproval(d, i.milestoneKey, userId, opts.now(), names));
  }
  if (opts.dryRun) return { dryRun: true, items: plans, totals: totalsOf(plans), moved: false };

  const results: Record<string, unknown>[] = [];
  for (const p of plans) {
    const base = {
      dealId: p.dealId,
      milestoneKey: p.milestoneKey,
      title: p.title,
      dealTitle: p.dealTitle,
      currency: p.currency,
    };
    if (p.outcome === 'refused' || p.outcome === 'already_approved') {
      results.push({
        ...base,
        ok: p.outcome === 'already_approved',
        outcome: p.outcome,
        code: p.code,
        message: p.message,
        capturedMinor: 0,
        paidOutMinor: 0,
      });
      continue;
    }
    try {
      const before = await svc.get(p.dealId, orgId);
      const m0 = before.milestones.find((x) => x.key === p.milestoneKey)!;
      // re-check under fresh state: a repeat (or a parallel tap) never approves or pays twice
      if (DONE_STATES.includes(m0.state)) {
        results.push({
          ...base,
          ok: true,
          outcome: 'already_approved',
          message: `already approved (${m0.state}); nothing more moves`,
          capturedMinor: 0,
          paidOutMinor: 0,
        });
        continue;
      }
      let deal: DealDoc;
      if (p.path === 'clock')
        deal = (await svc.clockApprove(p.dealId, orgId, userId, p.milestoneKey)).deal;
      else {
        const latest = m0.versions[m0.versions.length - 1];
        await svc.approve(p.dealId, orgId, userId, p.milestoneKey, latest?.id || '', false);
        deal = (await svc.tick(p.dealId, orgId)).deal;
      }
      const m1 = deal.milestones.find((x) => x.key === p.milestoneKey)!;
      const captured = m1.capturedMinor - m0.capturedMinor;
      const paid = m1.paidOutMinor - m0.paidOutMinor;
      const waiting = deal.pendingApprovals.some((x) => x.action.milestoneKey === p.milestoneKey);
      const outcome = captured > 0 ? 'captured' : waiting ? 'waiting_for_tap' : 'approved';
      results.push({
        ...base,
        ok: true,
        outcome,
        state: m1.state,
        message:
          outcome === 'captured'
            ? 'approved and captured; the team was paid their signed shares'
            : outcome === 'waiting_for_tap'
              ? 'approved; the capture is above the tap limit and waits for one more human tap'
              : 'approved; the Money Agent captures on its next pass',
        capturedMinor: captured,
        paidOutMinor: paid,
      });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      results.push({
        ...base,
        ok: false,
        outcome: 'error',
        code: err.code || 'error',
        message: err.message || 'failed',
        capturedMinor: 0,
        paidOutMinor: 0,
      });
    }
  }
  return {
    dryRun: false,
    items: results,
    moved: results.some((r) => (r.capturedMinor as number) > 0),
  };
}

module.exports = {
  payableRows,
  myMoneyRows,
  planApproval,
  bulkApprove,
  cleanItems,
  nextActionOf,
  heldOf,
};
