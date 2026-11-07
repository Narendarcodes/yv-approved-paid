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
const path = require('node:path');
const { resolveEvidence } = require('./lib/evidence.cts');
const { askCopilot } = require('./copilot.cts');
const { planTeam, applyTeam, statusOf } = require('./team.cts');
const config = require('../../config');
const rateLimit = require('express-rate-limit');

import type { DealDoc, DealTerms } from './lib/types.cts';

type Req = any;
type Res = any;
type Next = (e?: unknown) => void;

const wrap = (fn: (req: Req, res: Res) => Promise<unknown>) => (req: Req, res: Res, next: Next) =>
  fn(req, res).catch(next);
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
  if (typeof v !== 'string' || !v.trim() || v.length > max)
    throw bad('invalid_input', `${name} is required`);
  return v.trim();
}
function shape(terms: DealTerms) {
  if (
    !terms ||
    typeof terms !== 'object' ||
    !terms.client ||
    !terms.worker ||
    !Array.isArray(terms.milestones)
  )
    throw bad('invalid_terms', 'terms need client, worker and milestones');
  if (JSON.stringify(terms).length > 100_000) throw bad('invalid_terms', 'terms are too large');
}

async function readable(req: Req, dealId: string): Promise<DealDoc> {
  const d = await dealService().get(dealId, org(req));
  if (!actorRole(d, uid(req)) && !canManage(req))
    throw bad('deal_not_found', 'deal not found', 404);
  return d;
}

const router = express.Router({ mergeParams: true });
router.use(authenticate, access.can(null, { from: 'org' }));

router.get(
  '/',
  wrap(async (req, res) => {
    const deals = await dealService().list(
      org(req),
      uid(req),
      canManage(req) && req.query.all === '1',
    );
    res.json({ data: deals.map((d: DealDoc) => view(d, uid(req))) });
  }),
);

router.post(
  '/',
  wrap(async (req, res) => {
    const terms = req.body?.terms as DealTerms;
    shape(terms);
    for (const side of ['client', 'worker'] as const) {
      if (!(await access.memberOf(terms[side].userId, org(req))))
        throw bad('party_not_member', `the ${side} must be a member of this organization`);
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
    res.json({
      data: view(
        await dealService().editTerms(req.params.dealId, org(req), uid(req), req.body.terms),
        uid(req),
      ),
    });
  }),
);

router.post(
  '/:dealId/sign',
  wrap(async (req, res) => {
    const h = str(req.body?.termsHash, 'termsHash', 64);
    res.json({
      data: view(await dealService().sign(req.params.dealId, org(req), uid(req), h), uid(req)),
    });
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
    let file = resolveEvidence(d, req.params.file);
    if (!file && process.env.DEMO_MODE === '1') {
      // the judge demo's placeholder frames sit on ephemeral disk: rebuild them on demand
      const { DEMO, ensureEvidenceFrames } = require('./demo.cts');
      if ([DEMO.dealId, DEMO.teamDealId].includes(d.id) && ensureEvidenceFrames(d) > 0)
        file = resolveEvidence(d, req.params.file);
    }
    if (!file)
      return res
        .status(404)
        .json({ error: { code: 'evidence_not_found', message: 'evidence not found' } });
    res.set({
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    });
    await new Promise<void>((ok, fail) =>
      // root = the file's own folder, so dotfiles:'deny' judges the file name only and an
      // evidence dir that sits under a dot-folder (e.g. ~/.cache/...) still serves
      res.sendFile(
        path.basename(file),
        { root: path.dirname(file), dotfiles: 'deny' },
        (err: unknown) => (err ? fail(err) : ok()),
      ),
    );
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
    const d = await dealService().approveHuman(
      req.params.dealId,
      org(req),
      uid(req),
      req.params.approvalKey,
    );
    const r = await dealService().tick(req.params.dealId, org(req));
    res.json({
      data: {
        deal: view(r.deal, uid(req)),
        results: r.out,
        approvedBefore: d.humanApprovals.length,
      },
    });
  }),
);

const M = '/:dealId/milestones/:key';
const svcCall = (fn: (req: Req) => Promise<DealDoc>) =>
  wrap(async (req, res) => {
    res.json({ data: view(await fn(req), uid(req)) });
  });
const version = (req: Req) => ({
  id: str(req.body?.versionId, 'versionId', 100),
  sha256: str(req.body?.sha256, 'sha256', 64),
});

router.post(
  `${M}/fund`,
  svcCall((req) =>
    dealService().startFunding(req.params.dealId, org(req), uid(req), req.params.key),
  ),
);
router.post(
  `${M}/fund/confirm`,
  wrap(async (req, res) => {
    const r = await dealService().confirmFunding(
      req.params.dealId,
      org(req),
      uid(req),
      req.params.key,
    );
    res
      .status(r.out.outcome === 'done' ? 200 : 409)
      .json({ data: { deal: view(r.deal, uid(req)), result: r.out } });
  }),
);
router.post(
  `${M}/style-sample`,
  svcCall((req) =>
    dealService().submitStyleSample(
      req.params.dealId,
      org(req),
      uid(req),
      req.params.key,
      version(req),
    ),
  ),
);
router.post(
  `${M}/style`,
  svcCall((req) =>
    dealService().decideStyle(
      req.params.dealId,
      org(req),
      uid(req),
      req.params.key,
      req.body?.ok === true,
    ),
  ),
);
router.post(
  `${M}/versions`,
  svcCall((req) =>
    dealService().submitVersion(
      req.params.dealId,
      org(req),
      uid(req),
      req.params.key,
      version(req),
    ),
  ),
);
router.post(
  `${M}/changes`,
  svcCall((req) => {
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length > 50)
      throw bad('invalid_input', 'items must be a list');
    const clean = items.map((i: any) => ({
      text: str(i?.text, 'item text', 2000),
      tag: i?.tag === 'fix' ? 'fix' : 'taste',
      checklistId: typeof i?.checklistId === 'string' ? i.checklistId : undefined,
      disputed: i?.disputed === true,
    }));
    return dealService().requestChanges(
      req.params.dealId,
      org(req),
      uid(req),
      req.params.key,
      clean,
      typeof req.body?.changeOrderId === 'string' ? req.body.changeOrderId : undefined,
    );
  }),
);
router.post(
  `${M}/approve`,
  svcCall((req) =>
    dealService().approve(
      req.params.dealId,
      org(req),
      uid(req),
      req.params.key,
      str(req.body?.versionId, 'versionId', 100),
      req.body?.release === true,
    ),
  ),
);
router.post(
  `${M}/kill`,
  svcCall((req) => dealService().kill(req.params.dealId, org(req), uid(req), req.params.key)),
);
router.post(
  `${M}/dispute`,
  svcCall((req) =>
    dealService().openDispute(req.params.dealId, org(req), uid(req), req.params.key),
  ),
);
router.post(
  `${M}/split`,
  svcCall((req) => {
    const n = req.body?.workerMinor;
    if (!Number.isSafeInteger(n))
      throw bad('invalid_input', 'workerMinor must be a whole number of minor units');
    return dealService().acceptSplit(req.params.dealId, org(req), uid(req), req.params.key, n);
  }),
);
router.post(
  `${M}/void-missed-deadline`,
  wrap(async (req, res) => {
    const r = await dealService().voidMissedDeadline(
      req.params.dealId,
      org(req),
      uid(req),
      req.params.key,
    );
    res
      .status(r.out.outcome === 'done' ? 200 : 409)
      .json({ data: { deal: view(r.deal, uid(req)), result: r.out } });
  }),
);

