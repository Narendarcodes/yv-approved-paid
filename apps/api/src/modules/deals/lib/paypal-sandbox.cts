/**
 * PayPal sandbox gateway for PAYPAL_MODE=sandbox. Every call goes to the real
 * PayPal sandbox (api-m.sandbox.paypal.com) through the REST adapter, plus:
 *
 *  - Invoices: a change-order invoice is created as a real Invoicing v2 draft
 *    (INV2-...) and then sent, so it shows as UNPAID in the sandbox.
 *
 *  - Pre-approved pool (judge demo, `pool` + `poolFor`): a sandbox buyer approved a
 *    few real orders ahead of time and the API authorized them (pool.cts). A demo
 *    order matching poolFor() takes one of those instead of creating a new order:
 *    the order id and authorization id are real PayPal sandbox ids, and every
 *    capture, void and reauthorization on it is a real sandbox call. A drawn
 *    authorization is checked with PayPal first (status CREATED, not expiring).
 *
 *  - Simulated buyer approval (only with `simulate: true`, and only when the pool
 *    is empty or not configured):
 *    the hold is a real sandbox order (intent AUTHORIZE, real order id), but a
 *    buyer has to log in to PayPal to approve it, and the demo cannot do that.
 *    simulateBuyerApproval(orderId) marks that one order as approved; from then
 *    on its authorization, captures, voids and refunds run on an in-memory twin
 *    that follows the same rules as PayPal (lib/paypal-mock). Those ids start
 *    with "SIM-" (the authorization id carries the real order id) and every
 *    result says "PayPal sandbox: buyer approval simulated". No capture id is
 *    ever made to look like a real PayPal id.
 *
 *  - Payouts are always attempted for real. If the sandbox account cannot send
 *    payouts (PAYOUT_NOT_AVAILABLE: the sandbox business account's country) and
 *    `simulate` is on, the payout is recorded with a "SIM-" batch id and the
 *    PayPal error in its note.
 *
 * Orders that were not marked keep the plain REST behaviour: authorizing an
 * order nobody approved fails with PayPal's own ORDER_NOT_APPROVED.
 */
import type { PaymentGateway } from './gateway.cts';

const crypto = require('node:crypto');
const { makeRestGateway } = require('./paypal-rest.cts');
const { makeMockGateway } = require('./paypal-mock.cts');

const SIM_APPROVAL = 'PayPal sandbox: buyer approval simulated';
const SIM_PAYOUT = 'PayPal sandbox: Payouts are not available to this sandbox account';

const SIM_POOL_EMPTY = 'PayPal sandbox: buyer approval simulated (pre-approved pool empty)';

/** Where pre-approved sandbox authorizations come from (pool.cts keeps them in Mongo). */
export type AuthPool = {
  /** Take (and mark used) the oldest ready row for this amount that is valid past minExpiresAt. */
  take(input: {
    amountMinor: number;
    currency: string;
    minExpiresAt: Date;
    usedBy: string;
  }): Promise<{ orderId: string; authorizationId: string } | null>;
  /** PayPal says the row cannot be used (voided, captured, expired). */
  markInvalid(orderId: string, note: string): Promise<void>;
};

type RestOpts = {
  clientId: string;
  clientSecret: string;
  apiBase?: string;
  webhookId?: string;
  fetchImpl?: (url: string, init?: any) => Promise<any>;
  currency?: string;
};

