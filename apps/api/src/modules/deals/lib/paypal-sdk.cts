/**
 * PayPal adapter on the APIMatic-generated PayPal Server SDK
 * (@paypal/paypal-server-sdk 2.5.x). Same PaymentGateway interface and the same
 * result and error shapes as the hand-written REST adapter (paypal-rest.cts), so
 * the engine, the policy code and the sandbox wrapper do not change.
 *
 * On the SDK (OrdersController + PaymentsController, typed request/response models):
 *   createAuthorizeOrder, getOrder, getOrderDetail, authorizeOrder,
 *   getAuthorization, capture, voidAuthorization, reauthorize, refund.
 * Every write passes our idempotency key as the SDK's paypalRequestId, which the
 * SDK sends as the PayPal-Request-Id header (cut to PayPal's 108 chars, like REST).
 *
 * Still on the REST adapter (delegated): payout, createPayoutBatch (Payouts v1),
 * createInvoiceDraft, sendInvoice (Invoicing v2), verifyWebhook and the webhook
 * admin calls (Notifications v1). The PayPal Server SDK 2.5 has no Payouts,
 * Invoicing or Webhooks controllers (it ships Orders, Payments, Vault,
 * Subscriptions, Transaction Search and OAuth only), so those keep the REST path.
 *
 * Retries: GET and POST are retried by the SDK on 408/429/5xx with exponential
 * backoff. POST is safe to retry here because every money write carries a
 * PayPal-Request-Id, so PayPal answers a repeat with the first result.
 *
 * Credentials come from opts (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET) and are never logged.
 */
import type { PaymentGateway, AuthorizationResult } from './gateway.cts';
import type {
  OrdersController as SdkOrders,
  PaymentsController as SdkPayments,
  OrderRequest,
  CheckoutPaymentIntent,
  PaypalWalletContextShippingPreference,
  PaypalExperienceUserAction,
  Order,
  AuthorizationWithAdditionalData,
  PaymentAuthorization,
  CapturedPayment,
  LinkDescription,
} from '@paypal/paypal-server-sdk';

const sdk = require('@paypal/paypal-server-sdk');
const { GatewayError } = require('./gateway.cts');
const { makeRestGateway } = require('./paypal-rest.cts');
const { toMajor, toMinor } = require('./money.cts');

type Fetch = (url: string, init?: any) => Promise<any>;

const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';
const LIVE_BASE = 'https://api-m.paypal.com';

type OrdersLike = Pick<SdkOrders, 'createOrder' | 'getOrder' | 'authorizeOrder'>;
type PaymentsLike = Pick<
  SdkPayments,
  | 'getAuthorizedPayment'
  | 'captureAuthorizedPayment'
  | 'voidPayment'
  | 'reauthorizePayment'
  | 'refundCapturedPayment'
>;

type SdkOpts = {
  clientId: string;
  clientSecret: string;
  /** Only the two PayPal hosts are supported by the SDK; anything else needs PAYPAL_CLIENT=rest. */
  apiBase?: string;
  webhookId?: string;
  currency?: string;
  /**
   * Tests: route the SDK's HTTP through a fetch-shaped stub (the same stub the REST
   * tests use) via an axios adapter. Production leaves it unset and the SDK uses its own client.
   */
  fetchImpl?: Fetch;
  /** Tests: inject fake controllers instead of building an SDK client. */
  controllers?: { orders: OrdersLike; payments: PaymentsLike };
  /** Per-request timeout in ms (default 30 s). */
  timeoutMs?: number;
  /** SDK retries on 408/429/5xx and timeouts (default 2). */
  retries?: number;
  /** First retry wait in seconds; doubles each retry (default 0.5). */
  retryIntervalSec?: number;
};

