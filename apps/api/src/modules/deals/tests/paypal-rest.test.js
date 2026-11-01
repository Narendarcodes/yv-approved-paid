/**
 * PayPal REST adapter against (a) responses recorded from the real sandbox
 * (scripts/paypal-record.cjs) and (b) documented response shapes for the calls
 * that need a buyer to approve first (authorize, reauthorize, capture, void,
 * refund, payouts). The adapter must send the right body and PayPal-Request-Id,
 * map amounts to minor units and turn PayPal errors into GatewayErrors.
 */
const { makeRestGateway, GatewayError } = require('../paypal.cts');
const recorded = require('./fixtures/paypal-sandbox-recorded.json');

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}`;
    calls.push({ key, headers: init.headers || {}, body: init.body && !String(init.body).startsWith('grant_type') ? JSON.parse(init.body) : init.body });
    const route = routes.find((r) => (typeof r.match === 'string' ? r.match === key : r.match.test(key)));
    if (!route) throw new Error(`unexpected call ${key}`);
    const { status, body } = typeof route.reply === 'function' ? route.reply(calls[calls.length - 1]) : route.reply;
    const text = body === null || body === undefined ? '' : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => (text ? JSON.parse(text) : {}) };
  };
  return { impl, calls };
}
const tape = (method, prefix) => recorded.tape.find((t) => t.method === method && t.path.startsWith(prefix));
const TOKEN = { match: 'POST /v1/oauth2/token', reply: { status: 200, body: { access_token: 'tok', token_type: 'Bearer', expires_in: 32400 } } };
const gwWith = (routes, extra = {}) => {
  const f = fakeFetch([TOKEN, ...routes]);
  return { gw: makeRestGateway({ clientId: 'id', clientSecret: 'secret', fetchImpl: f.impl, ...extra }), calls: f.calls };
};

describe('replayed from the real sandbox', () => {
  test('create AUTHORIZE order: body, request id, approval link', async () => {
    const rec = tape('POST', '/v2/checkout/orders');
    const { gw, calls } = gwWith([{ match: 'POST /v2/checkout/orders', reply: { status: rec.status, body: rec.body } }]);
    const o = await gw.createAuthorizeOrder({ amountMinor: 40000, currency: 'USD', referenceId: 'deal_1:reel1', customId: 'deal_1:reel1', description: 'x', returnUrl: 'https://a/r', cancelUrl: 'https://a/c', requestId: 'order:deal_1:reel1:first' });
    expect(o.status).toBe('PAYER_ACTION_REQUIRED');
    expect(o.orderId).toBe(rec.body.id);
    expect(o.approveUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\/checkoutnow\?token=/);
    const c = calls.find((x) => x.key === 'POST /v2/checkout/orders');
    expect(c.headers['PayPal-Request-Id']).toBe('order:deal_1:reel1:first');
    expect(c.headers.Authorization).toBe('Bearer tok');
    expect(c.body.intent).toBe('AUTHORIZE');
    expect(c.body.purchase_units[0].amount).toEqual({ currency_code: 'USD', value: '400.00' });
    expect(c.body.payment_source.paypal.experience_context.shipping_preference).toBe('NO_SHIPPING');
    // the recorded request had the same shape
    expect(rec.requestBody.intent).toBe('AUTHORIZE');
  });

  test('authorize before the buyer approved -> GatewayError ORDER_NOT_APPROVED (422)', async () => {
    const rec = tape('POST', '/v2/checkout/orders/');
    expect(rec.path).toMatch(/\/authorize$/);
    const { gw } = gwWith([{ match: /^POST \/v2\/checkout\/orders\/.+\/authorize$/, reply: { status: rec.status, body: rec.body } }]);
    const err = await gw.authorizeOrder('ANY', 'authorize:deal_1:reel1').catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.code).toBe('ORDER_NOT_APPROVED');
    expect(err.status).toBe(422);
    expect(err.details.debug_id).toBeTruthy();
  });

  test('get order', async () => {
    const rec = tape('GET', '/v2/checkout/orders/');
    const { gw } = gwWith([{ match: /^GET \/v2\/checkout\/orders\//, reply: { status: rec.status, body: rec.body } }]);
    expect(await gw.getOrder(rec.body.id)).toEqual({ orderId: rec.body.id, status: 'PAYER_ACTION_REQUIRED', authorizationId: undefined });
  });

  test('draft invoice from the rate card', async () => {
    const rec = tape('POST', '/v2/invoicing/invoices');
    const { gw, calls } = gwWith([{ match: 'POST /v2/invoicing/invoices', reply: { status: rec.status, body: rec.body } }]);
    const r = await gw.createInvoiceDraft({ currency: 'USD', note: 'n', items: [{ name: 'Extra 15s cut', quantity: 2, unitAmountMinor: 6000 }], requestId: 'invoice:deal_1:reel1:co1' });
    expect(r).toMatchObject({ id: rec.body.id, status: 'DRAFT' });
    expect(calls[1].body.items[0]).toMatchObject({ quantity: '2', unit_amount: { currency_code: 'USD', value: '60.00' } });
  });

  test('webhook signature: PayPal says FAILURE -> false; malformed or foreign-cert proofs never leave the process', async () => {
    const rec = tape('POST', '/v1/notifications/verify-webhook-signature');
    expect(rec.body.verification_status).toBe('FAILURE');
    const { gw, calls } = gwWith([{ match: 'POST /v1/notifications/verify-webhook-signature', reply: { status: rec.status, body: rec.body } }], { webhookId: 'WH1' });
    const h = { 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1', 'paypal-transmission-id': 'a-b', 'paypal-transmission-sig': 'c2ln', 'paypal-transmission-time': '2026-11-02T00:00:00Z' };
    expect(await gw.verifyWebhook(h, '{"id":"WH-1"}')).toBe(false);
    expect(calls.filter((c) => c.key.includes('verify'))).toHaveLength(1);
    expect(await gw.verifyWebhook({ ...h, 'paypal-cert-url': 'https://evil.example/cert' }, '{"id":"x"}')).toBe(false);
    expect(await gw.verifyWebhook({ ...h, 'paypal-transmission-sig': undefined }, '{"id":"x"}')).toBe(false);
    expect(await gw.verifyWebhook(h, 'not json')).toBe(false);
    expect(calls.filter((c) => c.key.includes('verify'))).toHaveLength(1);
  });

  test('webhook signature: SUCCESS -> true; PayPal down -> throws (so the route answers 5xx and PayPal retries)', async () => {
    const h = { 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api-m.paypal.com/v1/notifications/certs/CERT-1', 'paypal-transmission-id': 'a-b', 'paypal-transmission-sig': 'c2ln', 'paypal-transmission-time': '2026-11-02T00:00:00Z' };
    const ok = gwWith([{ match: 'POST /v1/notifications/verify-webhook-signature', reply: { status: 200, body: { verification_status: 'SUCCESS' } } }], { webhookId: 'WH1' });
    expect(await ok.gw.verifyWebhook(h, '{"id":"WH-1"}')).toBe(true);
    expect(ok.calls[1].body.webhook_id).toBe('WH1');
    const down = gwWith([{ match: 'POST /v1/notifications/verify-webhook-signature', reply: { status: 503, body: { name: 'SERVICE_UNAVAILABLE' } } }], { webhookId: 'WH1' });
    await expect(down.gw.verifyWebhook(h, '{"id":"WH-1"}')).rejects.toMatchObject({ status: 503 });
    const noId = gwWith([]);
    expect(await noId.gw.verifyWebhook(h, '{"id":"WH-1"}')).toBe(false);
  });
});

describe('documented shapes for buyer-approved flows', () => {
  const AUTH = { id: '0VF52814937998046', status: 'CREATED', amount: { currency_code: 'USD', value: '400.00' }, create_time: '2026-11-02T09:00:00Z', expiration_time: '2026-12-01T09:00:00Z' };

  test('authorize an approved order -> authorization in minor units with its expiry', async () => {
    const { gw, calls } = gwWith([{ match: /authorize$/, reply: { status: 201, body: { id: 'ORD1', status: 'COMPLETED', purchase_units: [{ payments: { authorizations: [AUTH] } }] } } }]);
    const a = await gw.authorizeOrder('ORD1', 'authorize:deal_1:reel1');
    expect(a).toEqual({ authorizationId: AUTH.id, status: 'CREATED', amountMinor: 40000, createdAt: AUTH.create_time, expiresAt: AUTH.expiration_time });
    expect(calls[1].headers['PayPal-Request-Id']).toBe('authorize:deal_1:reel1');
  });

  test('authorize response without an authorization is an error, not a silent success', async () => {
    const { gw } = gwWith([{ match: /authorize$/, reply: { status: 201, body: { id: 'ORD1', status: 'COMPLETED', purchase_units: [{}] } } }]);
    await expect(gw.authorizeOrder('ORD1', 'k')).rejects.toMatchObject({ code: 'NO_AUTHORIZATION' });
  });

  test('reauthorize -> new authorization id', async () => {
    const { gw } = gwWith([{ match: /reauthorize$/, reply: { status: 201, body: { ...AUTH, id: '8AA831015G517922L' } } }]);
    const a = await gw.reauthorize(AUTH.id, 'reauthorize:deal_1:reel1:1');
    expect(a.authorizationId).toBe('8AA831015G517922L');
    expect(a.amountMinor).toBe(40000);
  });

  test('partial and final capture send final_capture and map the amount', async () => {
    const { gw, calls } = gwWith([
      { match: /capture$/, reply: (c) => ({ status: 201, body: { id: c.body.final_capture ? 'CAPF' : 'CAPP', status: 'COMPLETED', amount: c.body.amount, final_capture: c.body.final_capture } }) },
    ]);
    const p = await gw.capture(AUTH.id, { amountMinor: 10000, currency: 'USD', finalCapture: false, invoiceId: 'deal_1-reel1-partial_capture', requestId: 'partial_capture:deal_1:reel1:kill_fee' });
    expect(p).toEqual({ captureId: 'CAPP', status: 'COMPLETED', amountMinor: 10000, finalCapture: false });
    const f = await gw.capture(AUTH.id, { amountMinor: 30000, currency: 'USD', finalCapture: true, requestId: 'capture:deal_1:reel1' });
    expect(f.finalCapture).toBe(true);
    const bodies = calls.filter((c) => c.key.endsWith('/capture')).map((c) => c.body);
    expect(bodies.map((b) => b.amount.value)).toEqual(['100.00', '300.00']);
  });

  test('capture above the authorization -> PayPal error surfaces with its issue code', async () => {
    const { gw } = gwWith([{ match: /capture$/, reply: { status: 422, body: { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'MAX_CAPTURE_AMOUNT_EXCEEDED', description: 'Capture amount exceeds allowable limit.' }], debug_id: 'd1' } } }]);
    await expect(gw.capture(AUTH.id, { amountMinor: 99999, currency: 'USD', finalCapture: true, requestId: 'k' })).rejects.toMatchObject({ code: 'MAX_CAPTURE_AMOUNT_EXCEEDED', status: 422 });
  });

  test('void returns 204 with no body', async () => {
    const { gw, calls } = gwWith([{ match: /void$/, reply: { status: 204, body: null } }]);
    expect(await gw.voidAuthorization(AUTH.id, 'void:deal_1:reel1:x')).toEqual({ id: AUTH.id, status: 'VOIDED' });
    expect(calls[1].body).toBeUndefined();
  });

  test('refund and payout', async () => {
    const { gw, calls } = gwWith([
      { match: /refund$/, reply: { status: 201, body: { id: 'REF1', status: 'COMPLETED' } } },
      { match: 'POST /v1/payments/payouts', reply: { status: 201, body: { batch_header: { payout_batch_id: 'PB1', batch_status: 'PENDING' } } } },
    ]);
    expect(await gw.refund('CAPF', { amountMinor: 500, currency: 'USD', requestId: 'refund:x' })).toEqual({ id: 'REF1', status: 'COMPLETED' });
    expect(await gw.payout({ senderBatchId: 'payout:deal_1:reel1:ravi@example.com', emailSubject: 's', items: [{ email: 'ravi@example.com', amountMinor: 28000, currency: 'USD', note: 'n', senderItemId: 'reel1-u' }] })).toEqual({ id: 'PB1', status: 'PENDING' });
    const p = calls.find((c) => c.key === 'POST /v1/payments/payouts').body;
    expect(p.sender_batch_header.sender_batch_id).toBe('payout:deal_1:reel1:ravi@example.com');
    expect(p.items[0]).toMatchObject({ recipient_type: 'EMAIL', receiver: 'ravi@example.com', amount: { currency: 'USD', value: '280.00' } });
  });

  test('one OAuth token is reused across calls; OAuth failure is a GatewayError', async () => {
    const { gw, calls } = gwWith([{ match: /void$/, reply: { status: 204, body: null } }]);
    await gw.voidAuthorization('A', 'k1');
    await gw.voidAuthorization('B', 'k2');
    expect(calls.filter((c) => c.key === 'POST /v1/oauth2/token')).toHaveLength(1);
    const bad = makeRestGateway({ clientId: 'x', clientSecret: 'y', fetchImpl: fakeFetch([{ match: 'POST /v1/oauth2/token', reply: { status: 401, body: { error: 'invalid_client' } } }]).impl });
    await expect(bad.getOrder('O')).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });
});

const live = process.env.PAYPAL_SANDBOX_LIVE === '1' ? describe : describe.skip;
live('live sandbox (PAYPAL_SANDBOX_LIVE=1, needs PAYPAL_CLIENT_ID/SECRET)', () => {
  test('create order + invoice draft against the real sandbox', async () => {
    const gw = makeRestGateway({ clientId: process.env.PAYPAL_CLIENT_ID, clientSecret: process.env.PAYPAL_CLIENT_SECRET });
    const o = await gw.createAuthorizeOrder({ amountMinor: 1000, currency: 'USD', referenceId: 'live:test', customId: 'live:test', description: 'live test', returnUrl: 'https://example.com/r', cancelUrl: 'https://example.com/c', requestId: `live-${Date.now()}` });
    expect(o.approveUrl).toBeTruthy();
    await expect(gw.authorizeOrder(o.orderId, `live-a-${Date.now()}`)).rejects.toMatchObject({ code: 'ORDER_NOT_APPROVED' });
  });
});
