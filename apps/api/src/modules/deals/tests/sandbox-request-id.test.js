/**
 * PayPal-Request-Id on real sandbox money calls is scoped to the PayPal object.
 *
 * Found live on Nov 4, 2026: a demo reset in the same process rebuilt the deal
 * with the same idempotency key ("capture:deal_demo_diwali:reel1:..."), but on a
 * fresh pooled authorization. PayPal saw the same PayPal-Request-Id and replayed
 * the previous hold's capture, so the new authorization was never captured.
 */
const { makeSandboxGateway } = require('../paypal.cts');

function recorder() {
  const seen = [];
  const impl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const rid = (init.headers || {})['PayPal-Request-Id'];
    seen.push({ path, rid });
    const body =
      path === '/v1/oauth2/token'
        ? { access_token: 'tok', token_type: 'Bearer', expires_in: 32400 }
        : {
            id: `ID${seen.length}`,
            status: 'COMPLETED',
            amount: { currency_code: 'USD', value: '1.00' },
          };
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return { impl, seen };
}

const gw = (impl) =>
  makeSandboxGateway({ clientId: 'id', clientSecret: 's', fetchImpl: impl, simulate: true });

const ridFor = (seen, re) => seen.filter((c) => re.test(c.path)).map((c) => c.rid);

test('same idempotency key on two different authorizations -> two different PayPal-Request-Ids', async () => {
  const r = recorder();
  const g = gw(r.impl);
  const input = {
    amountMinor: 40000,
    currency: 'USD',
    finalCapture: true,
    requestId: 'capture:deal_demo_diwali:reel1:v2',
  };
  await g.capture('19214950SY9310030', input).catch(() => {});
  await g.capture('5J4765863X083353Y', input).catch(() => {});
  await g.capture('5J4765863X083353Y', input).catch(() => {}); // a retry on the same hold
  const ids = ridFor(r.seen, /\/capture$/);
  expect(ids).toHaveLength(3);
  expect(ids[0]).not.toBe(ids[1]);
  expect(ids[1]).toBe(ids[2]);
  expect(ids[1]).toContain('5J4765863X083353Y');
  expect(ids.every((x) => x.length <= 108)).toBe(true);
});

test('void, reauthorize and refund are scoped the same way', async () => {
  const r = recorder();
  const g = gw(r.impl);
  await g.voidAuthorization('AAAA', 'void:k').catch(() => {});
  await g.voidAuthorization('BBBB', 'void:k').catch(() => {});
  await g.reauthorize('AAAA', 'reauth:k').catch(() => {});
  await g.reauthorize('BBBB', 'reauth:k').catch(() => {});
  await g
    .refund('CAP1', { amountMinor: 100, currency: 'USD', requestId: 'refund:k' })
    .catch(() => {});
  await g
    .refund('CAP2', { amountMinor: 100, currency: 'USD', requestId: 'refund:k' })
    .catch(() => {});
  for (const re of [/\/void$/, /\/reauthorize$/, /\/refund$/]) {
    const ids = ridFor(r.seen, re);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
  }
});

test('a key that already names the authorization is not doubled', async () => {
  const r = recorder();
  const g = gw(r.impl);
  await g
    .voidAuthorization('1F4366324K7574252', 'void:deal_demo_diwali:reel2:1F4366324K7574252')
    .catch(() => {});
  const [id] = ridFor(r.seen, /\/void$/);
  expect(id.split('1F4366324K7574252')).toHaveLength(2);
});

test('a capture invoice_id is tied to the authorization (PayPal refuses a repeated invoice_id)', async () => {
  const bodies = [];
  const r = recorder();
  const impl = async (url, init = {}) => {
    if (/\/capture$/.test(new URL(url).pathname)) bodies.push(JSON.parse(init.body));
    return r.impl(url, init);
  };
  const g = gw(impl);
  const input = {
    amountMinor: 40000,
    currency: 'USD',
    finalCapture: true,
    invoiceId: 'deal_demo_diwali-reel1-capture',
    requestId: 'capture:deal_demo_diwali:reel1:v2',
  };
  await g.capture('19214950SY9310030', input).catch(() => {});
  await g.capture('7XX30364PR417532F', input).catch(() => {});
  expect(bodies.map((b) => b.invoice_id)).toEqual([
    'deal_demo_diwali-reel1-capture-19214950SY9310030',
    'deal_demo_diwali-reel1-capture-7XX30364PR417532F',
  ]);
});