/** An axios adapter that answers from a fetch-shaped function (tests only). */
function fetchAdapter(f: Fetch) {
  return async (config: any) => {
    const raw =
      config.headers && typeof config.headers.toJSON === 'function'
        ? config.headers.toJSON()
        : { ...(config.headers || {}) };
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw))
      if (v !== undefined && v !== null) headers[k] = String(v);
    if (config.auth)
      headers.Authorization = `Basic ${Buffer.from(`${config.auth.username}:${config.auth.password || ''}`).toString('base64')}`;
    const r = await f(config.url, {
      method: String(config.method || 'get').toUpperCase(),
      headers,
      body:
        config.data === undefined || config.data === null || config.data === ''
          ? undefined
          : config.data,
    });
    const text = await r.text();
    return { data: text, status: r.status, statusText: '', headers: {}, config, request: {} };
  };
}

function makeSdkGateway(opts: SdkOpts) {
  const base = (opts.apiBase || SANDBOX_BASE).replace(/\/$/, '');
  if (base !== SANDBOX_BASE && base !== LIVE_BASE)
    throw new Error(
      `the PayPal Server SDK only talks to ${SANDBOX_BASE} or ${LIVE_BASE}; use PAYPAL_CLIENT=rest for ${base}`,
    );
  const live = base === LIVE_BASE;
  // Payouts, Invoicing and Webhooks are not in the PayPal Server SDK: they stay on REST.
  const rest = makeRestGateway(opts);

  let orders: OrdersLike;
  let payments: PaymentsLike;
  if (opts.controllers) {
    orders = opts.controllers.orders;
    payments = opts.controllers.payments;
  } else {
    const client = new sdk.Client({
      clientCredentialsAuthCredentials: {
        oAuthClientId: opts.clientId,
        oAuthClientSecret: opts.clientSecret,
      },
      environment: live ? sdk.Environment.Production : sdk.Environment.Sandbox,
      timeout: opts.timeoutMs ?? 30_000,
      httpClientOptions: {
        timeout: opts.timeoutMs ?? 30_000,
        retryConfig: {
          maxNumberOfRetries: opts.retries ?? 2,
          retryOnTimeout: true,
          retryInterval: opts.retryIntervalSec ?? 0.5,
          backoffFactor: 2,
          maximumRetryWaitTime: 10,
          httpStatusCodesToRetry: [408, 429, 500, 502, 503, 504],
          httpMethodsToRetry: ['GET', 'POST'],
        },
      },
      ...(opts.fetchImpl
        ? { unstable_httpClientOptions: { adapter: fetchAdapter(opts.fetchImpl) } }
        : {}),
    });
    orders = new sdk.OrdersController(client);
    payments = new sdk.PaymentsController(client);
  }

  const rid = (k: string) => k.slice(0, 108);
  const PREFER = 'return=representation';

  /** SDK error -> the GatewayError the REST adapter throws for the same response. */
  function toGatewayError(e: unknown, method: string, path: string): Error {
    if (e instanceof GatewayError) return e as Error;
    const err = e as {
      statusCode?: number;
      body?: unknown;
      result?: any;
      request?: { url?: string };
      message?: string;
    };
    if (e instanceof sdk.ResponseValidationError) {
      // a 2xx whose body does not match the SDK's model (REST would have taken it as-is)
      if (String(err.request?.url || '').includes('/v1/oauth2/token'))
        return new GatewayError('AUTH_FAILED', `PayPal OAuth failed (${err.statusCode})`, 502);
      return new GatewayError(
        'PAYPAL_BAD_RESPONSE',
        `PayPal ${method} ${path} returned an unexpected body`,
        502,
      );
    }
    if (typeof err?.statusCode === 'number') {
      if (String(err.request?.url || '').includes('/v1/oauth2/token'))
        return new GatewayError('AUTH_FAILED', `PayPal OAuth failed (${err.statusCode})`, 502);
      let json: any = {};
      if (typeof err.body === 'string' && err.body) {
        try {
          json = JSON.parse(err.body);
        } catch {
          json = { raw: err.body };
        }
      } else if (err.result && typeof err.result === 'object') json = err.result;
      const issue = json?.details?.[0]?.issue || json?.name || json?.error || 'PAYPAL_ERROR';
      const msg =
        json?.details?.[0]?.description ||
        json?.message ||
        `PayPal ${method} ${path} failed (${err.statusCode})`;
      return new GatewayError(issue, msg, err.statusCode, { debug_id: json?.debug_id });
    }
    // no HTTP answer (network down, timeout after retries, unreadable body)
    return new GatewayError(
      'PAYPAL_UNREACHABLE',
      `PayPal ${method} ${path} failed: ${err?.message || String(e)}`,
      502,
    );
  }

  async function run<T>(
    method: string,
    path: string,
    fn: () => Promise<{ result: T }>,
  ): Promise<T> {
    try {
      return (await fn()).result;
    } catch (e) {
      throw toGatewayError(e, method, path);
    }
  }

  function authFrom(
    a: AuthorizationWithAdditionalData | PaymentAuthorization,
    currency: string,
  ): AuthorizationResult {
    return {
      authorizationId: a.id as string,
      status: a.status as string,
      amountMinor: a.amount ? toMinor(a.amount.value, a.amount.currencyCode || currency) : 0,
      createdAt: a.createTime as string,
      expiresAt: a.expirationTime,
    };
  }
  const cur = () => opts.currency || 'USD';
  const enc = encodeURIComponent;

  const gw: PaymentGateway & {
    maxReauthorizations: number;
    transport: 'sdk';
    rest: typeof rest;
    getOrderDetail(orderId: string): Promise<{
      orderId: string;
      status: string;
      intent: string;
      customId: string;
      amountMinor: number;
      currency: string;
      authorization?: AuthorizationResult;
    }>;
    sendInvoice(
      invoiceId: string,
      sendToRecipient?: boolean,
    ): Promise<{ id: string; status: string; href?: string }>;
    createWebhook(url: string, eventTypes: string[]): Promise<{ id: string; url: string }>;
    listWebhooks(): Promise<{ id: string; url: string; events: string[] }[]>;
    deleteWebhook(id: string): Promise<void>;
  } = {
    name: live ? 'paypal-live' : 'paypal-sandbox',
    transport: 'sdk',
    rest,
    /** PayPal reauthorizes an authorization once (days 4-29); the engine plans no second one. */
    maxReauthorizations: 1,

    async createAuthorizeOrder(input) {
      const body: OrderRequest = {
        intent: 'AUTHORIZE' as CheckoutPaymentIntent,
        purchaseUnits: [
          {
            referenceId: input.referenceId.slice(0, 256),
            customId: input.customId.slice(0, 127),
            description: input.description.slice(0, 127),
            amount: {
              currencyCode: input.currency,
              value: toMajor(input.amountMinor, input.currency),
            },
          },
        ],
        paymentSource: {
          paypal: {
            experienceContext: {
              brandName: 'yv.',
              userAction: 'CONTINUE' as PaypalExperienceUserAction,
              shippingPreference: 'NO_SHIPPING' as PaypalWalletContextShippingPreference,
              returnUrl: input.returnUrl,
              cancelUrl: input.cancelUrl,
            },
          },
        },
      };
      const o: Order = await run('POST', '/v2/checkout/orders', () =>
        orders.createOrder({ body, paypalRequestId: rid(input.requestId), prefer: PREFER }),
      );
      const link = (o.links || []).find(
        (l: LinkDescription) => l.rel === 'payer-action' || l.rel === 'approve',
      );
      return { orderId: o.id as string, status: o.status as string, approveUrl: link?.href };
    },

    async getOrder(orderId) {
      const o: Order = await run('GET', `/v2/checkout/orders/${enc(orderId)}`, () =>
        orders.getOrder({ id: orderId }),
      );
      const auth = o?.purchaseUnits?.[0]?.payments?.authorizations?.[0];
      return { orderId: o.id as string, status: o.status as string, authorizationId: auth?.id };
    },

    /** The order with what the pool needs to trust it: custom_id, amount and its first authorization. */
    async getOrderDetail(orderId: string) {
      const o: Order = await run('GET', `/v2/checkout/orders/${enc(orderId)}`, () =>
        orders.getOrder({ id: orderId }),
      );
      const pu = o?.purchaseUnits?.[0];
      const a = pu?.payments?.authorizations?.[0];
      return {
        orderId: o.id as string,
        status: o.status as string,
        intent: (o.intent || '') as string,
        customId: pu?.customId || '',
        amountMinor: pu?.amount ? toMinor(pu.amount.value, pu.amount.currencyCode) : 0,
        currency: pu?.amount?.currencyCode || '',
        authorization: a ? authFrom(a, pu?.amount?.currencyCode || cur()) : undefined,
      };
    },

    async authorizeOrder(orderId, requestId) {
      const o = await run('POST', `/v2/checkout/orders/${enc(orderId)}/authorize`, () =>
        orders.authorizeOrder({
          id: orderId,
          paypalRequestId: rid(requestId),
          prefer: PREFER,
          body: {},
        }),
      );
      const a = o?.purchaseUnits?.[0]?.payments?.authorizations?.[0];
      if (!a)
        throw new GatewayError('NO_AUTHORIZATION', 'authorize returned no authorization', 502);
      return authFrom(a, cur());
    },

    async getAuthorization(authorizationId) {
      const a = await run('GET', `/v2/payments/authorizations/${enc(authorizationId)}`, () =>
        payments.getAuthorizedPayment({ authorizationId }),
      );
      return authFrom(a, cur());
    },

    async reauthorize(authorizationId, requestId) {
      const a = await run(
        'POST',
        `/v2/payments/authorizations/${enc(authorizationId)}/reauthorize`,
        () =>
          payments.reauthorizePayment({
            authorizationId,
            paypalRequestId: rid(requestId),
            prefer: PREFER,
            body: {},
          }),
      );
      return authFrom(a, cur());
    },

    async capture(authorizationId, input) {
      const c: CapturedPayment = await run(
        'POST',
        `/v2/payments/authorizations/${enc(authorizationId)}/capture`,
        () =>
          payments.captureAuthorizedPayment({
            authorizationId,
            paypalRequestId: rid(input.requestId),
            prefer: PREFER,
            body: {
              amount: {
                currencyCode: input.currency,
                value: toMajor(input.amountMinor, input.currency),
              },
              finalCapture: input.finalCapture,
              invoiceId: input.invoiceId,
              noteToPayer: input.note?.slice(0, 255),
            },
          }),
      );
      return {
        captureId: c.id as string,
        status: c.status as string,
        amountMinor: c.amount ? toMinor(c.amount.value, c.amount.currencyCode) : input.amountMinor,
        finalCapture: c.finalCapture ?? input.finalCapture,
      };
    },

    async voidAuthorization(authorizationId, requestId) {
      // PayPal answers 204 (no body) unless Prefer asks for the representation; the SDK maps an empty body to null
      const r = await run('POST', `/v2/payments/authorizations/${enc(authorizationId)}/void`, () =>
        payments.voidPayment({ authorizationId, paypalRequestId: rid(requestId) }),
      );
      return { id: r?.id || authorizationId, status: r?.status || 'VOIDED' };
    },

    async refund(captureId, input) {
      const r = await run('POST', `/v2/payments/captures/${enc(captureId)}/refund`, () =>
        payments.refundCapturedPayment({
          captureId,
          paypalRequestId: rid(input.requestId),
          prefer: PREFER,
          body: {
            amount: {
              currencyCode: input.currency,
              value: toMajor(input.amountMinor, input.currency),
            },
            noteToPayer: input.note?.slice(0, 255),
          },
        }),
      );
      return { id: r.id as string, status: r.status as string };
    },

    // ---- not in the PayPal Server SDK 2.5: Payouts v1, Invoicing v2, Notifications v1 stay on REST
    payout: (input) => rest.payout(input),
    createPayoutBatch: (input) => rest.createPayoutBatch(input),
    createInvoiceDraft: (input) => rest.createInvoiceDraft(input),
    sendInvoice: (invoiceId: string, sendToRecipient?: boolean) =>
      rest.sendInvoice(invoiceId, sendToRecipient),
    verifyWebhook: (headers, rawBody) => rest.verifyWebhook(headers, rawBody),
    createWebhook: (url: string, eventTypes: string[]) => rest.createWebhook(url, eventTypes),
    listWebhooks: () => rest.listWebhooks(),
    deleteWebhook: (id: string) => rest.deleteWebhook(id),
  };
  return gw;
}

module.exports = { makeSdkGateway, SANDBOX_BASE, LIVE_BASE };
