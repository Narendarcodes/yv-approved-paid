/**
 * PayPal sandbox gateway for PAYPAL_MODE=sandbox. Every call goes to the real
 * PayPal sandbox (api-m.sandbox.paypal.com) through the REST adapter, plus:
 *
 *  - Invoices: a change-order invoice is created as a real Invoicing v2 draft
 *    (INV2-...) and then sent, so it shows as UNPAID in the sandbox.
 *
 *  - Simulated buyer approval (only with `simulate: true`, i.e. the judge demo):
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

type RestOpts = { clientId: string; clientSecret: string; apiBase?: string; webhookId?: string; fetchImpl?: (url: string, init?: any) => Promise<any>; currency?: string };

function makeSandboxGateway(opts: RestOpts & { simulate?: boolean; now?: () => number }) {
  const rest = makeRestGateway(opts);
  const twin = makeMockGateway({ now: opts.now });
  const simulate = !!opts.simulate;
  // In demo mode the deal is rebuilt on every boot with the same idempotency keys;
  // salt the PayPal-Request-Id per process so PayPal does not replay last boot's answers.
  const salt = simulate ? crypto.randomBytes(4).toString('hex') : '';
  const rid = (k: string) => (salt ? `${salt}:${k}` : k);

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

  const gw: PaymentGateway & {
    simulate: boolean;
    simulateBuyerApproval(orderId: string): void;
    sendInvoice(invoiceId: string): Promise<{ id: string; status: string; href?: string }>;
  } = {
    name: rest.name,
    simulate,
    async createAuthorizeOrder(input) {
      const o = await rest.createAuthorizeOrder({ ...input, requestId: rid(input.requestId) });
      if (simulate) {
        const t = await twin.createAuthorizeOrder({ ...input, requestId: `${o.orderId}:${input.requestId}` });
        twinOrder.set(o.orderId, t.orderId);
      }
      return o;
    },
    simulateBuyerApproval(orderId: string) {
      if (!simulate) throw new Error('simulated buyer approval is only for the judge demo (DEMO_MODE=1)');
      const t = twinOrder.get(orderId);
      if (!t) throw new Error(`unknown sandbox order ${orderId}`);
      twin.approveOrder(t);
      approved.add(orderId);
    },
    async getOrder(orderId) {
      if (!approved.has(orderId)) return rest.getOrder(orderId);
      const o = await twin.getOrder(twinOrder.get(orderId)!);
      const auth = [...toTwin.entries()].find(([, v]) => v === o.authorizationId)?.[0];
      return { orderId, status: o.status, authorizationId: auth, simulated: SIM_APPROVAL } as any;
    },
    async authorizeOrder(orderId, requestId) {
      if (!approved.has(orderId)) return rest.authorizeOrder(orderId, rid(requestId));
      const a = await twin.authorizeOrder(twinOrder.get(orderId)!, requestId);
      return { ...a, authorizationId: simId('AUTH', a.authorizationId, orderId), simulated: SIM_APPROVAL } as any;
    },
    async getAuthorization(authorizationId) {
      if (!isSim(authorizationId)) return rest.getAuthorization(authorizationId);
      const a = await twin.getAuthorization(twinId(authorizationId));
      return { ...a, authorizationId, simulated: SIM_APPROVAL } as any;
    },
    async reauthorize(authorizationId, requestId) {
      if (!isSim(authorizationId)) return rest.reauthorize(authorizationId, rid(requestId));
      const a = await twin.reauthorize(twinId(authorizationId), requestId);
      return { ...a, authorizationId: simId('AUTH', a.authorizationId), simulated: SIM_APPROVAL } as any;
    },
    async capture(authorizationId, input) {
      if (!isSim(authorizationId)) return rest.capture(authorizationId, { ...input, requestId: rid(input.requestId) });
      const c = await twin.capture(twinId(authorizationId), input);
      return { ...c, captureId: simId('CAPTURE', c.captureId), simulated: SIM_APPROVAL } as any;
    },
    async voidAuthorization(authorizationId, requestId) {
      if (!isSim(authorizationId)) return rest.voidAuthorization(authorizationId, rid(requestId));
      const r = await twin.voidAuthorization(twinId(authorizationId), requestId);
      return { ...r, id: authorizationId, simulated: SIM_APPROVAL } as any;
    },
    async refund(captureId, input) {
      if (!isSim(captureId)) return rest.refund(captureId, { ...input, requestId: rid(input.requestId) });
      const r = await twin.refund(twinId(captureId), input);
      return { ...r, id: simId('REFUND', r.id), simulated: SIM_APPROVAL } as any;
    },
    async payout(input) {
      try {
        return await rest.payout({ ...input, senderBatchId: rid(input.senderBatchId) });
      } catch (e) {
        const err = e as { code?: string; message?: string };
        if (!simulate || err.code !== 'PAYOUT_NOT_AVAILABLE') throw e;
        const r = await twin.payout(input);
        return { id: simId('PAYOUT', r.id), status: 'SUCCESS', simulated: `${SIM_PAYOUT} (${err.code}: ${err.message}); payout simulated` } as any;
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

module.exports = { makeSandboxGateway, SIM_APPROVAL };
