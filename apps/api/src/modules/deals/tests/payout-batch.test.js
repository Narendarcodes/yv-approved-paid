/**
 * Crew payouts as ONE PayPal Payouts batch per release, over HTTP + Mongo:
 * the review clock's partial release and grace release are two batches that
 * add up to the milestone; running a step again never makes a second batch;
 * PAYOUT_NOT_AVAILABLE (India sandbox) and PAYOUTS_MODE=simulated record a
 * labelled simulated batch; and the receipts endpoint shows the brand and deal
 * managers every line, a crew member only their own.
 */
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../../../app');
const { seedDefaultRoles } = require('../../../seed/roles');
const { configureDeals, dealService } = require('../service.cts');
const { makeMockGateway, GatewayError } = require('../paypal.cts');
const { mongoLedger } = require('../service.cts');
const { engine } = require('../engine.cts');
const { verifyChain, totals } = require('../engine.cts').ledger;
const { terms: baseTerms, T0, DAY } = require('./fixtures');

const PASSWORD = 'P@ssw0rd-payout-batch';
const MIN = 60 * 1000;
let now = T0 + 20 * DAY;
let gw;
let orgId;
const U = {};

const auth = (u) => ({ Authorization: `Bearer ${u.token}` });
const iso = () => new Date(now).toISOString();
const base = () => `/api/v1/organizations/${orgId}/deals`;
const M = (dealId, key = 'reel1') => `${base()}/${dealId}/milestones/${key}`;

async function user(key, role) {
  const email = `${key}@payout-batch.example.com`;
  await request(app).post('/api/v1/auth/register').send({ name: key, email, password: PASSWORD });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  const out = { token: login.body.data.accessToken, userId: login.body.data.user._id, email };
  if (role) {
    const add = await request(app)
      .post(`/api/v1/organizations/${orgId}/members`)
      .set(auth(U.admin))
      .send({ email, role });
    expect(add.statusCode).toBe(201);
  }
  return out;
}

/** reel1 with the given team (and optional review clock); styleSample off. */
function dealTerms({ clock, payees, amountMinor } = {}) {
  const t = baseTerms();
  t.client = { ...t.client, userId: U.client.userId, country: 'IN' };
  t.worker = { ...t.worker, userId: U.worker.userId };
  t.milestones = [
    { ...t.milestones[0], styleSample: false, ...(amountMinor ? { amountMinor } : {}) },
  ];
  t.milestones[0].payees = payees || [
    { userId: U.worker.userId, email: 'ravi@example.com', shareBp: 7000, displayName: 'Leo' },
    { userId: U.motion.userId, email: 'sana@example.com', shareBp: 3000, displayName: 'Maya' },
  ];
  if (clock) t.milestones[0].clock = clock;
  return t;
}
const CLOCK = () => ({
  reviewWindowBusinessDays: 3,
  partialReleasePct: 50,
  graceBusinessDays: 3,
  includedRevisionRounds: 1,
});

async function signedAndFunded(t, gateway = gw) {
  const r = await request(app).post(base()).set(auth(U.worker)).send({ terms: t });
  expect(r.status).toBe(201);
  expect(r.body.data.problems).toEqual([]);
  const dealId = r.body.data.id;
  const h = r.body.data.termsHashNow;
  await request(app)
    .post(`${base()}/${dealId}/sign`)
    .set(auth(U.client))
    .send({ termsHash: h })
    .expect(200);
  await request(app)
    .post(`${base()}/${dealId}/sign`)
    .set(auth(U.worker))
    .send({ termsHash: h })
    .expect(200);
  const f = await request(app)
    .post(`${M(dealId)}/fund`)
    .set(auth(U.client))
    .expect(200);
  gateway.approveOrder(f.body.data.milestones[0].funding.orderId);
  await request(app)
    .post(`${M(dealId)}/fund/confirm`)
    .set(auth(U.client))
    .expect(200);
  return dealId;
}
async function deliver(dealId, versionId = 'v1') {
  await request(app)
    .post(`${M(dealId)}/versions`)
    .set(auth(U.worker))
    .send({ versionId, sha256: versionId.padEnd(64, 'a').slice(0, 64) })
    .expect(200);
  return dealService().recordChecks(dealId, 'reel1', versionId, {
    reportId: `r_${versionId}`,
    passed: true,
    failed: [],
  });
}
/** Deliver, approve, and let the Money Agent capture + pay. */
async function approveAndTick(dealId) {
  await deliver(dealId);
  await request(app)
    .post(`${M(dealId)}/approve`)
    .set(auth(U.client))
    .send({ versionId: 'v1' })
    .expect(200);
  return request(app).post(`${base()}/${dealId}/tick`).set(auth(U.client)).expect(200);
}
const milestone = async (dealId) => (await dealService().get(dealId)).milestones[0];
const batchCalls = (g, dealId) =>
  g.calls.filter((c) => c.op === 'payout_batch' && c.args.senderBatchId.includes(`:${dealId}:`));
