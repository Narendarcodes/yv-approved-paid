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

function makeDealService(opts: {
  gateway: PaymentGateway;
  now?: () => string;
  publicBaseUrl?: string;
  trace?: EngineDeps['trace'];
}) {
  const now = opts.now || (() => new Date().toISOString());
  const base = (opts.publicBaseUrl || 'http://localhost:5173').replace(/\/$/, '');
  const deps: EngineDeps = {
    gateway: opts.gateway,
    ledger: mongoLedger,
    now,
    trace: opts.trace,
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
