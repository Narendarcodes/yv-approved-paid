/**
 * Contract: the hand-written REST adapter and the PayPal Server SDK adapter give
 * the engine the same thing. Every scenario runs against both with the same
 * stubbed PayPal answers (recorded sandbox responses where we have them), and the
 * results, errors, PayPal-Request-Ids and JSON bodies on the wire must be identical.
 */
const { makeRestGateway, makeSdkGateway } = require('../paypal.cts');
const recorded = require('./fixtures/paypal-sandbox-recorded.json');

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const key = `${init.method || 'GET'} ${new URL(url).pathname}`;
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
      typeof route.reply === 'function' ? route.reply(calls[calls.length - 1]) : route.reply;
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
const tape = (method, prefix) =>
  recorded.tape.find((t) => t.method === method && t.path.startsWith(prefix));
const AUTH = {
  id: '0VF52814937998046',
  status: 'CREATED',
  amount: { currency_code: 'USD', value: '400.00' },
  create_time: '2026-11-02T09:00:00Z',
  expiration_time: '2026-12-01T09:00:00Z',
};
const err422 = (issue, description) => ({
  status: 422,
  body: {
    name: 'UNPROCESSABLE_ENTITY',
    message: 'The requested action could not be performed.',
    details: [{ issue, description }],
    debug_id: 'dbg-422',
  },
});

const ADAPTERS = {
  rest: (impl) => makeRestGateway({ clientId: 'id', clientSecret: 's', fetchImpl: impl }),
  sdk: (impl) => makeSdkGateway({ clientId: 'id', clientSecret: 's', fetchImpl: impl, retries: 0 }),
};

const orderIn = {
  amountMinor: 40000,
  currency: 'USD',
  referenceId: 'deal_1:reel1',
  customId: 'deal_1:reel1',
  description: 'Reel 1',
  returnUrl: 'https://a/r',
  cancelUrl: 'https://a/c',
  requestId: 'order:deal_1:reel1:first',
};

