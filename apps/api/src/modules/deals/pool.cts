/**
 * deals/pool: pre-approved PayPal sandbox authorizations for the judge demo.
 *
 * A judge should see real PayPal sandbox money (real authorization, real
 * capture, real void) without logging in as a sandbox buyer. So a few real
 * orders are created ahead of time (scripts/paypal-auth-pool.cjs), a sandbox
 * buyer approves each one in the PayPal sandbox, and PayPal sends the buyer to
 * GET /api/v1/paypal/pool/return?token=<orderId>. That handler (or POST
 * /api/v1/paypal/pool/claim) asks PayPal about the order and, only when it is
 * ours (custom_id starts with "yv-auth-pool"), intent AUTHORIZE and approved by
 * the buyer, authorizes it and keeps the authorization here, ready.
 *
 * The demo seed takes one ready row per milestone (same amount, still valid for
 * 2+ days, oldest first so none expire unused). The sandbox gateway re-checks
 * it with PayPal before use. Nothing here can create money: a row only exists
 * for an order PayPal itself reports as approved by a buyer.
 *
 *   mongoPool                 AuthPool backed by the PaypalAuthPool collection
 *   claimPoolOrder(rest, id)  verify + authorize one approved pool order
 *   poolStatus()              counts by amount (no ids)
 *   poolRouter                mounted at /api/v1/paypal/pool
 */
import type { AuthPool } from './lib/paypal-sandbox.cts';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { PaypalAuthPool } = require('./lib/models.cts');

const POOL_PREFIX = 'yv-auth-pool';
const ORDER_ID = /^[A-Z0-9]{10,30}$/;

const mongoPool: AuthPool = {
  async take({ amountMinor, currency, minExpiresAt, usedBy }) {
    const row = await PaypalAuthPool.findOneAndUpdate(
      { status: 'ready', amountMinor, currency, expiresAt: { $gt: minExpiresAt } },
      { $set: { status: 'used', usedBy, usedAt: new Date() } },
      { sort: { authorizedAt: 1 }, new: true },
    ).lean();
    return row ? { orderId: String(row._id), authorizationId: row.authorizationId } : null;
  },
  async markInvalid(orderId, note) {
    await PaypalAuthPool.updateOne(
      { _id: orderId },
      { $set: { status: 'invalid', note: String(note).slice(0, 300) } },
    );
  },
};

class PoolError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

type RestLike = {
  getOrderDetail(
    orderId: string,
  ): Promise<{
    orderId: string;
    status: string;
    intent: string;
    customId: string;
    amountMinor: number;
    currency: string;
    authorization?: {
      authorizationId: string;
      status: string;
      amountMinor: number;
      createdAt: string;
      expiresAt?: string;
    };
  }>;
  authorizeOrder(
    orderId: string,
    requestId: string,
  ): Promise<{
    authorizationId: string;
    status: string;
    amountMinor: number;
    createdAt: string;
    expiresAt?: string;
  }>;
};

/** Verify one pool order with PayPal and keep its authorization. Idempotent per order id. */
async function claimPoolOrder(rest: RestLike, orderId: string) {
  if (typeof orderId !== 'string' || !ORDER_ID.test(orderId))
    throw new PoolError('invalid_order_id', 'not a PayPal order id', 400);
  const existing = await PaypalAuthPool.findById(orderId).lean();
  if (existing)
    return {
      orderId,
      status: existing.status,
      amountMinor: existing.amountMinor,
      currency: existing.currency,
      authorizationId: existing.authorizationId,
      already: true,
    };
  let o;
  try {
    o = await rest.getOrderDetail(orderId);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    throw new PoolError(
      'order_not_found',
      `PayPal does not know this order for our app (${err.message || 'lookup failed'})`,
      err.status === 404 ? 404 : 422,
    );
  }
  if (!o.customId.startsWith(POOL_PREFIX) || o.intent !== 'AUTHORIZE')
    throw new PoolError('not_pool_order', 'this order was not created for the demo pool', 422);
  let a = o.authorization;
  if (!a) {
    if (o.status !== 'APPROVED')
      throw new PoolError(
        'order_not_approved',
        `the buyer has not approved this order yet (PayPal status ${o.status})`,
        409,
      );
    a = await rest.authorizeOrder(orderId, `pool-authorize:${orderId}`);
  }
  if (a.status !== 'CREATED')
    throw new PoolError('authorization_not_usable', `PayPal authorization is ${a.status}`, 409);
  const authorizedAt = new Date(a.createdAt || Date.now());
  const expiresAt = new Date(a.expiresAt || authorizedAt.getTime() + 29 * 24 * 3600 * 1000);
  await PaypalAuthPool.updateOne(
    { _id: orderId },
    {
      $setOnInsert: {
        _id: orderId,
        authorizationId: a.authorizationId,
        amountMinor: a.amountMinor || o.amountMinor,
        currency: o.currency,
        status: 'ready',
        authorizedAt,
        expiresAt,
        claimedAt: new Date(),
      },
    },
    { upsert: true },
  );
  return {
    orderId,
    status: 'ready',
    amountMinor: a.amountMinor || o.amountMinor,
    currency: o.currency,
    authorizationId: a.authorizationId,
    already: false,
  };
}

