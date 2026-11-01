/* Money helpers, canonical hashing, terms validation, mock PayPal rules. */
const { money, canonicalize, hashOf, validateTerms } = require('../engine.cts');
const { makeMockGateway } = require('../paypal.cts');
const { terms, T0, DAY } = require('./fixtures');

describe('money', () => {
  test('minor units round-trip', () => {
    expect(money.toMinor('400.00', 'USD')).toBe(40000);
    expect(money.toMinor('0.1', 'USD')).toBe(10);
    expect(money.toMinor('1500', 'JPY')).toBe(1500);
    expect(money.toMajor(40005, 'USD')).toBe('400.05');
    expect(money.format(1234567, 'USD')).toBe('$12,345.67');
    expect(money.format(250000, 'INR')).toBe('₹2,500.00');
  });
  test('rejects junk', () => {
    for (const bad of ['-1', '1.234', 'abc', '1e3', '']) expect(() => money.toMinor(bad, 'USD')).toThrow();
    expect(() => money.toMajor(-1, 'USD')).toThrow();
    expect(() => money.toMajor(1.5, 'USD')).toThrow();
  });
  test('percent in basis points, half-up', () => {
    expect(money.percentOf(40000, 2500)).toBe(10000);
    expect(money.percentOf(333, 5000)).toBe(167);
    expect(() => money.percentOf(100, 10001)).toThrow();
  });
});

describe('canonical hash', () => {
  test('key order does not matter; values do', () => {
    expect(canonicalize({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }));
    expect(hashOf({ a: 1 })).not.toBe(hashOf({ a: 2 }));
  });
});

describe('terms validation', () => {
  test('fixture is valid', () => expect(validateTerms(terms())).toEqual([]));
  test('catches the mistakes that would make money moves ambiguous', () => {
    const t = terms();
    t.milestones[0].payees[0].shareBp = 5000;
    t.milestones[1].amountMinor = 0;
    t.milestones[0].checklist.push({ id: 'len', text: 'dup', kind: 'check', measure: { metric: 'x', op: '<=', value: 1 } });
    t.worker.userId = t.client.userId;
    const p = validateTerms(t).join(' | ');
    expect(p).toMatch(/100%/);
    expect(p).toMatch(/typed by a person/);
    expect(p).toMatch(/unique/);
    expect(p).toMatch(/different people/);
  });
});

describe('mock PayPal follows the documented rules', () => {
  function setup() {
    let now = T0;
    const gw = makeMockGateway({ now: () => now });
    return { gw, adv: (ms) => (now += ms) };
  }
  async function authorized(gw) {
    const o = await gw.createAuthorizeOrder({ amountMinor: 10000, currency: 'USD', referenceId: 'r', customId: 'c', description: 'd', returnUrl: 'https://x', cancelUrl: 'https://y', requestId: 'o1' });
    gw.approveOrder(o.orderId);
    return gw.authorizeOrder(o.orderId, 'a1');
  }
  test('partial captures, final capture closes, cannot void after full capture', async () => {
    const { gw } = setup();
    const a = await authorized(gw);
    await gw.capture(a.authorizationId, { amountMinor: 3000, currency: 'USD', finalCapture: false, requestId: 'c1' });
    await expect(gw.capture(a.authorizationId, { amountMinor: 8000, currency: 'USD', finalCapture: true, requestId: 'c2' })).rejects.toMatchObject({ code: 'MAX_CAPTURE_AMOUNT_EXCEEDED' });
    await gw.capture(a.authorizationId, { amountMinor: 7000, currency: 'USD', finalCapture: true, requestId: 'c3' });
    await expect(gw.voidAuthorization(a.authorizationId, 'v1')).rejects.toMatchObject({ code: 'CANNOT_BE_VOIDED' });
  });
  test('same request id = same result, money moves once', async () => {
    const { gw } = setup();
    const a = await authorized(gw);
    const r1 = await gw.capture(a.authorizationId, { amountMinor: 10000, currency: 'USD', finalCapture: true, requestId: 'same' });
    const r2 = await gw.capture(a.authorizationId, { amountMinor: 10000, currency: 'USD', finalCapture: true, requestId: 'same' });
    expect(r2.captureId).toBe(r1.captureId);
  });
  test('reauthorize: too soon inside honor period, ok on day 4, refused after day 29; expired auth cannot capture', async () => {
    const { gw, adv } = setup();
    const a = await authorized(gw);
    await expect(gw.reauthorize(a.authorizationId, 'r1')).rejects.toMatchObject({ code: 'REAUTHORIZATION_TOO_SOON' });
    adv(4 * DAY);
    const b = await gw.reauthorize(a.authorizationId, 'r2');
    expect(b.authorizationId).not.toBe(a.authorizationId);
    adv(26 * DAY);
    await expect(gw.reauthorize(b.authorizationId, 'r3')).rejects.toMatchObject({ code: 'AUTHORIZATION_EXPIRED' });
    await expect(gw.capture(b.authorizationId, { amountMinor: 1, currency: 'USD', finalCapture: true, requestId: 'late' })).rejects.toMatchObject({ code: 'AUTHORIZATION_EXPIRED' });
  });
  test('webhook signature check', async () => {
    const { gw } = setup();
    const body = JSON.stringify({ id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED' });
    expect(await gw.verifyWebhook(gw.signWebhook(body), body)).toBe(true);
    expect(await gw.verifyWebhook(gw.signWebhook(body), body + ' ')).toBe(false);
    expect(await gw.verifyWebhook({}, body)).toBe(false);
  });
});