const receipts = (dealId, who) =>
  request(app)
    .get(`${M(dealId)}/payout-receipts`)
    .set(auth(who));

beforeAll(async () => {
  await require('../../../db/mongo').connect();
  await seedDefaultRoles();
  gw = makeMockGateway({ now: () => now });
  configureDeals({ gateway: gw, now: iso, publicBaseUrl: 'https://app.test' });
  U.admin = await user('admin');
  const org = await request(app)
    .post('/api/v1/organizations')
    .set(auth(U.admin))
    .send({ name: 'Payout Batch', slug: 'payout-batch' });
  orgId = org.body.data._id;
  U.worker = await user('worker', 'editor'); // the lead editor (editor role can manage deals)
  U.motion = await user('motion', 'publisher'); // a crew member without deal.manage
  U.colour = await user('colour', 'publisher');
  U.client = await user('client', 'reviewer'); // the brand
  U.manager = await user('manager', 'editor'); // a deal manager who is not on the crew
  U.bystander = await user('bystander', 'publisher');
});
afterAll(async () => {
  await mongoose.disconnect();
});

describe('one PayPal Payouts batch per release', () => {
  let clockDeal;

  test('partial release then grace release: two batches that add up to the milestone', async () => {
    clockDeal = await signedAndFunded(dealTerms({ clock: CLOCK() }));
    await deliver(clockDeal);
    const steps = Object.fromEntries(
      (await milestone(clockDeal)).clock.schedule.steps.map((s) => [s.id, Date.parse(s.atISO)]),
    );

    now = steps.release_partial + MIN;
    await dealService().advanceClocks(iso());
    let m = await milestone(clockDeal);
    expect(m.payoutBatches).toHaveLength(1);
    expect(batchCalls(gw, clockDeal)).toHaveLength(1);
    expect(batchCalls(gw, clockDeal)[0].args.senderBatchId).toBe(
      `payout:${clockDeal}:reel1:release_partial`,
    );
    expect(batchCalls(gw, clockDeal)[0].args.items.map((i) => [i.receiver, i.amountCents])).toEqual(
      [
        ['ravi@example.com', 14000],
        ['sana@example.com', 6000],
      ],
    );

    now = steps.release_grace + MIN;
    await dealService().advanceClocks(iso());
    m = await milestone(clockDeal);
    expect(m.state).toBe('PAID_OUT');
    expect(
      m.payoutBatches.map((b) => [b.step, b.senderBatchId, b.amountMinor, b.simulated]),
    ).toEqual([
      ['release_partial', `payout:${clockDeal}:reel1:release_partial`, 20000, true],
      ['release_grace', `payout:${clockDeal}:reel1:release_grace`, 20000, true],
    ]);
    expect(m.payoutBatches.reduce((a, b) => a + b.amountMinor, 0)).toBe(40000);
    expect(m.paidOutMinor).toBe(40000);
    expect(batchCalls(gw, clockDeal)).toHaveLength(2); // two releases, two PayPal calls, never one per payee
    const paid = (uid) =>
      m.payouts.filter((p) => p.userId === uid).reduce((a, p) => a + p.amountMinor, 0);
    expect(paid(U.worker.userId)).toBe(28000);
    expect(paid(U.motion.userId)).toBe(12000);

    // one ledger line per member per batch, each naming its batch and labelled simulated (mock gateway)
    const l = await dealService().ledgerOf(clockDeal, orgId);
    expect(verifyChain(l.entries).ok).toBe(true);
    const lines = l.entries.filter((e) => e.type === 'payout');
    expect(lines).toHaveLength(4);
    expect(lines.every((e) => /^Simulated payout: /.test(e.explanation))).toBe(true);
    expect(lines.map((e) => e.paypalRef)).toEqual([
      m.payoutBatches[0].batchId,
      m.payoutBatches[0].batchId,
      m.payoutBatches[1].batchId,
      m.payoutBatches[1].batchId,
    ]);
    expect(totals(l.entries).paidOutMinor).toBe(40000);
  });

  test('running the same step twice still gives one batch', async () => {
    const before = batchCalls(gw, clockDeal).length;
    expect((await dealService().runClockStep(clockDeal, 'reel1', 'release_partial')).out.ran).toBe(
      false,
    );
    expect((await dealService().runClockStep(clockDeal, 'reel1', 'release_grace')).out.ran).toBe(
      false,
    );
    await dealService().advanceClocks(iso());
    await request(app).post(`${base()}/${clockDeal}/tick`).set(auth(U.client)).expect(200);

    // the Money Agent forced to send the partial batch again: policy refuses it (P5), PayPal is never called
    const deal = await dealService().get(clockDeal);
    const b = deal.milestones[0].payoutBatches[0];
    const again = {
      kind: 'payout',
      milestoneKey: 'reel1',
      step: 'release_partial',
      amountMinor: b.amountMinor,
      items: b.items.map((i) => ({ userId: i.userId, email: i.email, amountMinor: i.amountMinor })),
    };
    const r = await engine.execute(
      { gateway: gw, ledger: mongoLedger, now: iso, returnUrl: () => ({}) },
      deal,
      again,
    );
    expect(r.result.outcome).toBe('blocked');
    expect(r.result.violations.map((v) => v.rule)).toContain('P5_already_ran');
    expect(batchCalls(gw, clockDeal)).toHaveLength(before);
    const m = await milestone(clockDeal);
    expect(m.payoutBatches).toHaveLength(2);
    expect(m.paidOutMinor).toBe(40000);

    // and PayPal-side: the same sender_batch_id returns the same batch
    const one = await gw.createPayoutBatch({ senderBatchId: 'payout:x:reel1:approve', items: [] });
    const two = await gw.createPayoutBatch({ senderBatchId: 'payout:x:reel1:approve', items: [] });
    expect(two.batchId).toBe(one.batchId);
  });

  test('3-way 33.33% split of $99.99: one batch, exact cents, leftover to the lead', async () => {
    const dealId = await signedAndFunded(
      dealTerms({
        amountMinor: 9999,
        payees: [
          {
            userId: U.motion.userId,
            email: 'sana@example.com',
            shareBp: 3333,
            displayName: 'Maya',
          },
          {
            userId: U.worker.userId,
            email: 'ravi@example.com',
            shareBp: 3333,
            displayName: 'Leo',
          },
          {
            userId: U.colour.userId,
            email: 'meena@example.com',
            shareBp: 3334,
            displayName: 'Meena',
          },
        ],
      }),
    );
    const t = await approveAndTick(dealId);
    expect(t.body.data.results.map((x) => `${x.entry.type}:${x.outcome}`)).toEqual([
      'capture:done',
      'payout:done',
    ]);
    const m = await milestone(dealId);
    expect(m.state).toBe('PAID_OUT');
    expect(m.payoutBatches).toHaveLength(1);
    expect(m.payoutBatches[0].step).toBe('approve');
    expect(m.payoutBatches[0].senderBatchId).toBe(`payout:${dealId}:reel1:approve`);
    // floor(9999 * 33.33%) = 3332, floor(9999 * 33.34%) = 3333, the 2 cents left go to the worker (lead)
    expect(m.payoutBatches[0].items.map((i) => [i.displayName, i.amountMinor])).toEqual([
      ['Maya', 3332],
      ['Leo', 3334],
      ['Meena', 3333],
    ]);
    expect(m.paidOutMinor).toBe(9999);
  });
});