/** Ready / used / invalid counts per amount, and when the next ready one expires. No ids. */
async function poolStatus() {
  const now = new Date();
  const rows = await PaypalAuthPool.find(
    {},
    { status: 1, amountMinor: 1, currency: 1, expiresAt: 1 },
  ).lean();
  const by: Record<
    string,
    {
      amountMinor: number;
      currency: string;
      ready: number;
      used: number;
      invalid: number;
      expired: number;
      nextExpiry?: string;
    }
  > = {};
  for (const r of rows) {
    const k = `${r.currency}:${r.amountMinor}`;
    const b = (by[k] ||= {
      amountMinor: r.amountMinor,
      currency: r.currency,
      ready: 0,
      used: 0,
      invalid: 0,
      expired: 0,
    });
    if (r.status === 'ready' && new Date(r.expiresAt) <= now) b.expired += 1;
    else b[r.status as 'ready' | 'used' | 'invalid'] += 1;
    if (
      r.status === 'ready' &&
      new Date(r.expiresAt) > now &&
      (!b.nextExpiry || new Date(r.expiresAt) < new Date(b.nextExpiry))
    )
      b.nextExpiry = new Date(r.expiresAt).toISOString();
  }
  return {
    amounts: Object.values(by).sort((a, b) => b.amountMinor - a.amountMinor),
    ready: Object.values(by).reduce((n, b) => n + b.ready, 0),
  };
}

/* ------------------------------------------------------------------ routes */

function makePoolRouter(restOf: () => RestLike | null) {
  const router = express.Router();
  const limit = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  });
  router.use(limit);
  const fail = (res: any, e: unknown) => {
    const err = e as { code?: string; status?: number; message?: string };
    res
      .status(err.status && err.status >= 400 && err.status < 600 ? err.status : 500)
      .json({ error: { code: err.code || 'pool_error', message: err.message || 'pool error' } });
  };
  const rest = (res: any) => {
    const r = restOf();
    if (!r)
      res
        .status(503)
        .json({ error: { code: 'pool_off', message: 'the demo pool needs PAYPAL_MODE=sandbox' } });
    return r;
  };

  router.get('/', async (_req: any, res: any) => {
    try {
      res.json({ data: await poolStatus() });
    } catch (e) {
      fail(res, e);
    }
  });

  /** PayPal sends the sandbox buyer here after they approve a pool order (?token=<orderId>&PayerID=...). */
  router.get('/return', async (req: any, res: any) => {
    const r = rest(res);
    if (!r) return;
    const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'",
    });
    try {
      const out = await claimPoolOrder(r, String(req.query.token || ''));
      res.send(
        `<!doctype html><title>yv. demo pool</title><p>PayPal sandbox authorization ${esc(out.authorizationId)} (order ${esc(out.orderId)}) is in the demo pool: ${esc(out.status)}.</p>`,
      );
    } catch (e) {
      const err = e as { code?: string; status?: number; message?: string };
      res
        .status(err.status || 500)
        .send(
          `<!doctype html><title>yv. demo pool</title><p>Not added: ${esc(err.code || 'error')}: ${esc(err.message || '')}</p>`,
        );
    }
  });

  router.get('/cancel', (_req: any, res: any) =>
    res.type('text/plain').send('Cancelled in PayPal: nothing was added to the demo pool.'),
  );

  /** Same as the return page, for an order approved elsewhere: { orderId }. */
  router.post('/claim', async (req: any, res: any) => {
    const r = rest(res);
    if (!r) return;
    try {
      res.json({ data: await claimPoolOrder(r, String(req.body?.orderId || '')) });
    } catch (e) {
      fail(res, e);
    }
  });
  return router;
}

module.exports = {
  mongoPool,
  claimPoolOrder,
  poolStatus,
  makePoolRouter,
  POOL_PREFIX,
  PoolError,
  PaypalAuthPool,
};
