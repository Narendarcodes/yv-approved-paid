/**
 * deals/http: Express routers.
 *
 *   router         mounted at /api/v1/organizations/:organizationId/deals
 *   webhookRouter  mounted at /api/v1/webhooks (POST /paypal)
 *
 * Who may do what is decided in two places: org membership here (access
 * module), and party role (client / worker) inside the engine. Nobody can move
 * money through these routes directly: humans record events (approve, kill,
 * accept a split, one-tap release) and the Money Agent turns them into PayPal
 * calls through the policy engine.
 */
const express = require('express');
const access = require('../access/index.cts');
const { authenticate } = require('../../middleware/auth');
const { dealService, gateway, handlePaypalEvent, ServiceError } = require('./service.cts');
const { hashOf } = require('./lib/canonical.cts');
const { validateTerms } = require('./lib/validate.cts');
const { actorRole } = require('./lib/engine.cts');
const { verifyChain } = require('./lib/ledger.cts');
const { resolveEvidence } = require('./lib/evidence.cts');

import type { DealDoc, DealTerms } from './lib/types.cts';

type Req = any;
type Res = any;
type Next = (e?: unknown) => void;

const wrap = (fn: (req: Req, res: Res) => Promise<unknown>) => (req: Req, res: Res, next: Next) => fn(req, res).catch(next);
const uid = (req: Req) => String(req.user._id);
const org = (req: Req) => String(req.ctx.orgId);

function canManage(req: Req) {
  return access.allows(req.ctx.permissions || [], 'deal.manage');
}

/** The deal as one party sees it: plus their role, the live terms hash (what they sign) and open problems. */
function view(deal: DealDoc, userId: string) {
  return {
    ...deal,
    me: actorRole(deal, userId),
    termsHashNow: hashOf(deal.terms),
    problems: deal.termsHash ? [] : validateTerms(deal.terms),
  };
}

function bad(code: string, message: string, status = 422) {
  return new ServiceError(code, message, status);
}
function str(v: unknown, name: string, max = 200): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw bad('invalid_input', `${name} is required`);
  return v.trim();
}
function shape(terms: DealTerms) {
  if (!terms || typeof terms !== 'object' || !terms.client || !terms.worker || !Array.isArray(terms.milestones))
    throw bad('invalid_terms', 'terms need client, worker and milestones');
  if (JSON.stringify(terms).length > 100_000) throw bad('invalid_terms', 'terms are too large');
}

async function readable(req: Req, dealId: string): Promise<DealDoc> {
  const d = await dealService().get(dealId, org(req));
  if (!actorRole(d, uid(req)) && !canManage(req)) throw bad('deal_not_found', 'deal not found', 404);
  return d;
}

const router = express.Router({ mergeParams: true });
router.use(authenticate, access.can(null, { from: 'org' }));

router.get(
  '/',
  wrap(async (req, res) => {
    const deals = await dealService().list(org(req), uid(req), canManage(req) && req.query.all === '1');
    res.json({ data: deals.map((d: DealDoc) => view(d, uid(req))) });
  }),
);

router.post(
  '/',
  wrap(async (req, res) => {
    const terms = req.body?.terms as DealTerms;
    shape(terms);
    for (const side of ['client', 'worker'] as const) {
      if (!(await access.memberOf(terms[side].userId, org(req)))) throw bad('party_not_member', `the ${side} must be a member of this organization`);
    }
    const d = await dealService().create(org(req), uid(req), terms);
    res.status(201).json({ data: view(d, uid(req)) });
  }),
);

router.get(
  '/:dealId',
  wrap(async (req, res) => {
    res.json({ data: view(await readable(req, req.params.dealId), uid(req)) });
  }),
);

router.put(
  '/:dealId/terms',
  wrap(async (req, res) => {
    shape(req.body?.terms);
    res.json({ data: view(await dealService().editTerms(req.params.dealId, org(req), uid(req), req.body.terms), uid(req)) });
  }),
);

router.post(
  '/:dealId/sign',
  wrap(async (req, res) => {
    const h = str(req.body?.termsHash, 'termsHash', 64);
    res.json({ data: view(await dealService().sign(req.params.dealId, org(req), uid(req), h), uid(req)) });
  }),
);

router.get(
  '/:dealId/ledger',
  wrap(async (req, res) => {
    await readable(req, req.params.dealId);
    const l = await dealService().ledgerOf(req.params.dealId, org(req));
    res.json({ data: { ...l, chain: verifyChain(l.entries) } });
  }),
);

/**
 * A check-evidence screenshot (LiveChecksCard thumbnails). Signed-in parties
 * (or deal managers) of this org only, and only a file name that this deal's
 * stored check results reference; anything else is a plain 404.
 */