describe('real vs simulated payouts', () => {
  /** A mock PayPal that looks like the sandbox and answers Payouts the way we tell it. */
  function sandboxLike(createPayoutBatch) {
    const g = makeMockGateway({ now: () => now });
    g.name = 'paypal-sandbox';
    g.batchCalls = [];
    g.createPayoutBatch = async (input) => {
      g.batchCalls.push(input);
      return createPayoutBatch(input);
    };
    return g;
  }
  afterAll(() => configureDeals({ gateway: gw, now: iso, publicBaseUrl: 'https://app.test' }));

  test('PAYOUTS_MODE=real + PAYOUT_NOT_AVAILABLE falls back to a labelled simulated batch', async () => {
    const g = sandboxLike(async () => {
      throw new GatewayError(
        'PAYOUT_NOT_AVAILABLE',
        'You live in a country that is not allowed to send this payout.',
        403,
      );
    });
    configureDeals({
      gateway: g,
      now: iso,
      publicBaseUrl: 'https://app.test',
      payoutsMode: 'real',
    });
    const dealId = await signedAndFunded(dealTerms(), g);
    await approveAndTick(dealId);
    expect(g.batchCalls).toHaveLength(1); // PayPal was asked once, for the whole crew
    expect(g.batchCalls[0].senderBatchId).toBe(`payout:${dealId}:reel1:approve`);
    const m = await milestone(dealId);
    expect(m.state).toBe('PAID_OUT');
    const b = m.payoutBatches[0];
    expect(b.simulated).toBe(true);
    expect(b.batchId).toMatch(/^SIM-BATCH-/);
    expect(b.reason).toMatch(/PayPal sandbox: Payouts are not available.*PAYOUT_NOT_AVAILABLE/);
    expect(m.payouts.every((p) => p.simulated === true && p.batchId === b.batchId)).toBe(true);
    const lines = (await dealService().ledgerOf(dealId, orgId)).entries.filter(
      (e) => e.type === 'payout',
    );
    expect(lines.map((e) => e.amountMinor)).toEqual([28000, 12000]);
    for (const e of lines)
      expect(e.explanation).toMatch(/^Simulated payout: .*PAYOUT_NOT_AVAILABLE/);
  });

  test('PAYOUTS_MODE=real sends one real batch; any other PayPal error is not hidden', async () => {
    const g = sandboxLike(async () => ({ batchId: 'REALBATCH7', status: 'PENDING' }));
    configureDeals({
      gateway: g,
      now: iso,
      publicBaseUrl: 'https://app.test',
      payoutsMode: 'real',
    });
    const dealId = await signedAndFunded(dealTerms(), g);
    await approveAndTick(dealId);
    const m = await milestone(dealId);
    expect(m.payoutBatches.map((b) => [b.batchId, b.simulated])).toEqual([['REALBATCH7', false]]);
    const lines = (await dealService().ledgerOf(dealId, orgId)).entries.filter(
      (e) => e.type === 'payout',
    );
    for (const e of lines) {
      expect(e.explanation).toMatch(/^Paid .* in one PayPal Payouts batch REALBATCH7/);
      expect(e.explanation).not.toMatch(/simulated/i);
    }

    const g2 = sandboxLike(async () => {
      throw new GatewayError('INSUFFICIENT_FUNDS', 'Sender does not have sufficient funds.', 422);
    });
    configureDeals({
      gateway: g2,
      now: iso,
      publicBaseUrl: 'https://app.test',
      payoutsMode: 'real',
    });
    const d2 = await signedAndFunded(dealTerms(), g2);
    const t = await approveAndTick(d2);
    expect(t.body.data.results.map((x) => `${x.entry.type}:${x.outcome}`)).toEqual([
      'capture:done',
      'blocked:failed',
    ]);
    const m2 = await milestone(d2);
    expect(m2.state).toBe('CAPTURED');
    expect(m2.paidOutMinor).toBe(0);
    expect(m2.payoutBatches || []).toEqual([]);
  });

  test('default PAYOUTS_MODE=simulated never calls PayPal Payouts', async () => {
    const g = sandboxLike(async () => {
      throw new Error('Payouts must not be called in simulated mode');
    });
    configureDeals({ gateway: g, now: iso, publicBaseUrl: 'https://app.test' });
    const dealId = await signedAndFunded(dealTerms(), g);
    await approveAndTick(dealId);
    expect(g.batchCalls).toHaveLength(0);
    const m = await milestone(dealId);
    expect(m.state).toBe('PAID_OUT');
    expect(m.payoutBatches[0]).toMatchObject({ simulated: true, amountMinor: 40000 });
    expect(m.payoutBatches[0].reason).toMatch(/PAYOUTS_MODE=simulated/);
  });
});

