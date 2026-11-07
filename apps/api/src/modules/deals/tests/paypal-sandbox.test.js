/**
 * PAYPAL_MODE=sandbox gateway: real sandbox calls (faked here), invoices are
 * created then sent, and in the judge demo the buyer's approval is simulated
 * for orders the seed marks; those ids say SIM- and carry the simulated note.
 */
const { makeSandboxGateway, gatewayFromEnv } = require('../paypal.cts');

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const key = `${init.method || 'GET'} ${new URL(url).pathname}`;
    calls.push({ key, headers: init.headers || {}, body: init.body });
    const route = routes.find((r) =>
      typeof r.match === 'string' ? r.match === key : r.match.test(key),
    );
    if (!route) throw new Error(`unexpected call ${key}`);
    const { status, body } = route.reply;
    const text = body === null || body === undefined ? '' : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => (text ? JSON.parse(text) : {}),
    };
  };
  return { impl, calls };
}
const ROUTES = [
  {
    match: 'POST /v1/oauth2/token',
    reply: { status: 200, body: { access_token: 'tok', token_type: 'Bearer', expires_in: 32400 } },
  },
  {
    match: 'POST /v2/checkout/orders',
    reply: {
      status: 201,
      body: {
        id: '7EK94658LA8062152',
        status: 'PAYER_ACTION_REQUIRED',
        links: [
          {
            rel: 'payer-action',
            href: 'https://www.sandbox.paypal.com/checkoutnow?token=7EK94658LA8062152',
          },
        ],
      },
    },
  },
  {
    match: /^POST \/v2\/checkout\/orders\/.+\/authorize$/,
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
      },
    },
  },
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
  {
    match: 'POST /v2/invoicing/invoices',
    reply: { status: 201, body: { id: 'INV2-V44L-8EX7-5TDF-TBWQ', status: 'DRAFT' } },
  },
  {
    match: /^POST \/v2\/invoicing\/invoices\/.+\/send$/,
    reply: {
      status: 200,
      body: {
        href: 'https://www.sandbox.paypal.com/invoice/p/#INV2-V44L-8EX7-5TDF-TBWQ',
        rel: 'payer-view',
        method: 'GET',
      },
    },
  },
];
const orderInput = (requestId) => ({
  amountMinor: 30000,
  currency: 'USD',
  referenceId: 'd:reel2',
  customId: 'd:reel2',
  description: 'x',
  returnUrl: 'https://a/r',
  cancelUrl: 'https://a/c',
  requestId,
});

