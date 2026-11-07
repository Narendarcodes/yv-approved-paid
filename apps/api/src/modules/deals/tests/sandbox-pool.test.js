/**
 * Real PayPal sandbox money for the judge demo: a pool of authorizations a
 * sandbox buyer approved ahead of time (pool.cts), drawn by the demo seed, then
 * captured and voided with real sandbox calls. PayPal is faked here by a small
 * stateful stand-in that follows the Orders v2 / Payments v2 rules we rely on
 * (approve -> authorize -> capture | void, one reauthorization).
 */
const mongoose = require('mongoose');
const { configureDeals, dealService } = require('../service.cts');
const { makeMockGateway, makeSandboxGateway } = require('../paypal.cts');
const { DEMO, seedDealDemo, untouchedRealDemo } = require('../demo.cts');
const { mongoPool, claimPoolOrder, poolStatus } = require('../pool.cts');
const { PaypalAuthPool } = require('../pool.cts');
const { engine } = require('../engine.cts');
const { harness, signedAndFunded, ms: msOf, DAY, HOUR } = require('./fixtures');

const ms = (d, k) => d.milestones.find((m) => m.key === k);

/** A stateful fake of the PayPal sandbox (only what the deal flow calls). */
function fakePaypal() {
  const orders = new Map();
  const auths = new Map();
  const calls = [];
  let n = 0;
  const id = (p) => `${p}${String(++n).padStart(17 - p.length, '0')}`;
  const reply = (status, body) => ({
    ok: status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
  const money = (minor) => ({ currency_code: 'USD', value: (minor / 100).toFixed(2) });
  const authView = (a) => ({
    id: a.id,
    status: a.status,
    amount: money(a.amountMinor),
    create_time: a.createdAt,
    expiration_time: a.expiresAt,
  });
  const orderView = (o) => ({
    id: o.id,
    intent: 'AUTHORIZE',
    status: o.status,
    purchase_units: [
      {
        custom_id: o.customId,
        amount: money(o.amountMinor),
        payments: o.authId ? { authorizations: [authView(auths.get(o.authId))] } : undefined,
      },
    ],
  });
  const impl = async (url, init = {}) => {
    const key = `${init.method || 'GET'} ${new URL(url).pathname}`;
    calls.push(key);
    let body = {};
    try {
      body = init.body ? JSON.parse(init.body) : {};
    } catch {
      body = {};
    }
    let m;
    if (key === 'POST /v1/oauth2/token')
      return reply(200, { access_token: 'tok', token_type: 'Bearer', expires_in: 32400 });
    if (key === 'POST /v2/checkout/orders') {
      const pu = body.purchase_units[0];
      const o = {
        id: id('ORD'),
        status: 'PAYER_ACTION_REQUIRED',
        customId: pu.custom_id,
        amountMinor: Math.round(Number(pu.amount.value) * 100),
      };
      orders.set(o.id, o);
      return reply(201, {
        id: o.id,
        status: o.status,
        links: [
          { rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${o.id}` },
        ],
      });
    }
    if ((m = key.match(/^GET \/v2\/checkout\/orders\/(\w+)$/))) {
      const o = orders.get(m[1]);
      return o ? reply(200, orderView(o)) : reply(404, { name: 'RESOURCE_NOT_FOUND' });
    }
    if ((m = key.match(/^POST \/v2\/checkout\/orders\/(\w+)\/authorize$/))) {
      const o = orders.get(m[1]);
      if (!o || o.status !== 'APPROVED')
        return reply(422, {
          name: 'UNPROCESSABLE_ENTITY',
          details: [
            {
              issue: 'ORDER_NOT_APPROVED',
              description: 'Payer has not yet approved the Order for payment.',
            },
          ],
        });
      const t = Date.now();
      const a = {
        id: id('AUTH'),
        status: 'CREATED',
        amountMinor: o.amountMinor,
        capturedMinor: 0,
        createdAt: new Date(t).toISOString(),
        expiresAt: new Date(t + 29 * DAY).toISOString(),
        reauths: 0,
      };
      auths.set(a.id, a);
      o.status = 'COMPLETED';
      o.authId = a.id;
      return reply(201, orderView(o));
    }
    if ((m = key.match(/^GET \/v2\/payments\/authorizations\/(\w+)$/))) {
      const a = auths.get(m[1]);
      return a ? reply(200, authView(a)) : reply(404, { name: 'RESOURCE_NOT_FOUND' });
    }
    if ((m = key.match(/^POST \/v2\/payments\/authorizations\/(\w+)\/capture$/))) {
      const a = auths.get(m[1]);
      const amt = Math.round(Number(body.amount.value) * 100);
      if (!a || !['CREATED', 'PARTIALLY_CAPTURED'].includes(a.status))
        return reply(422, {
          name: 'UNPROCESSABLE_ENTITY',
          details: [{ issue: 'AUTHORIZATION_ALREADY_COMPLETED', description: 'done' }],
        });
      if (a.capturedMinor + amt > a.amountMinor)
        return reply(422, {
          name: 'UNPROCESSABLE_ENTITY',
          details: [{ issue: 'MAX_CAPTURE_AMOUNT_EXCEEDED', description: 'too much' }],
        });
      a.capturedMinor += amt;
      a.status = body.final_capture ? 'CAPTURED' : 'PARTIALLY_CAPTURED';
      return reply(201, {
        id: id('CAP'),
        status: 'COMPLETED',
        amount: money(amt),
        final_capture: !!body.final_capture,
      });
    }
    if ((m = key.match(/^POST \/v2\/payments\/authorizations\/(\w+)\/void$/))) {
      const a = auths.get(m[1]);
      if (!a || !['CREATED', 'PARTIALLY_CAPTURED'].includes(a.status))
        return reply(422, {
          name: 'UNPROCESSABLE_ENTITY',
          details: [{ issue: 'CANNOT_BE_VOIDED', description: 'no' }],
        });
      a.status = 'VOIDED';
      return reply(200, { id: a.id, status: 'VOIDED' });
    }
    if ((m = key.match(/^POST \/v2\/payments\/authorizations\/(\w+)\/reauthorize$/))) {
      const a = auths.get(m[1]);
      if (!a || a.reauths >= 1)
        return reply(422, {
          name: 'UNPROCESSABLE_ENTITY',
          details: [{ issue: 'REAUTHORIZATION_NOT_ALLOWED', description: 'once only' }],
        });
      a.reauths += 1;
      const b = { ...a, id: id('AUTH'), createdAt: new Date().toISOString(), reauths: 1 };
      auths.set(b.id, b);
      return reply(201, authView(b));
    }
    if (key === 'POST /v1/payments/payouts')
      return reply(403, {
        name: 'PAYOUT_NOT_AVAILABLE',
        message: 'You live in a country that is not allowed to send this payout.',
      });
    if (key === 'POST /v2/invoicing/invoices')
      return reply(201, { id: 'INV2-AB12-CD34-EF56-GH78', status: 'DRAFT' });
    if (/^POST \/v2\/invoicing\/invoices\/.+\/send$/.test(key))
      return reply(200, {
        href: 'https://www.sandbox.paypal.com/invoice/p/#INV2-AB12-CD34-EF56-GH78',
      });
    throw new Error(`unexpected PayPal call ${key}`);
  };
  /** What the sandbox buyer does on the approve page. */
  const approve = (orderId) => {
    orders.get(orderId).status = 'APPROVED';
  };
  return { impl, calls, orders, auths, approve };
}

const poolGateway = (pp) =>
  makeSandboxGateway({
    clientId: 'id',
    clientSecret: 's',
    fetchImpl: pp.impl,
    simulate: true,
    pool: mongoPool,
    poolFor: (o) => o.referenceId.startsWith('deal_demo_'),
  });

async function addToPool(gw, pp, amountMinor) {
  const o = await gw.rest.createAuthorizeOrder({
    amountMinor,
    currency: 'USD',
    referenceId: `pool:${amountMinor}`,
    customId: `yv-auth-pool:${amountMinor}`,
    description: 'demo pool',
    returnUrl: 'https://api/r',
    cancelUrl: 'https://api/c',
    requestId: `pool:${Math.random()}`,
  });
  pp.approve(o.orderId);
  return claimPoolOrder(gw.rest, o.orderId);
}

beforeAll(async () => {
  await require('../../../db/mongo').connect();
});
afterAll(async () => {
  await mongoose.disconnect();
});
beforeEach(async () => {
  await PaypalAuthPool.deleteMany({});
});

describe('demo pool: claiming a pre-approved sandbox order', () => {
  test('only our approved pool orders join; claiming twice is a no-op', async () => {
    const pp = fakePaypal();
    const gw = poolGateway(pp);
    const o = await gw.rest.createAuthorizeOrder({
      amountMinor: 40000,
      currency: 'USD',
      referenceId: 'pool',
      customId: 'yv-auth-pool:40000',
      description: 'x',
      returnUrl: 'https://r',
      cancelUrl: 'https://c',
      requestId: 'p1',
    });
    await expect(claimPoolOrder(gw.rest, o.orderId)).rejects.toMatchObject({
      code: 'order_not_approved',
      status: 409,
    });
    pp.approve(o.orderId);
    const c = await claimPoolOrder(gw.rest, o.orderId);
    expect(c).toMatchObject({
      orderId: o.orderId,
      status: 'ready',
      amountMinor: 40000,
      currency: 'USD',
      already: false,
    });
    expect(c.authorizationId).toMatch(/^AUTH/);
    expect(await claimPoolOrder(gw.rest, o.orderId)).toMatchObject({
      already: true,
      authorizationId: c.authorizationId,
    });
    expect(pp.calls.filter((k) => k.endsWith('/authorize'))).toHaveLength(1);

    const other = await gw.rest.createAuthorizeOrder({
      amountMinor: 100,
      currency: 'USD',
      referenceId: 'x',
      customId: 'deal_x:reel1',
      description: 'x',
      returnUrl: 'https://r',
      cancelUrl: 'https://c',
      requestId: 'p2',
    });
    pp.approve(other.orderId);
    await expect(claimPoolOrder(gw.rest, other.orderId)).rejects.toMatchObject({
      code: 'not_pool_order',
    });
    await expect(claimPoolOrder(gw.rest, 'not an id')).rejects.toMatchObject({
      code: 'invalid_order_id',
    });
    expect(await poolStatus()).toMatchObject({
      ready: 1,
      amounts: [{ amountMinor: 40000, ready: 1, used: 0 }],
    });
  });

  test('a drawn authorization is re-checked with PayPal; a dead one is skipped and marked invalid', async () => {
    const pp = fakePaypal();
    const gw = poolGateway(pp);
    const dead = await addToPool(gw, pp, 30000);
    const good = await addToPool(gw, pp, 30000);
    pp.auths.get(dead.authorizationId).status = 'VOIDED'; // voided elsewhere
    const o = await gw.createAuthorizeOrder({
      amountMinor: 30000,
      currency: 'USD',
      referenceId: 'deal_demo_diwali:reel2',
      customId: 'deal_demo_diwali:reel2',
      description: 'x',
      returnUrl: 'r',
      cancelUrl: 'c',
      requestId: 'o1',
    });
    expect(o.orderId).toBe(good.orderId);
    gw.simulateBuyerApproval(o.orderId); // a no-op: a buyer really approved it
    const a = await gw.authorizeOrder(o.orderId, 'a1');
    expect(a).toMatchObject({
      authorizationId: good.authorizationId,
      status: 'CREATED',
      amountMinor: 30000,
    });
    expect(a.simulated).toBeUndefined();
    expect((await PaypalAuthPool.findById(dead.orderId).lean()).status).toBe('invalid');
    // only demo deals draw from the pool; anyone else gets a fresh order and the live approve link
    const live = await gw.createAuthorizeOrder({
      amountMinor: 30000,
      currency: 'USD',
      referenceId: 'deal_42:reel1',
      customId: 'deal_42:reel1',
      description: 'x',
      returnUrl: 'r',
      cancelUrl: 'c',
      requestId: 'o2',
    });
    expect(live.approveUrl).toMatch(/sandbox\.paypal\.com\/checkoutnow/);
    await expect(gw.authorizeOrder(live.orderId, 'a2')).rejects.toMatchObject({
      code: 'ORDER_NOT_APPROVED',
    });
  });
});

describe('judge demo on real sandbox authorizations', () => {
  afterAll(async () => {
    configureDeals({ gateway: makeMockGateway() });
    await seedDealDemo({ evidenceDir: false, force: true });
  });

  test('seed draws real holds, captures reel1 for real, keeps an untouched deal on reboot, voids for real on the split; SIM- only when the pool is empty', async () => {
    const pp = fakePaypal();
    const gw = poolGateway(pp);
    for (const amt of [40000, 30000, 40000, 30000]) await addToPool(gw, pp, amt);
    configureDeals({ gateway: gw });

    const r = await seedDealDemo({ evidenceDir: false });
    let d = await dealService().get(DEMO.dealId, r.orgId);
    const pooled = await PaypalAuthPool.find({ status: 'used' }).lean();
    expect(pooled).toHaveLength(2);
    for (const key of ['reel1', 'reel2']) {
      const f = ms(d, key).funding;
      expect(f.authorizationId).toMatch(/^AUTH/);
      expect(pooled.map((p) => p.authorizationId)).toContain(f.authorizationId);
    }
    expect(ms(d, 'reel1').state).toBe('PAID_OUT');
    expect(ms(d, 'reel1').captures[0].id).toMatch(/^CAP/); // a real capture id
    expect(pp.auths.get(ms(d, 'reel1').funding.authorizationId).status).toBe('CAPTURED');
    expect(
      ms(d, 'reel1').payouts.every((p) => /^SIM-BATCH-/.test(p.batchId) && p.simulated === true),
    ).toBe(true); // payouts stay simulated
    let l = await dealService().ledgerOf(DEMO.dealId, r.orgId);
    expect(l.entries.find((e) => e.type === 'authorize').explanation).not.toMatch(/simulated/);
    expect(l.entries.find((e) => e.type === 'capture').explanation).not.toMatch(/simulated/);
    expect(untouchedRealDemo(d, Date.now())).toBe(true);

    // a reboot keeps the untouched deal (no pool draw); a reset takes a fresh pair
    expect((await seedDealDemo({ evidenceDir: false })).reused).toBe(true);
    expect(await PaypalAuthPool.countDocuments({ status: 'ready' })).toBe(2);

    // the judge (client) taps the 80% split: real partial capture, then a real void of the rest
    const reel2Auth = ms(d, 'reel2').funding.authorizationId;
    await dealService().acceptSplit(
      DEMO.dealId,
      r.orgId,
      r.judge.userId,
      'reel2',
      ms(d, 'reel2').split.worker,
    );
    await dealService().tick(DEMO.dealId, r.orgId);
    d = await dealService().get(DEMO.dealId, r.orgId);
    expect(ms(d, 'reel2').captures[0]).toMatchObject({ amountMinor: 24000 });
    expect(ms(d, 'reel2').captures[0].id).toMatch(/^CAP/);
    expect(ms(d, 'reel2').funding.status).toBe('VOIDED');
    expect(pp.auths.get(reel2Auth)).toMatchObject({ status: 'VOIDED', capturedMinor: 24000 });
    l = await dealService().ledgerOf(DEMO.dealId, r.orgId);
    expect(l.entries.find((e) => e.type === 'void')).toMatchObject({ paypalRef: reel2Auth });
    expect(l.chain.ok).toBe(true);
    expect(untouchedRealDemo(d, Date.now())).toBe(false);

    const again = await seedDealDemo({ evidenceDir: false });
    expect(again.reused).toBe(false);
    expect(await PaypalAuthPool.countDocuments({ status: 'ready' })).toBe(0);
    d = await dealService().get(DEMO.dealId, r.orgId);
    expect(ms(d, 'reel2').funding.authorizationId).not.toBe(reel2Auth);

    // pool empty: the reset still works, on a simulated approval that says so
    await seedDealDemo({ evidenceDir: false, force: true });
    d = await dealService().get(DEMO.dealId, r.orgId);
    expect(ms(d, 'reel1').funding.authorizationId).toMatch(/^SIM-AUTH-/);
    l = await dealService().ledgerOf(DEMO.dealId, r.orgId);
    expect(l.entries.find((e) => e.type === 'authorize').explanation).toMatch(
      /buyer approval simulated \(pre-approved pool empty\)/,
    );
  });
});

describe('reauthorization limit', () => {
  test('a gateway that reauthorizes once (PayPal) gets one reauthorization planned, never a second', async () => {
    const h = harness();
    h.gateway.maxReauthorizations = 1; // deps.gateway is the same object
    await signedAndFunded(h);
    h.clock.advance(3 * DAY + HOUR);
    h.deal = (await engine.tick(h.deps, h.deal)).deal;
    expect(msOf(h.deal).funding.reauthorizations).toHaveLength(1);
    h.clock.advance(4 * DAY);
    h.deal = (await engine.tick(h.deps, h.deal)).deal;
    expect(msOf(h.deal).funding.reauthorizations).toHaveLength(1);
    expect(h.ledger.rows.filter((e) => e.type === 'blocked')).toHaveLength(0);
  });
});