describe('GET .../payout-receipts', () => {
  let dealId;
  beforeAll(async () => {
    configureDeals({ gateway: gw, now: iso, publicBaseUrl: 'https://app.test' });
    dealId = await signedAndFunded(dealTerms());
    await approveAndTick(dealId);
  });

  test('the brand sees every member line with share, step, batch and simulated flag', async () => {
    const r = await receipts(dealId, U.client);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.scope).toBe('all');
    expect(
      d.lines.map((l) => [l.displayName, l.amountMinor, l.shareBp, l.step, l.simulated]),
    ).toEqual([
      ['Leo', 28000, 7000, 'approve', true],
      ['Maya', 12000, 3000, 'approve', true],
    ]);
    expect(new Set(d.lines.map((l) => l.batchId)).size).toBe(1);
    expect(d.batches).toHaveLength(1);
    expect(d.paidOutMinor).toBe(40000);
    expect(d.me).toBeNull();
  });

  test('an org admin who is not on the crew sees every line', async () => {
    const r = await receipts(dealId, U.admin);
    expect(r.status).toBe(200);
    expect(r.body.data.scope).toBe('all');
    expect(r.body.data.lines).toHaveLength(2);
  });

  test('a deal manager who is not on the deal gets a plain 404 (deal.manage is a crew grant)', async () => {
    const r = await receipts(dealId, U.manager);
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toMatch(/"amountMinor":(12000|28000)\b/);
  });

  test('a crew member sees only their own line, even the lead editor who can manage deals', async () => {
    const sana = (await receipts(dealId, U.motion)).body.data;
    expect(sana.scope).toBe('own');
    expect(sana.lines.map((l) => [l.displayName, l.amountMinor])).toEqual([['Maya', 12000]]);
    expect(sana.me).toMatchObject({
      shareBp: 3000,
      shareOfMilestoneMinor: 12000,
      paidMinor: 12000,
    });
    expect(sana.team).toHaveLength(1);
    expect(sana.batches).toEqual([]);
    expect(sana.paidOutMinor).toBe(12000);

    const ravi = (await receipts(dealId, U.worker)).body.data;
    expect(ravi.scope).toBe('own');
    expect(ravi.lines.map((l) => l.displayName)).toEqual(['Leo']);
    expect(ravi.me).toMatchObject({ shareBp: 7000, shareOfMilestoneMinor: 28000, role: 'lead' });
  });

  test('anyone else in the org gets a 404; another org cannot reach it', async () => {
    expect((await receipts(dealId, U.bystander)).status).toBe(404);
    expect(
      (
        await request(app)
          .get(`${M(dealId, 'nope')}/payout-receipts`)
          .set(auth(U.client))
      ).status,
    ).toBe(404);
    const other = await request(app)
      .post('/api/v1/organizations')
      .set(auth(U.bystander))
      .send({ name: 'Other', slug: 'other-payout' });
    const r = await request(app)
      .get(
        `/api/v1/organizations/${other.body.data._id}/deals/${dealId}/milestones/reel1/payout-receipts`,
      )
      .set(auth(U.bystander));
    expect(r.status).toBe(404);
  });
});