const SCENARIOS = [
  {
    name: 'create order (recorded sandbox answer)',
    routes: () => {
      const r = tape('POST', '/v2/checkout/orders');
      return [{ match: 'POST /v2/checkout/orders', reply: { status: r.status, body: r.body } }];
    },
    run: (gw) => gw.createAuthorizeOrder(orderIn),
  },
  {
    name: 'get order (recorded)',
    routes: () => {
      const r = tape('GET', '/v2/checkout/orders/');
      return [
        { match: /^GET \/v2\/checkout\/orders\//, reply: { status: r.status, body: r.body } },
      ];
    },
    run: (gw) => gw.getOrder(tape('GET', '/v2/checkout/orders/').body.id),
  },
  {
    name: 'authorize before approval -> ORDER_NOT_APPROVED 422 (recorded)',
    routes: () => {
      const r = tape('POST', '/v2/checkout/orders/');
      return [{ match: /authorize$/, reply: { status: r.status, body: r.body } }];
    },
    run: (gw) => gw.authorizeOrder('ORD1', 'authorize:deal_1:reel1'),
  },
  {
    name: 'authorize approved order',
    routes: () => [
      {
        match: /authorize$/,
        reply: {
          status: 201,
          body: {
            id: 'ORD1',
            status: 'COMPLETED',
            purchase_units: [{ payments: { authorizations: [AUTH] } }],
          },
        },
      },
    ],
    run: (gw) => gw.authorizeOrder('ORD1', 'authorize:deal_1:reel1'),
  },
  {
    name: 'order detail',
    routes: () => [
      {
        match: 'GET /v2/checkout/orders/ORD1',
        reply: {
          status: 200,
          body: {
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
          },
        },
      },
    ],
    run: (gw) => gw.getOrderDetail('ORD1'),
  },
  {
    name: 'get authorization',
    routes: () => [
      { match: `GET /v2/payments/authorizations/${AUTH.id}`, reply: { status: 200, body: AUTH } },
    ],
    run: (gw) => gw.getAuthorization(AUTH.id),
  },
  {
    name: 'reauthorize',
    routes: () => [
      { match: /reauthorize$/, reply: { status: 201, body: { ...AUTH, id: '8AA831015G517922L' } } },
    ],
    run: (gw) => gw.reauthorize(AUTH.id, 'reauthorize:deal_1:reel1:1'),
  },
  {
    name: 'partial capture',
    routes: () => [
      {
        match: /capture$/,
        reply: (c) => ({
          status: 201,
          body: {
            id: 'CAPP',
            status: 'COMPLETED',
            amount: c.body.amount,
            final_capture: c.body.final_capture,
          },
        }),
      },
    ],
    run: (gw) =>
      gw.capture(AUTH.id, {
        amountMinor: 10000,
        currency: 'USD',
        finalCapture: false,
        invoiceId: 'deal_1-reel1-partial',
        note: 'kill fee',
        requestId: 'partial_capture:deal_1:reel1:kill_fee',
      }),
  },
  {
    name: 'capture without amount in the answer keeps the asked amount',
    routes: () => [
      { match: /capture$/, reply: { status: 201, body: { id: 'CAPF', status: 'PENDING' } } },
    ],
    run: (gw) =>
      gw.capture(AUTH.id, {
        amountMinor: 30000,
        currency: 'USD',
        finalCapture: true,
        requestId: 'capture:deal_1:reel1',
      }),
  },
  {
    name: 'capture over the hold -> 422 MAX_CAPTURE_AMOUNT_EXCEEDED',
    routes: () => [
      {
        match: /capture$/,
        reply: err422('MAX_CAPTURE_AMOUNT_EXCEEDED', 'Capture amount exceeds allowable limit.'),
      },
    ],
    run: (gw) =>
      gw.capture(AUTH.id, {
        amountMinor: 99999,
        currency: 'USD',
        finalCapture: true,
        requestId: 'k',
      }),
  },
  {
    name: 'void (204)',
    routes: () => [{ match: /void$/, reply: { status: 204, body: null } }],
    run: (gw) => gw.voidAuthorization(AUTH.id, 'void:deal_1:reel1:x'),
  },
  {
    name: 'void an expired hold -> 422 AUTHORIZATION_EXPIRED',
    routes: () => [
      { match: /void$/, reply: err422('AUTHORIZATION_EXPIRED', 'Authorization has expired.') },
    ],
    run: (gw) => gw.voidAuthorization(AUTH.id, 'void:x'),
  },
  {
    name: 'refund',
    routes: () => [
      { match: /refund$/, reply: { status: 201, body: { id: 'REF1', status: 'COMPLETED' } } },
    ],
    run: (gw) =>
      gw.refund('CAPF', { amountMinor: 500, currency: 'USD', note: 'n', requestId: 'refund:x' }),
  },
  {
    name: 'PayPal 500 on reauthorize',
    routes: () => [
      {
        match: /reauthorize$/,
        reply: {
          status: 500,
          body: {
            name: 'INTERNAL_SERVER_ERROR',
            message: 'An internal server error occurred.',
            debug_id: 'dbg-500',
          },
        },
      },
    ],
    run: (gw) => gw.reauthorize(AUTH.id, 'k'),
  },
  {
    name: 'PayPal 503 with an empty body on capture',
    routes: () => [{ match: /capture$/, reply: { status: 503, body: null } }],
    run: (gw) =>
      gw.capture(AUTH.id, {
        amountMinor: 100,
        currency: 'USD',
        finalCapture: true,
        requestId: 'k',
      }),
  },
  {
    name: 'unknown authorization -> 404 RESOURCE_NOT_FOUND',
    routes: () => [
      {
        match: /^GET \/v2\/payments\/authorizations\//,
        reply: {
          status: 404,
          body: {
            name: 'RESOURCE_NOT_FOUND',
            message: 'The specified resource does not exist.',
            details: [
              {
                issue: 'INVALID_RESOURCE_ID',
                description: 'Specified resource ID does not exist.',
              },
            ],
            debug_id: 'dbg-404',
          },
        },
      },
    ],
    run: (gw) => gw.getAuthorization('NOPE'),
  },
  {
    name: 'payout batch (REST in both)',
    routes: () => [
      {
        match: 'POST /v1/payments/payouts',
        reply: {
          status: 201,
          body: { batch_header: { payout_batch_id: 'PB1', batch_status: 'PENDING' } },
        },
      },
    ],
    run: (gw) =>
      gw.createPayoutBatch({
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
  },
  {
    name: 'payouts refused (REST in both)',
    routes: () => [
      {
        match: 'POST /v1/payments/payouts',
        reply: {
          status: 403,
          body: {
            name: 'PAYOUT_NOT_AVAILABLE',
            message: 'You live in a country that is not allowed to send this payout.',
          },
        },
      },
    ],
    run: (gw) =>
      gw.createPayoutBatch({
        senderBatchId: 'payout:d:m:approve',
        items: [
          {
            receiver: 'a@example.com',
            amountCents: 100,
            currency: 'USD',
            note: 'n',
            senderItemId: 'm-a',
          },
        ],
      }),
  },
  {
    name: 'invoice draft (REST in both, recorded)',
    routes: () => {
      const r = tape('POST', '/v2/invoicing/invoices');
      return [{ match: 'POST /v2/invoicing/invoices', reply: { status: r.status, body: r.body } }];
    },
    run: (gw) =>
      gw.createInvoiceDraft({
        currency: 'USD',
        note: 'n',
        items: [{ name: 'Extra 15s cut', quantity: 2, unitAmountMinor: 6000 }],
        requestId: 'invoice:deal_1:reel1:co1',
      }),
  },
];

async function outcome(kind, scenario) {
  const f = fakeFetch([TOKEN, ...scenario.routes()]);
  const gw = ADAPTERS[kind](f.impl);
  let result;
  try {
    result = { ok: await scenario.run(gw) };
  } catch (e) {
    result = {
      error: {
        name: e.constructor.name,
        code: e.code,
        status: e.status,
        message: e.message,
        details: e.details,
      },
    };
  }
  const wire = f.calls
    .filter((c) => c.key !== 'POST /v1/oauth2/token')
    .map((c) => ({
      key: c.key,
      requestId: c.headers['paypal-request-id'],
      body: c.body === undefined ? null : c.body,
    }));
  return { result, wire };
}

describe('REST and SDK adapters agree', () => {
  test.each(SCENARIOS.map((s) => [s.name, s]))('%s', async (_name, scenario) => {
    const rest = await outcome('rest', scenario);
    const sdk = await outcome('sdk', scenario);
    expect(sdk.result).toEqual(rest.result);
    expect(sdk.wire).toEqual(rest.wire);
    // errors must be GatewayErrors in both, never raw SDK exceptions
    if (rest.result.error) expect(rest.result.error.name).toBe('GatewayError');
  });

  test('the scenario list covers every call that moved to the SDK', () => {
    const moved = [
      'createAuthorizeOrder',
      'getOrder',
      'getOrderDetail',
      'authorizeOrder',
      'getAuthorization',
      'capture',
      'voidAuthorization',
      'reauthorize',
      'refund',
    ];
    const src = SCENARIOS.map((s) => s.run.toString()).join('\n');
    for (const m of moved) expect(src).toContain(`gw.${m}(`);
  });
});