/* ------------------------------------------------------ Fair Review Clock */

/** The clock on a milestone: its state, amounts, rounds and a timeline of steps and actions. Brand and editor (and managers) can read it. */
router.get(
  `${M}/clock`,
  wrap(async (req, res) => {
    await readable(req, req.params.dealId);
    res.json({ data: await dealService().clockView(req.params.dealId, org(req), req.params.key) });
  }),
);
const clockReply = async (req: Req, res: Res, deal: DealDoc, extra: Record<string, unknown>) =>
  res.json({
    data: {
      ...extra,
      deal: view(deal, uid(req)),
      clock: await dealService().clockView(req.params.dealId, org(req), req.params.key).catch(() => null),
    },
  });
/** Brand approves: the full amount releases now and the clock ends. */
router.post(
  `${M}/clock/approve`,
  wrap(async (req, res) => {
    const r = await dealService().clockApprove(req.params.dealId, org(req), uid(req), req.params.key);
    await clockReply(req, res, r.deal, { results: r.out });
  }),
);
/** Brand asks for changes: { citation: brief item id | failed check id, text?, changeOrderId? }. 422 without a citation. */
router.post(
  `${M}/clock/changes`,
  wrap(async (req, res) => {
    const b = req.body || {};
    if (typeof b.citation !== 'string' || !b.citation.trim())
      throw bad('citation_required', 'a change request needs a citation: a brief item id or a failed check id');
    if (b.text !== undefined && (typeof b.text !== 'string' || b.text.length > 2000)) throw bad('invalid_input', 'text must be a string');
    const r = await dealService().clockRequestChanges(req.params.dealId, org(req), uid(req), req.params.key, {
      citation: b.citation,
      text: b.text,
      changeOrderId: typeof b.changeOrderId === 'string' ? b.changeOrderId : undefined,
    });
    await clockReply(req, res, r.deal, r.out);
  }),
);
/** Either party disputes: the remainder stays frozen in the hold and the clock stops. */
router.post(
  `${M}/clock/dispute`,
  wrap(async (req, res) => {
    const d = await dealService().clockDispute(req.params.dealId, org(req), uid(req), req.params.key);
    await clockReply(req, res, d, {});
  }),
);

