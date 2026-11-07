/**
 * Deal service: the pure engine plus Mongo, a per-deal lock and the clock.
 *
 * Every change to a deal runs as: take the deal's lock -> load -> apply one
 * engine function (which may call PayPal and append ledger lines) -> save with
 * the lock token -> release. The lock is what keeps two Money Agent ticks, or a
 * tick and a webhook, from both acting on the same hold. PayPal-Request-Id
 * (the policy idempotency key) is the second line of defence.
 */
import type { DealDoc, DealTerms, ChangeItem } from './types.cts';
import type { PaymentGateway } from './gateway.cts';
import type { LedgerEntry } from './ledger.cts';
import type { EngineDeps, ExecOutcome, LedgerStore } from './engine.cts';

const crypto = require('node:crypto');
const { Deal, DealLedger, PaypalWebhook } = require('./models.cts');
const engine = require('./engine.cts');
const { verifyChain, totals } = require('./ledger.cts');
const { TERMINAL } = require('./states.cts');
const { hashOf } = require('./canonical.cts');
const proposals = require('./proposals.cts');
const { emitLedgerAppend } = require('../events.cts');
const reviewClock = require('./review-clock.cts');

const RETRY_BLOCKED_MS = 6 * 3600 * 1000;
const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** In-app notifications for clock steps: best effort, after the step is saved, never breaks a money step. */
async function sendNotices(notices: { userIds: string[]; type: string; title: string; body: string; payload: Record<string, unknown> }[]) {
  if (!notices.length) return 0;
  const { createNotification } = require('../../../services/notification.service');
  let sent = 0;
  for (const n of notices)
    for (const userId of n.userIds) {
      if (!OBJECT_ID.test(String(userId || ''))) continue;
      try {
        await createNotification({ userId, type: n.type, title: n.title, body: n.body, payload: n.payload });
        sent += 1;
      } catch {
        /* notifications are best-effort */
      }
    }
  return sent;
}

const LOCK_MS = 60_000;

const mongoLedger: LedgerStore = {
  async last(dealId) {
    const e = await DealLedger.findOne({ dealId }).sort({ seq: -1 }).lean();
    return e ? strip(e) : null;
  },
  async append(entry) {
    await DealLedger.create(entry);
    emitLedgerAppend(entry); // live MoneyTimeline (socket room deal:<id>)
  },
  async list(dealId) {
    return (await DealLedger.find({ dealId }).sort({ seq: 1 }).lean()).map(strip);
  },
};
function strip(e: any): LedgerEntry {
  const { _id, ...rest } = e;
  return rest as LedgerEntry;
}

function paypalIdsOf(d: DealDoc): string[] {
  const ids: string[] = [];
  for (const m of d.milestones) {
    if (m.funding?.orderId) ids.push(m.funding.orderId);
    if (m.funding?.authorizationId) ids.push(m.funding.authorizationId);
    for (const r of m.funding?.reauthorizations || []) ids.push(r.authorizationId);
    for (const c of m.captures) ids.push(c.id);
    for (const p of m.payouts) ids.push(p.batchId);
    for (const b of m.payoutBatches || []) ids.push(b.batchId);
  }
  return [...new Set(ids)];
}
function isActive(d: DealDoc): boolean {
  return d.milestones.some((m) => !TERMINAL.includes(m.state));
}

class ServiceError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type DealService = ReturnType<typeof makeDealService>;
export type ClockChangeOut = { changeOrderRequired: boolean; changeOrder: unknown; invoice: ExecOutcome | null; reason?: string };