describe('PayPal sandbox gateway', () => {
  test('invoice: a real Invoicing v2 draft, then sent', async () => {
    const f = fakeFetch(ROUTES);
    const gw = makeSandboxGateway({ clientId: 'id', clientSecret: 's', fetchImpl: f.impl });
    const r = await gw.createInvoiceDraft({
      currency: 'USD',
      note: 'n',
      items: [{ name: 'Extra 15s cut', quantity: 1, unitAmountMinor: 6000 }],
      requestId: 'invoice:d:reel2:co1',
    });
    expect(r).toMatchObject({ id: 'INV2-V44L-8EX7-5TDF-TBWQ', status: 'SENT' });
    expect(f.calls.map((c) => c.key)).toContain(
      'POST /v2/invoicing/invoices/INV2-V44L-8EX7-5TDF-TBWQ/send',
    );
  });

  test('without simulate, an unapproved order fails like PayPal and payouts errors pass through', async () => {
    const gw = makeSandboxGateway({
      clientId: 'id',
      clientSecret: 's',
      fetchImpl: fakeFetch(ROUTES).impl,
    });
    const o = await gw.createAuthorizeOrder(orderInput('order:d:reel2:first'));
    expect(() => gw.simulateBuyerApproval(o.orderId)).toThrow(/judge demo/);
    await expect(gw.authorizeOrder(o.orderId, 'auth:1')).rejects.toMatchObject({
      code: 'ORDER_NOT_APPROVED',
    });
    await expect(
      gw.payout({
        senderBatchId: 'p1',
        emailSubject: 's',
        items: [
          {
            email: 'a@example.com',
            amountMinor: 100,
            currency: 'USD',
            note: 'n',
            senderItemId: 'i',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'PAYOUT_NOT_AVAILABLE' });
  });

  test('demo: real order id, simulated approval, SIM- ids that never pass for real ones', async () => {
    const gw = makeSandboxGateway({
      clientId: 'id',
      clientSecret: 's',
      fetchImpl: fakeFetch(ROUTES).impl,
      simulate: true,
    });
    const o = await gw.createAuthorizeOrder(orderInput('order:d:reel2:first'));
    expect(o.orderId).toBe('7EK94658LA8062152');
    gw.simulateBuyerApproval(o.orderId);
    const a = await gw.authorizeOrder(o.orderId, 'auth:1');
    expect(a.authorizationId).toBe('SIM-AUTH-7EK94658LA8062152');
    expect(a.simulated).toBe('PayPal sandbox: buyer approval simulated');
    const c = await gw.capture(a.authorizationId, {
      amountMinor: 24000,
      currency: 'USD',
      finalCapture: false,
      requestId: 'cap:1',
    });
    expect(c.captureId).toMatch(/^SIM-CAPTURE-/);
    await expect(
      gw.capture(a.authorizationId, {
        amountMinor: 7000,
        currency: 'USD',
        finalCapture: false,
        requestId: 'cap:2',
      }),
    ).rejects.toMatchObject({ code: 'MAX_CAPTURE_AMOUNT_EXCEEDED' });
    expect(await gw.voidAuthorization(a.authorizationId, 'void:1')).toMatchObject({
      id: a.authorizationId,
      status: 'VOIDED',
    });
    const p = await gw.payout({
      senderBatchId: 'p1',
      emailSubject: 's',
      items: [
        {
          email: 'a@example.com',
          amountMinor: 24000,
          currency: 'USD',
          note: 'n',
          senderItemId: 'i',
        },
      ],
    });
    expect(p.id).toMatch(/^SIM-PAYOUT-/);
    expect(p.simulated).toMatch(/PAYOUT_NOT_AVAILABLE/);
  });

  test('demo reset: a payout batch is scoped to the funding authorization, so the same release key never reuses a sender_batch_id', async () => {
    const f = fakeFetch([
      ROUTES[0],
      {
        match: 'POST /v1/payments/payouts',
        reply: {
          status: 201,
          body: { batch_header: { payout_batch_id: 'PB1', batch_status: 'PENDING' } },
        },
      },
    ]);
    const gw = makeSandboxGateway({
      clientId: 'id',
      clientSecret: 's',
      fetchImpl: f.impl,
      simulate: true,
    });
    const batch = (scope) =>
      gw.createPayoutBatch({
        senderBatchId: 'payout:deal_demo_diwali:reel3:approve',
        ...(scope ? { scope } : {}),
        items: [
          {
            receiver: 'a@example.com',
            amountCents: 100,
            currency: 'USD',
            note: 'n',
            senderItemId: 'i',
          },
        ],
      });
    await batch('AUTH1111111111111');
    await batch('AUTH2222222222222'); // the same release after a reset, on a fresh pooled hold
    await batch();
    const ids = f.calls
      .filter((c) => c.key === 'POST /v1/payments/payouts')
      .map((c) => JSON.parse(c.body).sender_batch_header.sender_batch_id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toMatch(/AUTH1111111111111:payout:deal_demo_diwali:reel3:approve$/);
    expect(ids[1]).toMatch(/AUTH2222222222222:payout:deal_demo_diwali:reel3:approve$/);
    expect(ids[2]).toMatch(/^[0-9a-f]{8}:payout:deal_demo_diwali:reel3:approve$/);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(108);
  });

  test('gatewayFromEnv: sandbox picks it; simulate only with DEMO_MODE=1', () => {
    const base = { PAYPAL_MODE: 'sandbox', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's' };
    expect(gatewayFromEnv(base)).toMatchObject({ name: 'paypal-sandbox', simulate: false });
    expect(gatewayFromEnv({ ...base, DEMO_MODE: '1' })).toMatchObject({
      name: 'paypal-sandbox',
      simulate: true,
    });
    expect(gatewayFromEnv({ PAYPAL_MODE: 'mock' }).name).toBe('mock');
    expect(() => gatewayFromEnv({ ...base, PAYPAL_MODE: 'nope' })).toThrow(/unknown PAYPAL_MODE/);
  });
});