/* ------------------------------------------------- clock terms on a draft */

const { planClockTerms } = require('./lib/review-clock.cts');
/** Dry run or save: same rules (party only, unsigned only, validateTerms' clock rules, backup reviewer is a member). */
async function clockTermsPlan(req: Req, d: DealDoc) {
  if (!actorRole(d, uid(req))) throw bad('not_party', 'only a party can edit the draft', 403);
  const plan = planClockTerms(d, req.params.key, req.body || {}, new Date().toISOString());
  const backup = plan.clock?.backupReviewerId;
  if (plan.allowed && backup && !(await access.memberOf(backup, org(req))))
    return { ...plan, allowed: false, problems: ['the backup reviewer must be a member of this organization'], terms: null, clock: null, preview: null };
  return plan;
}
/** Read-only: what these clock terms would mean (problems + "if you deliver today, review ends ..."). */
router.post(
  `${M}/clock-terms/check`,
  wrap(async (req, res) => {
    const d = await readable(req, req.params.dealId);
    const { terms: _t, ...plan } = await clockTermsPlan(req, d);
    res.json({ data: { ...plan, locked: !!d.termsHash } });
  }),
);
/** Set (or remove with { clock: null }) the review clock on a draft milestone. A signed deal answers 409 deal_locked. Clears signatures. */
router.put(
  `${M}/clock-terms`,
  wrap(async (req, res) => {
    const d = await readable(req, req.params.dealId);
    if (d.termsHash) throw bad('deal_locked', 'signed deals are locked; the review clock terms cannot change', 409);
    const plan = await clockTermsPlan(req, d);
    if (!plan.allowed || !plan.terms) {
      const err = bad('invalid_terms', plan.problems[0] || 'invalid review clock terms') as InstanceType<typeof ServiceError> & { details?: unknown };
      err.details = plan.problems;
      throw err;
    }
    const next = await dealService().editTerms(req.params.dealId, org(req), uid(req), plan.terms);
    const { terms: _t, ...rest } = plan;
    res.json({ data: { deal: view(next, uid(req)), ...rest } });
  }),
);

/* -------------------------------------------------------------- deal team */

/**
 * The milestone's team (payees + split). Dry run first, always: the same rules
 * the save runs (client only, unsigned deal only, members only, shares = 100%).
 * Read-only.
 */
