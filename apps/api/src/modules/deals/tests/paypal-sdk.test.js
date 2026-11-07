/**
 * PayPal Server SDK adapter (lib/paypal-sdk.cts). HTTP is stubbed: the SDK's axios
 * client is pointed at the same fetch-shaped fake the REST tests use, so these
 * tests see the exact request the SDK would put on the wire (path, PayPal-Request-Id,
 * JSON body) without touching the PayPal sandbox.
 */
const {
  makeSdkGateway,
  GatewayError,
  gatewayFromEnv,
  paypalClientFromEnv,
} = require('../paypal.cts');

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}`;
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = v;
    let body = init.body;
    if (typeof body === 'string' && body && !body.startsWith('grant_type')) body = JSON.parse(body);
    calls.push({ key, headers, body });
    const route = routes.find((r) =>
      typeof r.match === 'string' ? r.match === key : r.match.test(key),
    );
    if (!route) throw new Error(`unexpected call ${key}`);
    const reply =
      typeof route.reply === 'function' ? route.reply(calls[calls.length - 1], calls) : route.reply;
    const text = reply.body === null || reply.body === undefined ? '' : JSON.stringify(reply.body);
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: async () => text,
      json: async () => (text ? JSON.parse(text) : {}),
    };
  };
  return { impl, calls };
}
const TOKEN = {
  match: 'POST /v1/oauth2/token',
  reply: { status: 200, body: { access_token: 'tok', token_type: 'Bearer', expires_in: 32400 } },
};
const gwWith = (routes, extra = {}) => {
  const f = fakeFetch([TOKEN, ...routes]);
  return {
    gw: makeSdkGateway({
      clientId: 'id',
      clientSecret: 'secret',
      fetchImpl: f.impl,
      retries: 0,
      ...extra,
    }),
    calls: f.calls,
  };
};
const AUTH = {
  id: '0VF52814937998046',
  status: 'CREATED',
  amount: { currency_code: 'USD', value: '400.00' },
  create_time: '2026-11-02T09:00:00Z',
  expiration_time: '2026-12-01T09:00:00Z',
};
const money = (c) => c.key !== 'POST /v1/oauth2/token';

describe('PayPal Server SDK adapter: request mapping', () => {
  test('create AUTHORIZE order: typed body on the wire, PayPal-Request-Id, approval link', async () => {
    const { gw, calls } = gwWith([
      {
        match: 'POST /v2/checkout/orders',
        reply: {
          status: 201,
          body: {
            id: '7EK94658LA8062152',
            status: 'PAYER_ACTION_REQUIRED',
            links: [
              { rel: 'self', href: 'x' },
              {
                rel: 'payer-action',
                href: 'https://www.sandbox.paypal.com/checkoutnow?token=7EK94658LA8062152',
              },
            ],
          },
        },
      },
    ]);
    const o = await gw.createAuthorizeOrder({
      amountMinor: 40000,
      currency: 'USD',
      referenceId: 'deal_1:reel1',
      customId: 'deal_1:reel1',
      description: 'Reel 1',
      returnUrl: 'https://a/r',
      cancelUrl: 'https://a/c',
      requestId: 'order:deal_1:reel1:first',
    });
    expect(o).toEqual({
      orderId: '7EK94658LA8062152',
      status: 'PAYER_ACTION_REQUIRED',
      approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=7EK94658LA8062152',
    });
    const c = calls.find((x) => x.key === 'POST /v2/checkout/orders');
    expect(c.headers['paypal-request-id']).toBe('order:deal_1:reel1:first');
    expect(c.headers.authorization).toBe('Bearer tok');
    expect(c.headers.prefer).toBe('return=representation');
    expect(c.body).toEqual({
      intent: 'AUTHORIZE',
      purchase_units: [
        {
          reference_id: 'deal_1:reel1',
          custom_id: 'deal_1:reel1',
          description: 'Reel 1',
          amount: { currency_code: 'USD', value: '400.00' },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'yv.',
            user_action: 'CONTINUE',
            shipping_preference: 'NO_SHIPPING',
            return_url: 'https://a/r',
            cancel_url: 'https://a/c',
          },
        },
      },
    });
    expect(gw.transport).toBe('sdk');
    expect(gw.name).toBe('paypal-sandbox');
  });

  test('authorize an approved order -> authorization in minor units with its expiry', async () => {
    const { gw, calls } = gwWith([
      {
        match: /^POST \/v2\/checkout\/orders\/ORD1\/authorize$/,
        reply: {
          status: 201,
          body: {
            id: 'ORD1',
            status: 'COMPLETED',
            purchase_units: [{ payments: { authorizations: [AUTH] } }],
          },
        },
      },
    ]);
    const a = await gw.authorizeOrder('ORD1', 'authorize:deal_1:reel1');
    expect(a).toEqual({
      authorizationId: AUTH.id,
      status: 'CREATED',
      amountMinor: 40000,
      createdAt: AUTH.create_time,
      expiresAt: AUTH.expiration_time,
    });
    const c = calls.find(money);
    expect(c.headers['paypal-request-id']).toBe('authorize:deal_1:reel1');
    expect(c.body).toEqual({});
  });

  test('authorize response without an authorization is an error, not a silent success', async () => {
    const { gw } = gwWith([
      {
        match: /authorize$/,
        reply: { status: 201, body: { id: 'ORD1', status: 'COMPLETED', purchase_units: [{}] } },
      },
    ]);
    await expect(gw.authorizeOrder('ORD1', 'k')).rejects.toMatchObject({
      code: 'NO_AUTHORIZATION',
      status: 502,
    });
  });

  test('get order + order detail read the first authorization', async () => {
    const order = {
      id: 'ORD1',
      status: 'COMPLETED',
      intent: 'AUTHORIZE',
      purchase_units: [
        {
          custom_id: 'deal_1:reel1',
          amount: { currency_code: 'USD', value: '400.00' },
          payments: { authorizations: [AUTH] },
        },
      ],
    };
    const { gw } = gwWith([
      { match: 'GET /v2/checkout/orders/ORD1', reply: { status: 200, body: order } },
    ]);
    expect(await gw.getOrder('ORD1')).toEqual({
      orderId: 'ORD1',
      status: 'COMPLETED',
      authorizationId: AUTH.id,
    });
    expect(await gw.getOrderDetail('ORD1')).toMatchObject({
      intent: 'AUTHORIZE',
      customId: 'deal_1:reel1',
      amountMinor: 40000,
      currency: 'USD',
      authorization: { authorizationId: AUTH.id },
    });
  });

  test('partial and final capture send amount, final_capture, invoice_id and the request id', async () => {
    const { gw, calls } = gwWith([
      {
        match: /capture$/,
        reply: (c) => ({
          status: 201,
          body: {
            id: c.body.final_capture ? 'CAPF' : 'CAPP',
            status: 'COMPLETED',
            amount: c.body.amount,
            final_capture: c.body.final_capture,
          },
        }),
      },
    ]);
    const p = await gw.capture(AUTH.id, {
      amountMinor: 10000,
      currency: 'USD',
      finalCapture: false,
      invoiceId: 'deal_1-reel1-partial',
      note: 'kill fee',
      requestId: 'partial_capture:deal_1:reel1:kill_fee',
    });
    expect(p).toEqual({
      captureId: 'CAPP',
      status: 'COMPLETED',
      amountMinor: 10000,
      finalCapture: false,
    });
    const f = await gw.capture(AUTH.id, {
      amountMinor: 30000,
      currency: 'USD',
      finalCapture: true,
      requestId: 'capture:deal_1:reel1',
    });
    expect(f).toEqual({
      captureId: 'CAPF',
      status: 'COMPLETED',
      amountMinor: 30000,
      finalCapture: true,
    });
    const caps = calls.filter(
      (c) => c.key === `POST /v2/payments/authorizations/${AUTH.id}/capture`,
    );
    expect(caps.map((c) => c.headers['paypal-request-id'])).toEqual([
      'partial_capture:deal_1:reel1:kill_fee',
      'capture:deal_1:reel1',
    ]);
    expect(caps[0].body).toEqual({
      amount: { currency_code: 'USD', value: '100.00' },
      final_capture: false,
      invoice_id: 'deal_1-reel1-partial',
      note_to_payer: 'kill fee',
    });
    expect(caps[1].body).toEqual({
      amount: { currency_code: 'USD', value: '300.00' },
      final_capture: true,
    });
  });

  test('void: 204 with no body -> VOIDED; request id sent, no request body', async () => {
    const { gw, calls } = gwWith([{ match: /void$/, reply: { status: 204, body: null } }]);
    expect(await gw.voidAuthorization(AUTH.id, 'void:deal_1:reel1:x')).toEqual({
      id: AUTH.id,
      status: 'VOIDED',
    });
    const c = calls.find(money);
    expect(c.key).toBe(`POST /v2/payments/authorizations/${AUTH.id}/void`);
    expect(c.headers['paypal-request-id']).toBe('void:deal_1:reel1:x');
    expect(c.body).toBeUndefined();
  });

  test('reauthorize -> the new authorization id, request id sent', async () => {
    const { gw, calls } = gwWith([
      { match: /reauthorize$/, reply: { status: 201, body: { ...AUTH, id: '8AA831015G517922L' } } },
    ]);
    const a = await gw.reauthorize(AUTH.id, 'reauthorize:deal_1:reel1:1');
    expect(a).toMatchObject({
      authorizationId: '8AA831015G517922L',
      amountMinor: 40000,
      status: 'CREATED',
    });
    const c = calls.find(money);
    expect(c.key).toBe(`POST /v2/payments/authorizations/${AUTH.id}/reauthorize`);
    expect(c.headers['paypal-request-id']).toBe('reauthorize:deal_1:reel1:1');
  });

  test('idempotency key longer than 108 chars is cut like the REST adapter does', async () => {
    const { gw, calls } = gwWith([{ match: /void$/, reply: { status: 204, body: null } }]);
    const key = `void:${'x'.repeat(200)}`;
    await gw.voidAuthorization('A', key);
    expect(calls.find(money).headers['paypal-request-id']).toBe(key.slice(0, 108));
  });

  test('refund goes through the SDK too', async () => {
    const { gw, calls } = gwWith([
      { match: /refund$/, reply: { status: 201, body: { id: 'REF1', status: 'COMPLETED' } } },
    ]);
    expect(
      await gw.refund('CAPF', { amountMinor: 500, currency: 'USD', requestId: 'refund:x' }),
    ).toEqual({ id: 'REF1', status: 'COMPLETED' });
    expect(calls.find(money).body).toEqual({ amount: { currency_code: 'USD', value: '5.00' } });
  });

  test('one OAuth token is reused across calls', async () => {
    const { gw, calls } = gwWith([{ match: /void$/, reply: { status: 204, body: null } }]);
    await gw.voidAuthorization('A', 'k1');
    await gw.voidAuthorization('B', 'k2');
    expect(calls.filter((c) => c.key === 'POST /v1/oauth2/token')).toHaveLength(1);
  });
});

describe('PayPal Server SDK adapter: errors map to the REST adapter shape', () => {
  test('422 MAX_CAPTURE_AMOUNT_EXCEEDED -> GatewayError with the issue, description, status and debug_id', async () => {
    const { gw } = gwWith([
      {
        match: /capture$/,
        reply: {
          status: 422,
          body: {
            name: 'UNPROCESSABLE_ENTITY',
            message: 'The requested action could not be performed.',
            details: [
              {
                issue: 'MAX_CAPTURE_AMOUNT_EXCEEDED',
                description: 'Capture amount exceeds allowable limit.',
              },
            ],
            debug_id: 'd1',
          },
        },
      },
    ]);
    const err = await gw
      .capture(AUTH.id, { amountMinor: 99999, currency: 'USD', finalCapture: true, requestId: 'k' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err).toMatchObject({
      code: 'MAX_CAPTURE_AMOUNT_EXCEEDED',
      status: 422,
      message: 'Capture amount exceeds allowable limit.',
      details: { debug_id: 'd1' },
    });
  });

  test('422 ORDER_NOT_APPROVED on authorize', async () => {
    const { gw } = gwWith([
      {
        match: /authorize$/,
        reply: {
          status: 422,
          body: {
            name: 'UNPROCESSABLE_ENTITY',
            details: [
              {
                issue: 'ORDER_NOT_APPROVED',
                description: 'Payer has not yet approved the Order for payment.',
              },
            ],
            debug_id: 'd2',
          },
        },
      },
    ]);
    await expect(gw.authorizeOrder('ORD1', 'k')).rejects.toMatchObject({
      code: 'ORDER_NOT_APPROVED',
      status: 422,
    });
  });

  test('5xx -> GatewayError with PayPal name and status (no retries configured)', async () => {
    const { gw, calls } = gwWith([
      {
        match: /void$/,
        reply: {
          status: 503,
          body: { name: 'SERVICE_UNAVAILABLE', message: 'Service Unavailable.', debug_id: 'd3' },
        },
      },
    ]);
    const err = await gw.voidAuthorization('A', 'k').catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      status: 503,
      message: 'Service Unavailable.',
      details: { debug_id: 'd3' },
    });
    expect(calls.filter(money)).toHaveLength(1);
  });

  test('5xx with an empty body -> PAYPAL_ERROR and the REST fallback message', async () => {
    const { gw } = gwWith([
      { match: /^GET \/v2\/payments\/authorizations\//, reply: { status: 500, body: null } },
    ]);
    await expect(gw.getAuthorization('A1')).rejects.toMatchObject({
      code: 'PAYPAL_ERROR',
      status: 500,
      message: 'PayPal GET /v2/payments/authorizations/A1 failed (500)',
    });
  });

  test('a 503 is retried with backoff and the same PayPal-Request-Id, then succeeds', async () => {
    let n = 0;
    const { gw, calls } = gwWith(
      [
        {
          match: /capture$/,
          reply: (c) =>
            ++n === 1
              ? { status: 503, body: { name: 'SERVICE_UNAVAILABLE' } }
              : {
                  status: 201,
                  body: {
                    id: 'CAP1',
                    status: 'COMPLETED',
                    amount: c.body.amount,
                    final_capture: true,
                  },
                },
        },
      ],
      { retries: 2, retryIntervalSec: 0.01 },
    );
    const r = await gw.capture('A1', {
      amountMinor: 100,
      currency: 'USD',
      finalCapture: true,
      requestId: 'capture:d:m',
    });
    expect(r.captureId).toBe('CAP1');
    const caps = calls.filter(money);
    expect(caps).toHaveLength(2);
    expect(caps.map((c) => c.headers['paypal-request-id'])).toEqual(['capture:d:m', 'capture:d:m']);
  });

  test('OAuth refused -> AUTH_FAILED (502)', async () => {
    const f = fakeFetch([
      {
        match: 'POST /v1/oauth2/token',
        reply: {
          status: 401,
          body: { error: 'invalid_client', error_description: 'Client Authentication failed' },
        },
      },
    ]);
    const gw = makeSdkGateway({ clientId: 'x', clientSecret: 'y', fetchImpl: f.impl, retries: 0 });
    await expect(gw.getOrder('O')).rejects.toMatchObject({ code: 'AUTH_FAILED', status: 502 });
  });

  test('network failure -> PAYPAL_UNREACHABLE (502)', async () => {
    const gw = makeSdkGateway({
      clientId: 'x',
      clientSecret: 'y',
      retries: 0,
      fetchImpl: async () => {
        throw new Error('ECONNRESET');
      },
    });
    await expect(gw.getOrder('O')).rejects.toMatchObject({
      code: 'PAYPAL_UNREACHABLE',
      status: 502,
    });
  });
});

describe('PayPal Server SDK adapter: what stays on REST', () => {
  test('payout batch and invoice draft are delegated to the REST adapter (not in the SDK)', async () => {
    const { gw, calls } = gwWith([
      {
        match: 'POST /v1/payments/payouts',
        reply: {
          status: 201,
          body: { batch_header: { payout_batch_id: 'PB1', batch_status: 'PENDING' } },
        },
      },
      {
        match: 'POST /v2/invoicing/invoices',
        reply: { status: 201, body: { id: 'INV2-1', status: 'DRAFT' } },
      },
    ]);
    expect(
      await gw.createPayoutBatch({
        senderBatchId: 'payout:d:m:approve',
        items: [
          {
            receiver: 'a@example.com',
            amountCents: 28000,
            currency: 'USD',
            note: 'n',
            senderItemId: 'm-a',
          },
        ],
      }),
    ).toEqual({ batchId: 'PB1', status: 'PENDING' });
    expect(
      await gw.createInvoiceDraft({
        currency: 'USD',
        note: 'n',
        items: [{ name: 'Extra cut', quantity: 1, unitAmountMinor: 6000 }],
        requestId: 'invoice:d:m:co1',
      }),
    ).toMatchObject({ id: 'INV2-1', status: 'DRAFT' });
    const payout = calls.find((c) => c.key === 'POST /v1/payments/payouts');
    expect(payout.headers['paypal-request-id']).toBe('payout:d:m:approve');
    // REST calls do not carry the SDK's user agent
    expect(String(payout.headers['user-agent'] || '')).not.toMatch(/TypeScript SDK/);
    expect(gw.rest).toBeTruthy();
  });

  test('injected fake controllers receive typed requests with paypalRequestId', async () => {
    const seen = [];
    const gw = makeSdkGateway({
      clientId: 'x',
      clientSecret: 'y',
      controllers: {
        orders: {
          createOrder: async () => ({}),
          getOrder: async () => ({}),
          authorizeOrder: async () => ({}),
        },
        payments: {
          getAuthorizedPayment: async () => ({}),
          captureAuthorizedPayment: async (req) => {
            seen.push(req);
            return {
              result: {
                id: 'C1',
                status: 'COMPLETED',
                amount: { currencyCode: 'USD', value: '2.50' },
                finalCapture: false,
              },
            };
          },
          voidPayment: async (req) => {
            seen.push(req);
            return { result: null };
          },
          reauthorizePayment: async (req) => {
            seen.push(req);
            return {
              result: {
                id: 'A2',
                status: 'CREATED',
                amount: { currencyCode: 'USD', value: '2.50' },
                createTime: 't',
              },
            };
          },
          refundCapturedPayment: async () => ({}),
        },
      },
    });
    expect(
      await gw.capture('A1', {
        amountMinor: 250,
        currency: 'USD',
        finalCapture: false,
        requestId: 'cap:1',
      }),
    ).toEqual({ captureId: 'C1', status: 'COMPLETED', amountMinor: 250, finalCapture: false });
    expect(await gw.voidAuthorization('A1', 'void:1')).toEqual({ id: 'A1', status: 'VOIDED' });
    expect((await gw.reauthorize('A1', 'reauth:1')).authorizationId).toBe('A2');
    expect(seen.map((r) => r.paypalRequestId)).toEqual(['cap:1', 'void:1', 'reauth:1']);
    expect(seen[0].body).toEqual({
      amount: { currencyCode: 'USD', value: '2.50' },
      finalCapture: false,
      invoiceId: undefined,
      noteToPayer: undefined,
    });
  });
});

describe('PAYPAL_CLIENT selection', () => {
  const creds = { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's' };
  test('sandbox defaults to sdk; rest on request; live defaults to rest; mock stays mock', () => {
    expect(paypalClientFromEnv({}, 'sandbox', 'https://api-m.sandbox.paypal.com')).toBe('sdk');
    expect(
      paypalClientFromEnv({ PAYPAL_CLIENT: 'rest' }, 'sandbox', 'https://api-m.sandbox.paypal.com'),
    ).toBe('rest');
    expect(paypalClientFromEnv({}, 'live', 'https://api-m.paypal.com')).toBe('rest');
    expect(paypalClientFromEnv({ PAYPAL_CLIENT: 'SDK' }, 'live', 'https://api-m.paypal.com')).toBe(
      'sdk',
    );
    expect(gatewayFromEnv({ PAYPAL_MODE: 'mock', PAYPAL_CLIENT: 'sdk' }).name).toBe('mock');
    expect(gatewayFromEnv({ ...creds, PAYPAL_MODE: 'sandbox' }).rest.transport).toBe('sdk');
    expect(
      gatewayFromEnv({ ...creds, PAYPAL_MODE: 'sandbox', PAYPAL_CLIENT: 'rest' }).rest.transport,
    ).toBeUndefined();
    expect(gatewayFromEnv({ ...creds, PAYPAL_MODE: 'live', PAYPAL_CLIENT: 'sdk' }).transport).toBe(
      'sdk',
    );
  });

  test('a custom PAYPAL_API_BASE falls back to rest; PAYPAL_CLIENT=sdk with it, or a typo, is refused', () => {
    expect(paypalClientFromEnv({}, 'sandbox', 'http://127.0.0.1:9999')).toBe('rest');
    expect(() =>
      paypalClientFromEnv({ PAYPAL_CLIENT: 'sdk' }, 'sandbox', 'http://127.0.0.1:9999'),
    ).toThrow(/PAYPAL_CLIENT=rest/);
    expect(() =>
      paypalClientFromEnv({ PAYPAL_CLIENT: 'grpc' }, 'sandbox', 'https://api-m.sandbox.paypal.com'),
    ).toThrow(/unknown PAYPAL_CLIENT/);
  });
});
