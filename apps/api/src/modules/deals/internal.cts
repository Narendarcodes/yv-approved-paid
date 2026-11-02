/**
 * deals/internal: the private routes the Python agents call (mounted on the
 * internal listener at /internal/deals, behind X-Internal-Token + a service JWT).
 *
 * The org always comes from the service token, never from the request, so an
 * agent holding a token for one org cannot read or touch another org's deal
 * (it gets 404, the same as a deal that does not exist).
 *
 *   GET  /:dealId                          terms + runtime the agents need
 *   POST /:dealId/milestones/:key/checks   Video QA report (deals:checks)
 *   POST /:dealId/policy-check             dry-run a proposal through policy (deals:propose)
 *   POST /:dealId/change-orders            Scope Agent drafts a priced change order (deals:propose)
 */
const express = require('express');
const { requireService } = require('../../middleware/serviceAuth');
const { dealService } = require('./service.cts');

type Req = any;
type Res = any;
type Next = (e?: unknown) => void;
const wrap = (fn: (req: Req, res: Res) => Promise<unknown>) => (req: Req, res: Res, next: Next) => fn(req, res).catch(next);
const org = (req: Req) => String(req.svc.orgId);

const router = express.Router();
router.use((req: Req, res: Res, next: Next) =>
  require('../../config').agent.enabled ? next() : res.status(503).json({ error: { code: 'agent_disabled', message: 'Agent platform disabled' } }),
);

router.get(
  '/:dealId',
  requireService('deals:read'),
  wrap(async (req, res) => {
    const d = await dealService().get(req.params.dealId, org(req));
    // no payee emails or PayPal ids leave Node for the agents
    const milestones = d.terms.milestones.map(({ payees, ...m }: any) => m);
    const runtime = d.milestones.map((m: any) => ({
      key: m.key, state: m.state, versions: m.versions, revisionRoundsUsed: m.revisionRoundsUsed, tasteRoundsUsed: m.tasteRoundsUsed,
      capturedMinor: m.capturedMinor, changeRequests: m.changeRequests, history: m.history, split: m.split,
    }));
    res.json({ data: { id: d.id, termsHash: d.termsHash, terms: { title: d.terms.title, currency: d.terms.currency, rateCard: d.terms.rateCard, killFeeBp: d.terms.killFeeBp, milestones }, milestones: runtime, changeOrders: d.changeOrders } });
  }),
);

router.post(
  '/:dealId/milestones/:key/checks',
  requireService('deals:checks'),
  wrap(async (req, res) => {
    const r = await dealService().recordCheckReport(req.params.dealId, org(req), req.params.key, req.body);
    res.status(201).json({ data: r.out });
  }),
);

router.post(
  '/:dealId/policy-check',
  requireService('deals:propose'),
  wrap(async (req, res) => {
    res.json({ data: await dealService().dryRun(req.params.dealId, org(req), req.body) });
  }),
);

router.post(
  '/:dealId/change-orders',
  requireService('deals:propose'),
  wrap(async (req, res) => {
    const b = req.body || {};
    const r = await dealService().draftChangeOrder(req.params.dealId, org(req), {
      milestoneKey: b.milestoneKey, rateCardItemId: b.rateCardItemId, quantity: b.quantity, amountMinor: b.amountMinor, ask: b.ask, by: 'agent',
    });
    res.status(201).json({ data: r.out });
  }),
);

module.exports = { router };