function makeDealService(opts: {
  gateway: PaymentGateway;
  now?: () => string;
  publicBaseUrl?: string;
  trace?: EngineDeps['trace'];
  payoutsMode?: EngineDeps['payoutsMode'];
}) {
  const now = opts.now || (() => new Date().toISOString());
  const base = (opts.publicBaseUrl || 'http://localhost:5173').replace(/\/$/, '');
  const deps: EngineDeps = {
    gateway: opts.gateway,
    ledger: mongoLedger,
    now,
    trace: opts.trace,
    payoutsMode: opts.payoutsMode === 'real' ? 'real' : 'simulated',
    returnUrl: (deal, key) => ({
      returnUrl: `${base}/deals/${encodeURIComponent(deal.id)}/fund/${encodeURIComponent(key)}?paypal=approved`,
      cancelUrl: `${base}/deals/${encodeURIComponent(deal.id)}/fund/${encodeURIComponent(key)}?paypal=cancelled`,
    }),
  };

  async function load(dealId: string, orgId?: string): Promise<DealDoc> {
    const row = await Deal.findById(dealId).lean();
    if (!row || (orgId && row.orgId !== String(orgId))) throw new ServiceError('deal_not_found', 'deal not found', 404);
    return row.doc as DealDoc;
  }

  async function save(deal: DealDoc, token: string | null, created = false) {
    const fields = {
      orgId: deal.orgId,
      clientUserId: deal.terms.client.userId,
      workerUserId: deal.terms.worker.userId,
      title: deal.terms.title,
      paypalIds: paypalIdsOf(deal),
      active: isActive(deal),
      doc: deal,
    };
    if (created) {
      await Deal.create({ _id: deal.id, ...fields });
      return;
    }
    const r = await Deal.updateOne({ _id: deal.id, lockToken: token }, { $set: fields, $inc: { rev: 1 } });
    if (!r.matchedCount) throw new ServiceError('deal_lock_lost', 'the deal changed while this step ran; nothing was saved', 409);
  }

  /** Run fn under the deal's lock and save what it returns. */
  async function withDeal<T>(dealId: string, orgId: string | undefined, fn: (d: DealDoc) => Promise<{ deal: DealDoc; out: T }>): Promise<{ deal: DealDoc; out: T }> {
    const token = crypto.randomUUID();
    const t = Date.now();
    const got = await Deal.findOneAndUpdate(
      { _id: dealId, ...(orgId ? { orgId: String(orgId) } : {}), $or: [{ lockUntil: { $exists: false } }, { lockUntil: { $lt: t } }] },
      { $set: { lockUntil: t + LOCK_MS, lockToken: token } },
      { new: true },
    ).lean();
    if (!got) {
      await load(dealId, orgId); // 404 if missing
      throw new ServiceError('deal_busy', 'another step is running on this deal; try again in a moment', 409);
    }
    try {
      const r = await fn(got.doc as DealDoc);
      await save(r.deal, token);
      return r;
    } finally {
      await Deal.updateOne({ _id: dealId, lockToken: token }, { $unset: { lockUntil: 1, lockToken: 1 } });
    }
  }
  const sync = (dealId: string, orgId: string, fn: (d: DealDoc) => DealDoc) =>
    withDeal(dealId, orgId, async (d) => ({ deal: fn(d), out: null })).then((r) => r.deal);

  return {
    deps,
    ledger: mongoLedger,

    /** opts.id is for the fixed demo deal only (deals/demo); routes never pass it. */
    async create(orgId: string, byUserId: string, terms: DealTerms, opts: { id?: string } = {}): Promise<DealDoc> {
      if (terms?.client?.userId !== byUserId && terms?.worker?.userId !== byUserId)
        throw new ServiceError('not_party', 'you can only draft a deal you are a party to', 403);
      const deal = engine.createDeal({ id: opts.id || `deal_${crypto.randomBytes(9).toString('base64url')}`, orgId: String(orgId), terms });
      await save(deal, null, true);
      return deal;
    },
    get: load,
    async list(orgId: string, userId: string, all = false) {
      const q: Record<string, unknown> = { orgId: String(orgId) };
      if (!all) q.$or = [{ clientUserId: userId }, { workerUserId: userId }];
      return (await Deal.find(q).sort({ updatedAt: -1 }).limit(200).lean()).map((r: any) => r.doc as DealDoc);
    },
    editTerms: (dealId: string, orgId: string, userId: string, terms: DealTerms) =>
      sync(dealId, orgId, (d) => {
        if (!engine.actorRole(d, userId)) throw new ServiceError('not_party', 'only a party can edit the draft', 403);
        if (terms?.client?.userId !== d.terms.client.userId || terms?.worker?.userId !== d.terms.worker.userId)
          throw new ServiceError('parties_fixed', 'the parties of a deal cannot change; draft a new deal', 422);
        return engine.editTerms(d, terms);
      }),
    sign: (dealId: string, orgId: string, userId: string, termsHash: string) =>
      sync(dealId, orgId, (d) => {
        const role = engine.actorRole(d, userId);
        if (!role) throw new ServiceError('not_party', 'only a party can sign', 403);
        // the signer names the exact text they read; a stale screen cannot sign newer terms
        if (termsHash !== hashOf(d.terms)) throw new ServiceError('terms_changed', 'the terms changed since you opened them; review and sign again', 409);
        return engine.sign(d, role, userId, now());
      }),
    startFunding: (dealId: string, orgId: string, userId: string, key: string) =>
      withDeal(dealId, orgId, async (d) => ({ deal: await engine.startFunding(deps, d, key, userId), out: null })).then((r) => r.deal),
    confirmFunding: (dealId: string, orgId: string | undefined, userId: string | undefined, key: string) =>
      withDeal(dealId, orgId, async (d) => {
        const r = await engine.confirmFunding(deps, d, key, userId);
        return { deal: r.deal, out: r.result as ExecOutcome };
      }),
    submitStyleSample: (dealId: string, orgId: string, userId: string, key: string, v: { id: string; sha256: string }) =>
      sync(dealId, orgId, (d) => engine.submitStyleSample(d, key, userId, v, now())),
    decideStyle: (dealId: string, orgId: string, userId: string, key: string, ok: boolean) =>
      sync(dealId, orgId, (d) => engine.decideStyle(d, key, userId, ok, now())),
    submitVersion: (dealId: string, orgId: string, userId: string, key: string, v: { id: string; sha256: string }) =>
      sync(dealId, orgId, (d) => engine.submitVersion(d, key, userId, v, now())),
    /** Called by the checks pipeline (system), never by a party. */
    recordChecks: (dealId: string, key: string, versionId: string, report: { reportId: string; passed: boolean; failed: string[] }) =>
      withDeal(dealId, undefined, async (d) => ({ deal: engine.recordChecks(d, key, versionId, report, now()), out: null })).then((r) => r.deal),
    /** A Video QA report (internal API). orgId comes from the service token; pass/fail is recomputed from the results. */
    recordCheckReport: (dealId: string, orgId: string, key: string, body: any) =>
      withDeal(dealId, orgId, async (d) => {
        const r = proposals.checkReport(d, key, body);
        const reportId = `chk_${crypto.randomBytes(6).toString('base64url')}`;
        const deal = engine.recordChecks(d, key, body.versionId, { reportId, passed: r.passed, failed: r.failed, results: r.results, unmeasured: r.unmeasured, notes: r.notes }, now());
        return { deal, out: { reportId, passed: r.passed, failed: r.failed, unmeasured: r.unmeasured } };
      }),
    /** Draft a change order priced from the signed rate card (by the Scope Agent or a party). */
    draftChangeOrder: (dealId: string, orgId: string, input: any) =>
      withDeal(dealId, orgId, async (d) => {
        const id = `co_${crypto.randomBytes(6).toString('base64url')}`;
        const r = proposals.draftChangeOrder(d, input, id, now());
        return { deal: r.deal, out: { changeOrder: r.changeOrder, decision: r.decision } };
      }),
    /** Store a Review Agent or Scope & Dispute Agent proposal on the milestone, after its policy dry-run. */
    storeProposal: (dealId: string, orgId: string, key: string, kind: 'review' | 'dispute', body: any) =>
      withDeal(dealId, orgId, async (d) => {
        const id = `${kind === 'review' ? 'rvw' : 'dsp'}_${crypto.randomBytes(6).toString('base64url')}`;
        const r = kind === 'review' ? proposals.storeReview(d, key, body, id, now()) : proposals.storeDispute(d, key, body, id, now());
        return { deal: r.deal, out: r.proposal };
      }),
    /** The client's one tap. Accepting also drafts the PayPal invoice through policy. */
    decideChangeOrder: (dealId: string, orgId: string, userId: string, coId: string, accept: boolean) =>
      withDeal(dealId, orgId, async (d) => {
        const decided = proposals.decideChangeOrder(d, coId, userId, accept, now());
        if (!accept) return { deal: decided, out: null as ExecOutcome | null };
        const r = await engine.invoiceChangeOrder(deps, decided, coId);
        // a failed invoice call leaves the change order accepted (the round is still unlocked); it can be re-invoiced
        return { deal: r.result.outcome === 'failed' ? decided : r.deal, out: r.result as ExecOutcome | null };
      }),
    /** What policy (or the engine) would say about a proposal right now. Read-only. */
    async dryRun(dealId: string, orgId: string, input: any) {
      return proposals.dryRun(await load(dealId, orgId), input, now());
    },
    requestChanges: (dealId: string, orgId: string, userId: string, key: string, items: ChangeItem[], changeOrderId?: string) =>
      sync(dealId, orgId, (d) => engine.requestChanges(d, key, userId, items, now(), { changeOrderId })),
    approve: (dealId: string, orgId: string, userId: string, key: string, versionId: string, release: boolean) =>
      sync(dealId, orgId, (d) => engine.approve(d, key, userId, versionId, now(), release)),
    kill: (dealId: string, orgId: string, userId: string, key: string) => sync(dealId, orgId, (d) => engine.kill(d, key, userId, now())),
    openDispute: (dealId: string, orgId: string, userId: string, key: string) => sync(dealId, orgId, (d) => engine.openDispute(d, key, userId, now())),
    acceptSplit: (dealId: string, orgId: string, userId: string, key: string, workerMinor: number) =>
      sync(dealId, orgId, (d) => engine.acceptSplit(d, key, userId, workerMinor)),
    approveHuman: (dealId: string, orgId: string, userId: string, approvalKey: string) =>
      sync(dealId, orgId, (d) => engine.approveHuman(d, approvalKey, userId)),
    voidMissedDeadline: (dealId: string, orgId: string, userId: string, key: string) =>
      withDeal(dealId, orgId, async (d) => {
        const r = await engine.voidMissedDeadline(deps, d, key, userId);
        return { deal: r.deal, out: r.result as ExecOutcome };
      }),
    /** One Money Agent pass over one deal. */
    tick: (dealId: string, orgId?: string) =>
      withDeal(dealId, orgId, async (d) => {
        const r = await engine.tick(deps, d);
        return { deal: r.deal, out: r.results as ExecOutcome[] };
      }),
    /** Money Agent pass over every deal that may still need a move. Busy deals are skipped this round. */
    async tickAll(limit = 100) {
      // the Fair Review Clock moves first (reminders, releases, hold upkeep), then the usual plan
      try {
        await this.advanceClocks(now());
      } catch {
        /* a clock failure never stops the Money Agent; the next tick retries */
      }
      const rows = await Deal.find({ active: true }).select({ _id: 1 }).sort({ updatedAt: 1 }).limit(limit).lean();
      const out: { dealId: string; moves: number; error?: string }[] = [];
      for (const r of rows) {
        try {
          const t = await this.tick(r._id);
          out.push({ dealId: r._id, moves: t.out.filter((x) => x.outcome === 'done').length });
        } catch (e) {
          out.push({ dealId: r._id, moves: 0, error: (e as { code?: string }).code || 'error' });
        }
      }
      return out;
    },
    /* ---------------------------------------------------- Fair Review Clock */

    /**
     * Run one clock step, exactly once. The step id is claimed atomically in
     * clock.doneSteps (findOneAndUpdate with doneSteps: {$ne: stepId}) under the
     * deal lock, so a second run is a no-op even if the first one is retried.
     * A money step that could not act (refused, waiting for a tap) is un-claimed
     * so a later advance can retry it.
     */
    async runClockStep(dealId: string, key: string, stepId: string, opts: { silent?: boolean } = {}) {
      if (!reviewClock.STEP_IDS.includes(stepId)) throw new ServiceError('unknown_step', `unknown clock step ${stepId}`, 422);
      const r = await withDeal(dealId, undefined, async (d) => {
        const m = d.milestones.find((x) => x.key === key);
        if (!m) throw new ServiceError('milestone_not_found', `no milestone ${key}`, 404);
        if (!m.clock) throw new ServiceError('clock_not_started', 'the review clock has not started on this milestone', 409);
        const nothing = { ran: false, stepId, ok: true, results: [] as ExecOutcome[], notices: [] as any[] };
        if (m.clock.doneSteps.includes(stepId)) return { deal: d, out: nothing };
        const claimed = await Deal.findOneAndUpdate(
          { _id: dealId, 'doc.milestones': { $elemMatch: { key, 'clock.doneSteps': { $ne: stepId } } } },
          { $push: { 'doc.milestones.$.clock.doneSteps': stepId } },
          { new: true, projection: { _id: 1 } },
        ).lean();
        const mark = (deal: DealDoc, on: boolean): DealDoc => ({
          ...deal,
          milestones: deal.milestones.map((x) =>
            x.key === key && x.clock
              ? { ...x, clock: { ...x.clock, doneSteps: on ? [...new Set([...x.clock.doneSteps, stepId])] : x.clock.doneSteps.filter((s) => s !== stepId) } }
              : x,
          ),
        });
        if (!claimed) return { deal: mark(d, true), out: nothing };
        let o;
        try {
          o = await engine.applyClockStep(deps, mark(d, true), key, stepId, opts);
        } catch (e) {
          await Deal.updateOne({ _id: dealId, 'doc.milestones.key': key }, { $pull: { 'doc.milestones.$.clock.doneSteps': stepId } });
          throw e;
        }
        // saving the doc without the id un-claims it (the claim lives in the same document)
        return { deal: o.ok ? o.deal : mark(o.deal, false), out: { ran: o.ok, stepId, ok: o.ok, skipped: !!o.skipped, note: o.note, results: o.results as ExecOutcome[], notices: o.notices } };
      });
      const sent = await sendNotices(r.out.notices);
      const { notices, ...out } = r.out;
      return { deal: r.deal, out: { ...out, notified: sent, notices: notices.length } };
    },

    /** Hold upkeep for one clock milestone (reauthorize after day 3; warn once when the hold would lapse). */
    async clockUpkeep(dealId: string, key: string) {
      const r = await withDeal(dealId, undefined, async (d) => {
        const o = await engine.clockHoldUpkeep(deps, d, key);
        return { deal: o.deal, out: { results: o.results as ExecOutcome[], notices: o.notices } };
      });
      await sendNotices(r.out.notices);
      return { deal: r.deal, out: r.out.results };
    },

    /**
     * The clock driver: every running (or paused) clock gets hold upkeep, and
     * every running clock runs the steps due at `nowIso`. Called from the Money
     * Agent tick and from POST /api/v1/internal/clock/advance.
     */
    async advanceClocks(nowIso: string = now(), limit = 200) {
      const rows = await Deal.find({ active: true, 'doc.milestones.clock.status': { $in: ['running', 'paused'] } })
        .select({ _id: 1 })
        .sort({ updatedAt: 1 })
        .limit(limit)
        .lean();
      const out: { dealId: string; milestoneKey: string; steps: string[]; reauthorized: number; error?: string }[] = [];
      for (const row of rows) {
        let deal: DealDoc;
        try {
          deal = await load(row._id);
        } catch {
          continue;
        }
        for (const m0 of deal.milestones) {
          if (!m0.clock || (m0.clock.status !== 'running' && m0.clock.status !== 'paused')) continue;
          const rec = { dealId: deal.id, milestoneKey: m0.key, steps: [] as string[], reauthorized: 0 } as (typeof out)[number];
          try {
            const up = await this.clockUpkeep(deal.id, m0.key);
            rec.reauthorized = up.out.filter((x: ExecOutcome) => x.outcome === 'done').length;
            deal = up.deal;
            const m = deal.milestones.find((x) => x.key === m0.key)!;
            const due = reviewClock.dueFor(m.clock, nowIso) as string[];
            const releaseDue = due.some((s) => s.startsWith('release_'));
            for (const stepId of due) {
              const k = `clock:${deal.id}:${m0.key}:${stepId}`;
              const at = deal.lastBlocked?.[k];
              if (at && Date.parse(nowIso) - Date.parse(at) < RETRY_BLOCKED_MS) break; // refused recently; retry later
              // reminders that fall due together with a release are recorded but not sent
              const r = await this.runClockStep(deal.id, m0.key, stepId, { silent: releaseDue && !stepId.startsWith('release_') });
              deal = r.deal;
              if (r.out.ran) rec.steps.push(stepId);
              if (!r.out.ok) break; // a release that could not act holds the later steps back
            }
          } catch (e) {
            rec.error = (e as { code?: string }).code || 'error';
          }
          out.push(rec);
        }
      }
      return out;
    },

    /** The brand approves on a clock milestone: approval of the latest version, the full amount releases now. */
    clockApprove: (dealId: string, orgId: string, userId: string, key: string) =>
      withDeal(dealId, orgId, async (d) => {
        const m = d.milestones.find((x) => x.key === key);
        if (!m) throw new ServiceError('milestone_not_found', `no milestone ${key}`, 404);
        const latest = m.versions[m.versions.length - 1];
        if (!latest) throw new ServiceError('nothing_delivered', 'nothing has been delivered yet', 409);
        // the approve tap is the human tap for the capture (release = true), so the full amount moves now
        const approved = engine.approve(d, key, userId, latest.id, now(), true);
        const r = await engine.tick(deps, approved);
        return { deal: r.deal, out: r.results as ExecOutcome[] };
      }),

    /**
     * The brand asks for changes on a clock milestone. The citation (a brief item
     * id or a failed check id) is required. Within the included rounds this pauses
     * the clock and counts a round; past them it drafts, accepts (the brand's own
     * ask) and invoices a change order through the existing path instead.
     */
    clockRequestChanges: (dealId: string, orgId: string, userId: string, key: string, input: { citation?: unknown; text?: unknown; changeOrderId?: unknown }) =>
      withDeal<ClockChangeOut>(dealId, orgId, async (d) => {
        const citation = typeof input.citation === 'string' ? input.citation.trim() : '';
        if (!citation || citation.length > 100)
          throw new ServiceError('citation_required', 'a change request needs a citation: a brief item id or a failed check id', 422);
        const t = d.terms.milestones.find((x) => x.key === key);
        const m = d.milestones.find((x) => x.key === key);
        if (!t || !m) throw new ServiceError('milestone_not_found', `no milestone ${key}`, 404);
        const ct = reviewClock.clockTermsOf(d.terms, t);
        if (!ct) throw new ServiceError('no_clock', 'this milestone has no review clock; use the plain change request', 409);
        if (engine.actorRole(d, userId) !== 'client') throw new ServiceError('forbidden', 'only the client can do this', 403);
        const latest = m.versions[m.versions.length - 1];
        const failed = new Set([...(latest?.checks?.failed || []), ...(latest?.checks?.unmeasured || [])]);
        const line = t.checklist.find((c) => c.id === citation);
        if (!line && !failed.has(citation))
          throw new ServiceError('citation_unknown', `"${citation}" is not a brief item or a failed check on this milestone`, 422);
        const text = typeof input.text === 'string' && input.text.trim() ? input.text.trim().slice(0, 2000) : `Change requested (cites ${citation})`;
        const changeOrderId = typeof input.changeOrderId === 'string' ? input.changeOrderId : undefined;
        const used = m.clock?.revisionsUsed || 0;
        if (used + 1 > ct.includedRevisionRounds && !changeOrderId) {
          const item =
            d.terms.rateCard.find((r) => r.id === 'revision_round') || d.terms.rateCard.find((r) => /revision/i.test(`${r.id} ${r.label}`));
          if (!item)
            return {
              deal: d,
              out: { changeOrderRequired: true, changeOrder: null, invoice: null, reason: 'the signed rate card has no revision-round item to price a change order from' },
            };
          const id = `co_${crypto.randomBytes(6).toString('base64url')}`;
          const drafted = proposals.draftChangeOrder(
            d,
            { milestoneKey: key, rateCardItemId: item.id, quantity: 1, ask: `Extra revision round: ${text}`, by: 'client' },
            id,
            now(),
          );
          const accepted = proposals.decideChangeOrder(drafted.deal, id, userId, true, now());
          const inv = await engine.invoiceChangeOrder(deps, accepted, id);
          const deal = inv.result.outcome === 'failed' ? accepted : inv.deal;
          return {
            deal,
            out: { changeOrderRequired: true, changeOrder: deal.changeOrders.find((c: { id: string }) => c.id === id), invoice: inv.result as ExecOutcome },
          };
        }
        const tag: 'fix' | 'taste' = failed.has(citation) || line?.kind === 'check' ? 'fix' : 'taste';
        const deal = engine.requestChanges(d, key, userId, [{ text, tag, checklistId: citation }], now(), { changeOrderId });
        return { deal, out: { changeOrderRequired: false, changeOrder: null, invoice: null } };
      }),

    /** Either party disputes: the existing dispute flow freezes what is still held and the clock stops. */
    clockDispute: (dealId: string, orgId: string, userId: string, key: string) =>
      sync(dealId, orgId, (d) => engine.openDispute(d, key, userId, now())),

    /** What GET .../clock returns. */
    async clockView(dealId: string, orgId: string, key: string) {
      const d = await load(dealId, orgId);
      if (!d.milestones.some((x) => x.key === key)) throw new ServiceError('milestone_not_found', `no milestone ${key}`, 404);
      const v = reviewClock.viewOf(d, key, now());
      if (!v) throw new ServiceError('no_clock', 'this milestone has no review clock', 404);
      return v;
    },

    async ledgerOf(dealId: string, orgId: string) {
      await load(dealId, orgId);
      const entries = await mongoLedger.list(dealId);
      return { entries, chain: verifyChain(entries), totals: totals(entries) };
    },
    findByPaypalId: async (id: string): Promise<DealDoc | null> => {
      const row = await Deal.findOne({ paypalIds: id }).lean();
      return row ? (row.doc as DealDoc) : null;
    },
    webhookSeen: async (eventId: string) => !!(await PaypalWebhook.exists({ _id: eventId })),
    webhookRecord: (e: { id: string; eventType: string; resourceId?: string; dealId?: string; outcome: string }) =>
      PaypalWebhook.create({ _id: e.id, eventType: e.eventType, resourceId: e.resourceId, dealId: e.dealId, outcome: e.outcome }).catch((err: { code?: number }) => {
        if (err.code !== 11000) throw err;
      }),
    withDeal,
  };
}

module.exports = { makeDealService, ServiceError, mongoLedger };