router.post(
  `${M}/team/check`,
  wrap(async (req, res) => {
    const d = await readable(req, req.params.dealId);
    res.json({
      data: await planTeam(d, req.params.key, req.body || {}, {
        orgId: org(req),
        userId: uid(req),
      }),
    });
  }),
);
/** The client sets the team on a draft. A signed deal answers 409 deal_locked: payees move money. */
router.put(
  `${M}/team`,
  wrap(async (req, res) => {
    const d = await readable(req, req.params.dealId);
    const plan = await planTeam(d, req.params.key, req.body || {}, {
      orgId: org(req),
      userId: uid(req),
    });
    if (!plan.allowed) {
      const { status, code } = statusOf(plan);
      const err = bad(code, plan.violations[0].message, status) as InstanceType<
        typeof ServiceError
      > & { details?: unknown };
      err.details = plan.violations;
      throw err;
    }
    const next = await dealService().editTerms(
      req.params.dealId,
      org(req),
      uid(req),
      applyTeam(d, plan),
    );
    res.json({ data: view(next, uid(req)), plan });
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
      milestoneKey: b.milestoneKey,
      rateCardItemId: b.rateCardItemId,
      quantity: b.quantity,
      amountMinor: b.amountMinor,
      ask: b.ask,
      by: role,
    });
    res
      .status(201)
      .json({ data: { deal: view(r.deal, uid(req)), changeOrder: r.out.changeOrder } });
  }),
);
for (const verb of ['accept', 'decline'] as const) {
  router.post(
    `/:dealId/change-orders/:coId/${verb}`,
    wrap(async (req, res) => {
      await readable(req, req.params.dealId);
      const r = await dealService().decideChangeOrder(
        req.params.dealId,
        org(req),
        uid(req),
        req.params.coId,
        verb === 'accept',
      );
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

/* ------------------------------------------------------------ live copilot */

/**
 * Ask the live deal copilot which cards answer a question. Always 200: when the
 * agent is off, unreachable, slow or gives nothing usable the answer is
 * { source: 'offline', reason } and the web serves its deterministic replay.
 * The model picks cards and ids only; no amount, verdict or policy answer.
 */
const copilotLimit = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Req) => `copilot:${uid(req)}`,
  handler: (_req: Req, res: Res) =>
    res.status(200).json({ data: { source: 'offline', reason: 'rate_limited' } }),
});
router.post(
  '/:dealId/copilot',
  copilotLimit,
  wrap(async (req, res) => {
    const d = await readable(req, req.params.dealId);
    const q = str(req.body?.question, 'question', 500);
    const a = config.agent;
    const reply = await askCopilot(
      { enabled: a.enabled, url: a.url, secret: a.sharedSecret, timeoutMs: a.copilotTimeoutMs },
      d,
      actorRole(d, uid(req)) ?? null,
      q,
    );
    res.json({ data: reply });
  }),
);

/* ---------------------------------------------------------------- webhooks */

const webhookRouter = express.Router();
webhookRouter.post(
  '/paypal',
  wrap(async (req, res) => {
    const gw = gateway();
    if (gw.name !== 'mock' && !process.env.PAYPAL_WEBHOOK_ID) {
      return res
        .status(503)
        .json({
          error: { code: 'webhook_not_configured', message: 'PAYPAL_WEBHOOK_ID is not set' },
        });
    }
    const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
    if (!raw || !(await gw.verifyWebhook(req.headers, raw))) {
      return res
        .status(401)
        .json({ error: { code: 'bad_signature', message: 'webhook signature did not verify' } });
    }
    const r = await handlePaypalEvent(dealService(), JSON.parse(raw));
    res.json({ data: r });
  }),
);

/* ------------------------------------------- internal: clock driver */

/**
 * POST /api/v1/internal/clock/advance: runs every due Fair Review Clock step
 * (for an external scheduler such as a Render Workflow; the Money Agent tick
 * runs the same thing in-process). Guarded by X-Clock-Secret matching
 * CLOCK_SHARED_SECRET; when that env var is unset the route does not exist (404).
 */
const clockInternalRouter = express.Router();
clockInternalRouter.post(
  '/advance',
  wrap(async (req, res) => {
    const secret = process.env.CLOCK_SHARED_SECRET;
    if (!secret) return res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
    const given = String(req.get('x-clock-secret') || '');
    const crypto = require('node:crypto');
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(secret).digest();
    if (!given || !crypto.timingSafeEqual(a, b))
      return res.status(401).json({ error: { code: 'bad_secret', message: 'X-Clock-Secret did not match' } });
    const advanced = await dealService().advanceClocks();
    return res.json({ data: { advanced, steps: advanced.reduce((n: number, x: { steps: string[] }) => n + x.steps.length, 0) } });
  }),
);

/* --------------------------------------------- demo pool + demo reset (sandbox) */

/** /api/v1/paypal/pool: pre-approved sandbox authorizations for the judge demo (pool.cts). */
const poolRouter = require('./pool.cts').makePoolRouter(() => {
  const gw = gateway() as { name: string; rest?: unknown };
  return gw.name === 'paypal-sandbox' && gw.rest ? gw.rest : null;
});

/**
 * POST /api/v1/demo/deal/reset: the demo judge rebuilds "Diwali launch reels"
 * (DEMO_MODE=1 only). On sandbox this draws fresh pre-approved authorizations
 * from the pool, so it is limited to one reset every 2 minutes for everyone.
 */
const demoRouter = express.Router();
const resetLimit = rateLimit({
  windowMs: 120_000,
  limit: 1,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: () => 'demo-reset',
  handler: (_req: Req, res: Res) =>
    res
      .status(429)
      .json({
        error: { code: 'rate_limited', message: 'the demo was just reset; try again in 2 minutes' },
      }),
});
demoRouter.post(
  '/deal/reset',
  authenticate,
  wrap(async (req, res) => {
    if (process.env.DEMO_MODE !== '1')
      return res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
    const { DEMO, seedDealDemo } = require('./demo.cts');
    if (String(req.user?.email || '').toLowerCase() !== DEMO.judge.email)
      throw bad('forbidden', 'only the demo judge can reset the demo', 403);
    await new Promise<void>((ok) => resetLimit(req, res, () => ok()));
    if (res.headersSent) return undefined;
    const r = await seedDealDemo({ force: true, judgePassword: process.env.DEMO_JUDGE_PASSWORD });
    const d = await dealService().get(r.dealId, r.orgId);
    const ids = d.milestones.map((m: DealDoc['milestones'][number]) => ({
      key: m.key,
      orderId: m.funding?.orderId,
      authorizationId: m.funding?.authorizationId,
      captures: m.captures.map((c) => c.id),
    }));
    return res.json({
      data: {
        dealId: r.dealId,
        organizationId: r.orgId,
        holds: ids,
        real: ids.every(
          (x: { authorizationId?: string }) =>
            !!x.authorizationId && !x.authorizationId.startsWith('SIM-'),
        ),
      },
    });
  }),
);

module.exports = { router, webhookRouter, poolRouter, demoRouter, clockInternalRouter };