function makeSandboxGateway(
  opts: RestOpts & {
    simulate?: boolean;
    now?: () => number;
    pool?: AuthPool;
    /** Which orders may take a pooled authorization (the judge demo's deals only). */
    poolFor?: (input: { referenceId: string; customId: string }) => boolean;
    /** A drawn authorization must stay valid at least this long (default 2 days). */
    poolMinValidMs?: number;
  },
) {
  const rest = makeRestGateway(opts);
  const clock = opts.now || (() => Date.now());
  const twin = makeMockGateway({ now: opts.now });
  const simulate = !!opts.simulate;
  // In demo mode the deal is rebuilt on every boot with the same idempotency keys;
  // salt the PayPal-Request-Id per process so PayPal does not replay last boot's answers.
  const salt = simulate ? crypto.randomBytes(4).toString('hex') : '';
  const rid = (k: string) => (salt ? `${salt}:${k}` : k);

  const pooled = new Map<string, string>(); // real order id -> its real, pre-approved authorization id
  const simNote = opts.pool ? SIM_POOL_EMPTY : SIM_APPROVAL;
  const twinOrder = new Map<string, string>(); // real order id -> twin order id
  const approved = new Set<string>(); // real order ids with simulated buyer approval
  const toTwin = new Map<string, string>(); // SIM- id -> twin id
  let n = 0;
  const simId = (kind: string, twinId: string, label?: string) => {
    const id = `SIM-${kind}-${label || String(++n).padStart(4, '0')}`;
    toTwin.set(id, twinId);
    return id;
  };
  const isSim = (id: string) => typeof id === 'string' && id.startsWith('SIM-');
  const twinId = (id: string) => toTwin.get(id) || id;

  /** One pooled authorization for this order, checked with PayPal; null when the pool has none. */
  async function drawFromPool(input: {
    amountMinor: number;
    currency: string;
    referenceId: string;
    customId: string;
  }) {
    if (!opts.pool || !(opts.poolFor ? opts.poolFor(input) : false)) return null;
    const minValid = opts.poolMinValidMs ?? 2 * 24 * 3600 * 1000;
    for (let i = 0; i < 10; i += 1) {
      const row = await opts.pool.take({
        amountMinor: input.amountMinor,
        currency: input.currency,
        minExpiresAt: new Date(clock() + minValid),
        usedBy: input.referenceId,
      });
      if (!row) return null;
      try {
        const a = await rest.getAuthorization(row.authorizationId);
        if (a.status === 'CREATED' && a.amountMinor === input.amountMinor)
          return { ...row, auth: a };
        await opts.pool.markInvalid(row.orderId, `PayPal says ${a.status} (${a.amountMinor})`);
      } catch (e) {
        await opts.pool.markInvalid(row.orderId, `PayPal lookup failed: ${(e as Error).message}`);
      }
    }
    return null;
  }

  const gw: PaymentGateway & {
    simulate: boolean;
    maxReauthorizations: number;
    rest: typeof rest;
    isPooled(orderId: string): boolean;
    simulateBuyerApproval(orderId: string): void;
    sendInvoice(invoiceId: string): Promise<{ id: string; status: string; href?: string }>;
  } = {
    name: rest.name,
    maxReauthorizations: 1,
    simulate,
    rest,
    isPooled: (orderId: string) => pooled.has(orderId),
    async createAuthorizeOrder(input) {
      if (simulate) {
        const p = await drawFromPool(input);
        if (p) {
          pooled.set(p.orderId, p.authorizationId);
          return { orderId: p.orderId, status: 'COMPLETED', pooled: true } as any;
        }
      }
      const o = await rest.createAuthorizeOrder({ ...input, requestId: rid(input.requestId) });
      if (simulate) {
        const t = await twin.createAuthorizeOrder({
          ...input,
          requestId: `${o.orderId}:${input.requestId}`,
        });
        twinOrder.set(o.orderId, t.orderId);
      }
      return o;
    },
    simulateBuyerApproval(orderId: string) {
      if (!simulate)
        throw new Error('simulated buyer approval is only for the judge demo (DEMO_MODE=1)');
      if (pooled.has(orderId)) return; // a sandbox buyer really approved this one
      const t = twinOrder.get(orderId);
      if (!t) throw new Error(`unknown sandbox order ${orderId}`);
      twin.approveOrder(t);
      approved.add(orderId);
    },
    async getOrder(orderId) {
      if (pooled.has(orderId))
        return { orderId, status: 'COMPLETED', authorizationId: pooled.get(orderId) };
      if (!approved.has(orderId)) return rest.getOrder(orderId);
      const o = await twin.getOrder(twinOrder.get(orderId)!);
      const auth = [...toTwin.entries()].find(([, v]) => v === o.authorizationId)?.[0];
      return { orderId, status: o.status, authorizationId: auth, simulated: simNote } as any;
    },
    async authorizeOrder(orderId, requestId) {
      if (pooled.has(orderId)) return rest.getAuthorization(pooled.get(orderId)!); // authorized when it joined the pool
      if (!approved.has(orderId)) return rest.authorizeOrder(orderId, rid(requestId));
      const a = await twin.authorizeOrder(twinOrder.get(orderId)!, requestId);
      return {
        ...a,
        authorizationId: simId('AUTH', a.authorizationId, orderId),
        simulated: simNote,
      } as any;
    },
    async getAuthorization(authorizationId) {
      if (!isSim(authorizationId)) return rest.getAuthorization(authorizationId);
      const a = await twin.getAuthorization(twinId(authorizationId));
      return { ...a, authorizationId, simulated: simNote } as any;
    },
    async reauthorize(authorizationId, requestId) {
      if (!isSim(authorizationId)) return rest.reauthorize(authorizationId, rid(requestId));
      const a = await twin.reauthorize(twinId(authorizationId), requestId);
      return { ...a, authorizationId: simId('AUTH', a.authorizationId), simulated: simNote } as any;
    },
    async capture(authorizationId, input) {
      if (!isSim(authorizationId))
        return rest.capture(authorizationId, { ...input, requestId: rid(input.requestId) });
      const c = await twin.capture(twinId(authorizationId), input);
      return { ...c, captureId: simId('CAPTURE', c.captureId), simulated: simNote } as any;
    },
    async voidAuthorization(authorizationId, requestId) {
      if (!isSim(authorizationId)) return rest.voidAuthorization(authorizationId, rid(requestId));
      const r = await twin.voidAuthorization(twinId(authorizationId), requestId);
      return { ...r, id: authorizationId, simulated: simNote } as any;
    },
    async refund(captureId, input) {
      if (!isSim(captureId))
        return rest.refund(captureId, { ...input, requestId: rid(input.requestId) });
      const r = await twin.refund(twinId(captureId), input);
      return { ...r, id: simId('REFUND', r.id), simulated: simNote } as any;
    },
    async payout(input) {
      try {
        return await rest.payout({ ...input, senderBatchId: rid(input.senderBatchId) });
      } catch (e) {
        const err = e as { code?: string; message?: string };
        if (!simulate || err.code !== 'PAYOUT_NOT_AVAILABLE') throw e;
        const r = await twin.payout(input);
        return {
          id: simId('PAYOUT', r.id),
          status: 'SUCCESS',
          simulated: `${SIM_PAYOUT} (${err.code}: ${err.message}); payout simulated`,
        } as any;
      }
    },
    async createInvoiceDraft(input) {
      const d = await rest.createInvoiceDraft({ ...input, requestId: rid(input.requestId) });
      try {
        const s = await gw.sendInvoice(d.id);
        return { ...d, status: s.status, href: s.href || d.href };
      } catch {
        return d; // the real draft exists; it just was not sent
      }
    },
    async sendInvoice(invoiceId: string) {
      const r = await (rest as any).sendInvoice(invoiceId);
      return { id: invoiceId, status: 'SENT', href: r?.href };
    },
    verifyWebhook: (headers, raw) => rest.verifyWebhook(headers, raw),
  };
  return gw;
}

module.exports = { makeSandboxGateway, SIM_APPROVAL, SIM_POOL_EMPTY };
