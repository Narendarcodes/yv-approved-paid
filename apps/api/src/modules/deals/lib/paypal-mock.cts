/**
 * In-memory PayPal that follows the documented rules closely enough that the
 * policy engine and the Money Agent are tested against real constraints:
 *  - an order must be approved by the buyer before it can be authorized
 *  - an authorization is valid 29 days; the first 3 are the honor period
 *  - reauthorize only after the honor period and before day 29 (new 3-day honor period)
 *  - captures never exceed the authorized amount; final_capture closes the authorization
 *  - a fully captured authorization cannot be voided
 *  - the same PayPal-Request-Id returns the same response (idempotency)
 * The clock is injected so tests can jump days.
 */
import type { PaymentGateway, AuthorizationResult } from './gateway.cts';

const crypto = require('node:crypto');
const { GatewayError } = require('./gateway.cts');

const DAY = 24 * 3600 * 1000;

type Auth = {
  id: string;
  orderId: string;
  amountMinor: number;
  capturedMinor: number;
  createdAt: number;
  originalCreatedAt: number;
  honorEndsAt: number;
  expiresAt: number;
  status: string;
};

function makeMockGateway(opts: { now?: () => number; webhookSecret?: string } = {}) {
  const now = opts.now || (() => Date.now());
  const secret = opts.webhookSecret || 'mock-webhook-secret';
  const orders = new Map<string, { id: string; status: string; amountMinor: number; currency: string; authorizationId?: string }>();
  const auths = new Map<string, Auth>();
  const captures = new Map<string, { id: string; amountMinor: number; refundedMinor: number; authId: string }>();
  const idem = new Map<string, unknown>();
  const calls: { op: string; args: unknown }[] = [];
  let n = 0;
  const id = (p: string) => `${p}${(++n).toString().padStart(6, '0')}MOCK`;

  async function once<T>(requestId: string, op: string, fn: () => T): Promise<T> {
    const k = `${op}:${requestId}`;
    if (idem.has(k)) return idem.get(k) as T;
    const r = fn();
    idem.set(k, r);
    return r;
  }

  function authView(a: Auth): AuthorizationResult {
    const t = now();
    const status = a.status === 'CREATED' && t >= a.expiresAt ? 'EXPIRED' : a.status;
    return { authorizationId: a.id, status, amountMinor: a.amountMinor, createdAt: new Date(a.createdAt).toISOString(), expiresAt: new Date(a.expiresAt).toISOString() };
  }

  const gw: PaymentGateway & {
    approveOrder: (orderId: string) => void;
    calls: typeof calls;
    signWebhook: (rawBody: string) => Record<string, string>;
    state: () => unknown;
  } = {
    name: 'mock',
    calls,
    async createAuthorizeOrder(input) {
      calls.push({ op: 'createAuthorizeOrder', args: input });
      return once(input.requestId, 'order', () => {
        const o = { id: id('ORD'), status: 'CREATED', amountMinor: input.amountMinor, currency: input.currency };
        orders.set(o.id, o);
        return { orderId: o.id, status: 'PAYER_ACTION_REQUIRED', approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${o.id}` };
      });
    },
    approveOrder(orderId: string) {
      const o = orders.get(orderId);
      if (!o) throw new GatewayError('RESOURCE_NOT_FOUND', 'order not found', 404);
      o.status = 'APPROVED';
    },
    async getOrder(orderId) {
      const o = orders.get(orderId);
      if (!o) throw new GatewayError('RESOURCE_NOT_FOUND', 'order not found', 404);
      return { orderId: o.id, status: o.status, authorizationId: o.authorizationId };
    },
    async authorizeOrder(orderId, requestId) {
      calls.push({ op: 'authorizeOrder', args: { orderId } });
      return once(requestId, 'authorize', () => {
        const o = orders.get(orderId);
        if (!o) throw new GatewayError('RESOURCE_NOT_FOUND', 'order not found', 404);
        if (o.status === 'COMPLETED') throw new GatewayError('ORDER_ALREADY_AUTHORIZED', 'order already authorized');
        if (o.status !== 'APPROVED') throw new GatewayError('ORDER_NOT_APPROVED', 'payer has not approved the order');
        const t = now();
        const a: Auth = { id: id('AUTH'), orderId, amountMinor: o.amountMinor, capturedMinor: 0, createdAt: t, originalCreatedAt: t, honorEndsAt: t + 3 * DAY, expiresAt: t + 29 * DAY, status: 'CREATED' };
        auths.set(a.id, a);
        o.status = 'COMPLETED';
        o.authorizationId = a.id;
        return authView(a);
      });
    },
    async getAuthorization(authorizationId) {
      const a = auths.get(authorizationId);
      if (!a) throw new GatewayError('RESOURCE_NOT_FOUND', 'authorization not found', 404);
      return authView(a);
    },
    async reauthorize(authorizationId, requestId) {
      calls.push({ op: 'reauthorize', args: { authorizationId } });
      return once(requestId, 'reauthorize', () => {
        const a = auths.get(authorizationId);
        if (!a) throw new GatewayError('RESOURCE_NOT_FOUND', 'authorization not found', 404);
        const t = now();
        if (a.status !== 'CREATED') throw new GatewayError('AUTHORIZATION_ALREADY_CAPTURED', `cannot reauthorize a ${a.status} authorization`);
        if (t < a.honorEndsAt) throw new GatewayError('REAUTHORIZATION_TOO_SOON', 'honor period has not expired');
        if (t >= a.originalCreatedAt + 29 * DAY) throw new GatewayError('AUTHORIZATION_EXPIRED', 'authorization older than 29 days');
        const b: Auth = { ...a, id: id('AUTH'), createdAt: t, honorEndsAt: t + 3 * DAY };
        a.status = 'VOIDED'; // the old id is superseded by the reauthorization
        auths.set(b.id, b);
        return authView(b);
      });
    },
    async capture(authorizationId, input) {
      calls.push({ op: 'capture', args: { authorizationId, ...input } });
      return once(input.requestId, 'capture', () => {
        const a = auths.get(authorizationId);
        if (!a) throw new GatewayError('RESOURCE_NOT_FOUND', 'authorization not found', 404);
        const t = now();
        if (t >= a.expiresAt) throw new GatewayError('AUTHORIZATION_EXPIRED', 'authorization expired');
        if (a.status === 'VOIDED') throw new GatewayError('AUTHORIZATION_VOIDED', 'authorization voided');
        if (a.status === 'CAPTURED') throw new GatewayError('AUTHORIZATION_ALREADY_CAPTURED', 'authorization fully captured');
        if (input.amountMinor <= 0) throw new GatewayError('INVALID_PARAMETER_VALUE', 'amount must be positive');
        if (a.capturedMinor + input.amountMinor > a.amountMinor) throw new GatewayError('MAX_CAPTURE_AMOUNT_EXCEEDED', 'capture exceeds authorized amount');
        a.capturedMinor += input.amountMinor;
        a.status = input.finalCapture || a.capturedMinor === a.amountMinor ? 'CAPTURED' : 'PARTIALLY_CAPTURED';
        const c = { id: id('CAP'), amountMinor: input.amountMinor, refundedMinor: 0, authId: a.id };
        captures.set(c.id, c);
        return { captureId: c.id, status: 'COMPLETED', amountMinor: c.amountMinor, finalCapture: a.status === 'CAPTURED' };
      });
    },
    async voidAuthorization(authorizationId, requestId) {
      calls.push({ op: 'void', args: { authorizationId } });
      return once(requestId, 'void', () => {
        const a = auths.get(authorizationId);
        if (!a) throw new GatewayError('RESOURCE_NOT_FOUND', 'authorization not found', 404);
        if (a.status === 'CAPTURED') throw new GatewayError('CANNOT_BE_VOIDED', 'a fully captured authorization cannot be voided');
        if (a.status === 'VOIDED') throw new GatewayError('AUTHORIZATION_ALREADY_VOIDED', 'already voided');
        a.status = 'VOIDED';
        return { id: a.id, status: 'VOIDED' };
      });
    },
    async refund(captureId, input) {
      calls.push({ op: 'refund', args: { captureId, ...input } });
      return once(input.requestId, 'refund', () => {
        const c = captures.get(captureId);
        if (!c) throw new GatewayError('RESOURCE_NOT_FOUND', 'capture not found', 404);
        if (c.refundedMinor + input.amountMinor > c.amountMinor) throw new GatewayError('REFUND_AMOUNT_EXCEEDED', 'refund exceeds capture');
        c.refundedMinor += input.amountMinor;
        return { id: id('REF'), status: 'COMPLETED' };
      });
    },
    async payout(input) {
      calls.push({ op: 'payout', args: input });
      return once(input.senderBatchId, 'payout', () => ({ id: id('PAYOUT'), status: 'SUCCESS' }));
    },
    async createInvoiceDraft(input) {
      calls.push({ op: 'invoice', args: input });
      return once(input.requestId, 'invoice', () => {
        const inv = id('INV2-');
        return { id: inv, status: 'DRAFT', href: `https://www.sandbox.paypal.com/invoice/p/#${inv}` };
      });
    },
    async verifyWebhook(headers, rawBody) {
      const sig = headers['x-mock-signature'];
      if (!sig) return false;
      const expect = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      return sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
    },
    signWebhook(rawBody: string) {
      return { 'x-mock-signature': crypto.createHmac('sha256', secret).update(rawBody).digest('hex') };
    },
    state() {
      return { orders: [...orders.values()], auths: [...auths.values()], captures: [...captures.values()] };
    },
  };
  return gw;
}

module.exports = { makeMockGateway };