router.get(
  '/:dealId/evidence/:file',
  wrap(async (req, res) => {
    const d = await readable(req, req.params.dealId);
    const file = resolveEvidence(d, req.params.file);
    if (!file) return res.status(404).json({ error: { code: 'evidence_not_found', message: 'evidence not found' } });
    res.set({ 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
    await new Promise<void>((ok, fail) => res.sendFile(file, { dotfiles: 'deny' }, (err: unknown) => (err ? fail(err) : ok())));
  }),
);

/** The Money Agent, nudged by a party (it also runs on its own every minute). */
router.post(
  '/:dealId/tick',
  wrap(async (req, res) => {
    await readable(req, req.params.dealId);
    const r = await dealService().tick(req.params.dealId, org(req));
    res.json({ data: { deal: view(r.deal, uid(req)), results: r.out } });
  }),
);

router.post(
  '/:dealId/approvals/:approvalKey',
  wrap(async (req, res) => {
    const d = await dealService().approveHuman(req.params.dealId, org(req), uid(req), req.params.approvalKey);
    const r = await dealService().tick(req.params.dealId, org(req));
    res.json({ data: { deal: view(r.deal, uid(req)), results: r.out, approvedBefore: d.humanApprovals.length } });
  }),
);

const M = '/:dealId/milestones/:key';
const svcCall = (fn: (req: Req) => Promise<DealDoc>) =>
  wrap(async (req, res) => {
    res.json({ data: view(await fn(req), uid(req)) });
  });
const version = (req: Req) => ({ id: str(req.body?.versionId, 'versionId', 100), sha256: str(req.body?.sha256, 'sha256', 64) });

router.post(`${M}/fund`, svcCall((req) => dealService().startFunding(req.params.dealId, org(req), uid(req), req.params.key)));
router.post(
  `${M}/fund/confirm`,
  wrap(async (req, res) => {
    const r = await dealService().confirmFunding(req.params.dealId, org(req), uid(req), req.params.key);
    res.status(r.out.outcome === 'done' ? 200 : 409).json({ data: { deal: view(r.deal, uid(req)), result: r.out } });
  }),
);
router.post(`${M}/style-sample`, svcCall((req) => dealService().submitStyleSample(req.params.dealId, org(req), uid(req), req.params.key, version(req))));
router.post(`${M}/style`, svcCall((req) => dealService().decideStyle(req.params.dealId, org(req), uid(req), req.params.key, req.body?.ok === true)));
router.post(`${M}/versions`, svcCall((req) => dealService().submitVersion(req.params.dealId, org(req), uid(req), req.params.key, version(req))));
router.post(
  `${M}/changes`,
  svcCall((req) => {
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length > 50) throw bad('invalid_input', 'items must be a list');
    const clean = items.map((i: any) => ({
      text: str(i?.text, 'item text', 2000),
      tag: i?.tag === 'fix' ? 'fix' : 'taste',
      checklistId: typeof i?.checklistId === 'string' ? i.checklistId : undefined,
      disputed: i?.disputed === true,
    }));
    return dealService().requestChanges(req.params.dealId, org(req), uid(req), req.params.key, clean, typeof req.body?.changeOrderId === 'string' ? req.body.changeOrderId : undefined);
  }),
);
router.post(
  `${M}/approve`,
  svcCall((req) => dealService().approve(req.params.dealId, org(req), uid(req), req.params.key, str(req.body?.versionId, 'versionId', 100), req.body?.release === true)),
);
router.post(`${M}/kill`, svcCall((req) => dealService().kill(req.params.dealId, org(req), uid(req), req.params.key)));
router.post(`${M}/dispute`, svcCall((req) => dealService().openDispute(req.params.dealId, org(req), uid(req), req.params.key)));
router.post(
  `${M}/split`,
  svcCall((req) => {
    const n = req.body?.workerMinor;
    if (!Number.isSafeInteger(n)) throw bad('invalid_input', 'workerMinor must be a whole number of minor units');
    return dealService().acceptSplit(req.params.dealId, org(req), uid(req), req.params.key, n);
  }),
);
router.post(
  `${M}/void-missed-deadline`,
  wrap(async (req, res) => {
    const r = await dealService().voidMissedDeadline(req.params.dealId, org(req), uid(req), req.params.key);
    res.status(r.out.outcome === 'done' ? 200 : 409).json({ data: { deal: view(r.deal, uid(req)), result: r.out } });
  }),
);

/* ------------------------------------------------- change orders + dry run */

/** A party drafts a change order; the price comes from the signed rate card, never from the request. */
router.post(
  '/:dealId/change-orders',
  wrap(async (req, res) => {
    const d = await readable(req, req.params.dealId);
    const role = actorRole(d, uid(req));
    if (!role) throw bad('not_party', 'only a party can draft a change order', 403);
    const b = req.body || {};
    const r = await dealService().draftChangeOrder(req.params.dealId, org(req), {
      milestoneKey: b.milestoneKey, rateCardItemId: b.rateCardItemId, quantity: b.quantity, amountMinor: b.amountMinor, ask: b.ask, by: role,
    });
    res.status(201).json({ data: { deal: view(r.deal, uid(req)), changeOrder: r.out.changeOrder } });
  }),
);
for (const verb of ['accept', 'decline'] as const) {
  router.post(
    `/:dealId/change-orders/:coId/${verb}`,
    wrap(async (req, res) => {
      await readable(req, req.params.dealId);
      const r = await dealService().decideChangeOrder(req.params.dealId, org(req), uid(req), req.params.coId, verb === 'accept');
      res.json({ data: { deal: view(r.deal, uid(req)), result: r.out } });
    }),
  );
}
/** Dry-run a proposal through policy (what the UI shows next to an agent's suggestion). Read-only. */
router.post(
  '/:dealId/policy-check',
  wrap(async (req, res) => {
    await readable(req, req.params.dealId);
    res.json({ data: await dealService().dryRun(req.params.dealId, org(req), req.body) });
  }),
);

/* ---------------------------------------------------------------- webhooks */

const webhookRouter = express.Router();
webhookRouter.post(
  '/paypal',
  wrap(async (req, res) => {
    const gw = gateway();
    if (gw.name !== 'mock' && !process.env.PAYPAL_WEBHOOK_ID) {
      return res.status(503).json({ error: { code: 'webhook_not_configured', message: 'PAYPAL_WEBHOOK_ID is not set' } });
    }
    const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
    if (!raw || !(await gw.verifyWebhook(req.headers, raw))) {
      return res.status(401).json({ error: { code: 'bad_signature', message: 'webhook signature did not verify' } });
    }
    const r = await handlePaypalEvent(dealService(), JSON.parse(raw));
    res.json({ data: r });
  }),
);

module.exports = { router, webhookRouter };
