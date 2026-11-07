/**
 * Payables board, Where's my money, and bulk approve over HTTP + Mongo:
 * who sees which rows, the dry run moves no money (and names who gets how much
 * with splitCents), the real run goes through the single-approve paths with the
 * same policy and tap rules, and a repeated bulk approve never pays twice.
 */
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../../../app');
const { seedDefaultRoles } = require('../../../seed/roles');
const { configureDeals, dealService } = require('../service.cts');
const { makeMockGateway } = require('../paypal.cts');
const { mongoLedger } = require('../lib/service.cts');
const { terms: baseTerms, T0, DAY } = require('./fixtures');

const PASSWORD = 'P@ssw0rd-payables';
let now = T0 + 20 * DAY;
let gw;
let orgId;
let otherOrgId;
const U = {};

const auth = (u) => ({ Authorization: `Bearer ${u.token}` });
const iso = () => new Date(now).toISOString();
const base = (o = orgId) => `/api/v1/organizations/${o}/deals`;
const M = (dealId, key = 'reel1') => `${base()}/${dealId}/milestones/${key}`;

async function user(key, role, org = orgId, admin = U.admin) {
  const email = `${key}@payables.example.com`;
  await request(app).post('/api/v1/auth/register').send({ name: key, email, password: PASSWORD });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  const out = { token: login.body.data.accessToken, userId: login.body.data.user._id, email };
  if (role) {
    const add = await request(app).post(`/api/v1/organizations/${org}/members`).set(auth(admin)).send({ email, role });
    expect(add.statusCode).toBe(201);
  }
  return out;
}

function dealTerms({ clock, amountMinor, title } = {}) {
  const t = baseTerms();
  if (title) t.title = title;
  t.client = { ...t.client, userId: U.client.userId, country: 'IN' };
  t.worker = { ...t.worker, userId: U.worker.userId };
  t.milestones = [{ ...t.milestones[0], styleSample: false, ...(amountMinor ? { amountMinor } : {}) }];
  t.milestones[0].payees = [
    { userId: U.worker.userId, email: 'ravi@example.com', shareBp: 7000, displayName: 'Ravi' },
    { userId: U.motion.userId, email: 'sana@example.com', shareBp: 3000, displayName: 'Sana' },
  ];
  if (clock) t.milestones[0].clock = clock;
  return t;
}
const CLOCK = () => ({ reviewWindowBusinessDays: 3, partialReleasePct: 50, graceBusinessDays: 3, includedRevisionRounds: 1 });

async function deliveredDeal(t) {
  const r = await request(app).post(base()).set(auth(U.worker)).send({ terms: t });
  expect(r.status).toBe(201);
  const dealId = r.body.data.id;
  const h = r.body.data.termsHashNow;
  await request(app).post(`${base()}/${dealId}/sign`).set(auth(U.client)).send({ termsHash: h }).expect(200);
  await request(app).post(`${base()}/${dealId}/sign`).set(auth(U.worker)).send({ termsHash: h }).expect(200);
  const f = await request(app).post(`${M(dealId)}/fund`).set(auth(U.client)).expect(200);
  gw.approveOrder(f.body.data.milestones[0].funding.orderId);
  await request(app).post(`${M(dealId)}/fund/confirm`).set(auth(U.client)).expect(200);
  await request(app).post(`${M(dealId)}/versions`).set(auth(U.worker)).send({ versionId: 'v1', sha256: 'a'.repeat(64) }).expect(200);
  await dealService().recordChecks(dealId, 'reel1', 'v1', { reportId: 'r_v1', passed: true, failed: [] });
  return dealId;
}

const moneyCalls = (dealId) =>
  gw.calls.filter((c) => ['capture', 'payout', 'payout_batch', 'void', 'refund'].includes(c.op) && JSON.stringify(c.args).includes(dealId));
const bulk = (who, items, dryRun) => request(app).post(`${base()}/payables/bulk-approve`).set(auth(who)).send({ items, dryRun });

let clockDeal;
let legacyDeal;
let bigDeal;

beforeAll(async () => {
  await require('../../../db/mongo').connect();
  await seedDefaultRoles();
  gw = makeMockGateway({ now: () => now });
  configureDeals({ gateway: gw, now: iso, publicBaseUrl: 'https://app.test' });
  U.admin = await user('admin');
  const org = await request(app).post('/api/v1/organizations').set(auth(U.admin)).send({ name: 'Payables', slug: 'payables-org' });
  orgId = org.body.data._id;
  U.worker = await user('worker', 'editor'); // lead editor; editor role manages deals
  U.motion = await user('motion', 'publisher'); // crew, no deal.manage
  U.client = await user('client', 'reviewer'); // the brand
  U.manager = await user('manager', 'editor'); // deal manager, not the brand
  U.bystander = await user('bystander', 'publisher');
  U.outsider = await user('outsider');
  const other = await request(app).post('/api/v1/organizations').set(auth(U.outsider)).send({ name: 'Other', slug: 'payables-other' });
  otherOrgId = other.body.data._id;

  clockDeal = await deliveredDeal(dealTerms({ clock: CLOCK(), title: 'Clock deal' }));
  legacyDeal = await deliveredDeal(dealTerms({ title: 'Legacy deal' }));
  bigDeal = await deliveredDeal(dealTerms({ amountMinor: 60000, title: 'Big deal' })); // above the 50000 tap limit
});
afterAll(async () => {
  await mongoose.disconnect();
});

describe('GET /payables', () => {
  test('the brand sees one row per milestone with held, clock and hold fields', async () => {
    const r = await request(app).get(`${base()}/payables`).set(auth(U.client)).expect(200);
    const rows = r.body.data.rows;
    expect(rows.map((x) => x.dealId).sort()).toEqual([clockDeal, legacyDeal, bigDeal].sort());
    const c = rows.find((x) => x.dealId === clockDeal);
    expect(c).toMatchObject({
      dealTitle: 'Clock deal',
      milestoneKey: 'reel1',
      amountMinor: 40000,
      heldMinor: 40000,
      releasedMinor: 0,
      currency: 'USD',
      state: 'IN_REVIEW',
      hasClock: true,
      clockStatus: 'running',
      revisionsUsed: 0,
      revisionsIncluded: 1,
      failedChecks: 0,
      waitingDays: 0,
      holdAgeDays: 0,
      nextAction: 'Review and approve',
      approvable: true,
      editorName: 'worker',
    });
    expect(c.businessDaysLeft).toBeGreaterThan(0);
    expect(Date.parse(c.graceDeadline)).toBeGreaterThan(Date.parse(c.deadline));
    expect(Date.parse(c.holdLapsesAt)).toBe(now + 29 * DAY);
    expect(c.team.map((t) => [t.name, t.shareBp])).toEqual([['worker', 7000], ['motion', 3000]]);
    const l = rows.find((x) => x.dealId === legacyDeal);
    expect(l).toMatchObject({ hasClock: false, clockStatus: null, businessDaysLeft: null, revisionsIncluded: 1 });
  });

  test('a deal manager sees the org; a crew member or bystander who is not the brand sees nothing', async () => {
    const m = await request(app).get(`${base()}/payables`).set(auth(U.manager)).expect(200);
    expect(m.body.data.rows).toHaveLength(3);
    expect(m.body.data.scope).toBe('org');
    expect(m.body.data.rows.every((x) => x.approvable === false)).toBe(true); // only the brand approves
    for (const who of [U.motion, U.bystander]) {
      const r = await request(app).get(`${base()}/payables`).set(auth(who)).expect(200);
      expect(r.body.data.rows).toEqual([]);
    }
  });

  test('another org cannot read this org (and this org has no rows there)', async () => {
    const r = await request(app).get(`${base()}/payables`).set(auth(U.outsider));
    expect([403, 404]).toContain(r.status);
    const own = await request(app).get(`${base(otherOrgId)}/payables`).set(auth(U.outsider)).expect(200);
    expect(own.body.data.rows).toEqual([]);
  });

  test('needs a sign-in', async () => {
    await request(app).get(`${base()}/payables`).expect(401);
  });
});

describe("GET /my-money", () => {
  test('a crew member sees their share, nothing released yet, and the clock dates', async () => {
    const r = await request(app).get(`${base()}/my-money`).set(auth(U.motion)).expect(200);
    const rows = r.body.data.rows;
    expect(rows).toHaveLength(3);
    const c = rows.find((x) => x.dealId === clockDeal);
    expect(c).toMatchObject({ mySharePct: 30, myShareMinor: 12000, releasedMinor: 0, status: 'clock_running', simulated: false });
    // 50% partial at the clock deadline (30% of 20000), the rest at the grace deadline
    expect(c.expected.map((e) => e.amountMinor)).toEqual([6000, 6000]);
    const board = (await request(app).get(`${base()}/payables`).set(auth(U.client))).body.data.rows.find((x) => x.dealId === clockDeal);
    expect(c.expected[0].at).toBe(board.deadline);
    expect(c.expected[1].at).toBe(board.graceDeadline);
    const l = rows.find((x) => x.dealId === legacyDeal);
    expect(l.expected).toEqual([{ amountMinor: 12000, at: null, label: 'on approval' }]);
    expect(l.expectedLabel).toBe('on approval');
  });

  test('the lead gets the leftover cents; a non-member sees nothing', async () => {
    const lead = await request(app).get(`${base()}/my-money`).set(auth(U.worker)).expect(200);
    expect(lead.body.data.rows.find((x) => x.dealId === bigDeal).myShareMinor).toBe(42000);
    const none = await request(app).get(`${base()}/my-money`).set(auth(U.bystander)).expect(200);
    expect(none.body.data.rows).toEqual([]);
  });
});

describe('POST /payables/bulk-approve', () => {
  const all = () => [
    { dealId: clockDeal, milestoneKey: 'reel1' },
    { dealId: legacyDeal, milestoneKey: 'reel1' },
    { dealId: bigDeal, milestoneKey: 'reel1' },
  ];

  test('rejects a bad body', async () => {
    await bulk(U.client, [], true).expect(422);
    await bulk(U.client, [{ dealId: clockDeal }], true).expect(422);
    await request(app).post(`${base()}/payables/bulk-approve`).set(auth(U.client)).send({ items: all() }).expect(422);
    await bulk(U.client, Array.from({ length: 51 }, (_, i) => ({ dealId: `d${i}`, milestoneKey: 'reel1' })), true).expect(422);
  });

  test('dry run: per item and per person amounts, and no money moves', async () => {
    const callsBefore = gw.calls.length;
    const ledgerBefore = (await mongoLedger.list(clockDeal)).length + (await mongoLedger.list(legacyDeal)).length;
    const r = await bulk(U.client, all(), true).expect(200);
    const d = r.body.data;
    expect(d.dryRun).toBe(true);
    expect(d.moved).toBe(false);
    const [c, l, b] = d.items;
    expect(c).toMatchObject({ outcome: 'would_capture', path: 'clock', captureMinor: 40000, payoutMinor: 40000 });
    expect(c.payees.map((p) => [p.name, p.amountMinor])).toEqual([['worker', 28000], ['motion', 12000]]);
    expect(l).toMatchObject({ outcome: 'would_capture', path: 'legacy', captureMinor: 40000 });
    // legacy approve over the tap limit: approves, then the capture waits for one more tap (P7)
    expect(b).toMatchObject({ outcome: 'needs_tap', code: 'P7_human_tap', captureMinor: 60000 });
    expect(b.payees.map((p) => p.amountMinor)).toEqual([42000, 18000]);
    expect(d.totals.captureByCurrency).toEqual({ USD: 140000 });
    expect(d.totals.byPerson.map((p) => [p.name, p.amountMinor])).toEqual([['worker', 98000], ['motion', 42000]]);

    expect(gw.calls.length).toBe(callsBefore);
    expect((await mongoLedger.list(clockDeal)).length + (await mongoLedger.list(legacyDeal)).length).toBe(ledgerBefore);
    for (const id of [clockDeal, legacyDeal, bigDeal]) {
      const m = (await dealService().get(id)).milestones[0];
      expect(m.state).toBe('IN_REVIEW');
      expect(m.capturedMinor).toBe(0);
    }
  });

  test('refuses people who cannot approve, and deals from another org', async () => {
    for (const who of [U.manager, U.worker, U.bystander]) {
      const r = await bulk(who, all(), true).expect(200);
      expect(r.body.data.items.every((x) => x.outcome === 'refused' && x.code === 'forbidden')).toBe(true);
      const real = await bulk(who, all(), false).expect(200);
      expect(real.body.data.items.every((x) => x.ok === false && x.outcome === 'refused')).toBe(true);
    }
    const r = await bulk(U.client, [{ dealId: 'deal_nope', milestoneKey: 'reel1' }], false).expect(200);
    expect(r.body.data.items[0]).toMatchObject({ ok: false, outcome: 'refused', code: 'deal_not_found' });
    for (const id of [clockDeal, legacyDeal, bigDeal]) expect((await dealService().get(id)).milestones[0].state).toBe('IN_REVIEW');
    const x = await request(app).post(`${base()}/payables/bulk-approve`).set(auth(U.outsider)).send({ items: all(), dryRun: true });
    expect([403, 404]).toContain(x.status);
  });

  test('real run approves through the single-approve paths; a repeat pays nothing twice', async () => {
    const r = await bulk(U.client, all(), false).expect(200);
    const [c, l, b] = r.body.data.items;
    expect(c).toMatchObject({ ok: true, outcome: 'captured', capturedMinor: 40000, paidOutMinor: 40000 });
    expect(l).toMatchObject({ ok: true, outcome: 'captured', capturedMinor: 40000, paidOutMinor: 40000 });
    expect(b).toMatchObject({ ok: true, outcome: 'waiting_for_tap', capturedMinor: 0, state: 'APPROVED' });
    expect(r.body.data.moved).toBe(true);
    const big = await dealService().get(bigDeal);
    expect(big.pendingApprovals.map((p) => p.action.kind)).toEqual(['capture']);

    const before = { c: moneyCalls(clockDeal).length, l: moneyCalls(legacyDeal).length, b: moneyCalls(bigDeal).length };
    expect(before.c).toBe(2); // one capture + one payout batch
    expect(before.l).toBe(2);
    expect(before.b).toBe(0);

    const again = await bulk(U.client, all(), false).expect(200);
    expect(again.body.data.items.map((x) => x.outcome)).toEqual(['already_approved', 'already_approved', 'already_approved']);
    expect(again.body.data.items.every((x) => x.ok && x.capturedMinor === 0)).toBe(true);
    expect(again.body.data.moved).toBe(false);
    expect({ c: moneyCalls(clockDeal).length, l: moneyCalls(legacyDeal).length, b: moneyCalls(bigDeal).length }).toEqual(before);
    for (const id of [clockDeal, legacyDeal]) {
      const m = (await dealService().get(id)).milestones[0];
      expect(m.capturedMinor).toBe(40000);
      expect(m.paidOutMinor).toBe(40000);
      expect(m.payoutBatches).toHaveLength(1);
    }

    // a dry run now reports nothing to move
    const dry = await bulk(U.client, all(), true).expect(200);
    expect(dry.body.data.items.every((x) => x.outcome === 'already_approved' && x.captureMinor === 0)).toBe(true);
  });

  test('after payment the board and my money reflect it, marked simulated', async () => {
    const rows = (await request(app).get(`${base()}/payables`).set(auth(U.client))).body.data.rows;
    expect(rows.find((x) => x.dealId === legacyDeal)).toMatchObject({ heldMinor: 0, releasedMinor: 40000, state: 'PAID_OUT', nextAction: 'Paid', holdAgeDays: null });
    expect(rows.find((x) => x.dealId === bigDeal)).toMatchObject({ nextAction: 'Tap to release the capture', heldMinor: 60000 });
    const mine = (await request(app).get(`${base()}/my-money`).set(auth(U.motion))).body.data.rows;
    expect(mine.find((x) => x.dealId === legacyDeal)).toMatchObject({ releasedMinor: 12000, status: 'paid', simulated: true, expectedMinor: 0 });
    expect(mine.find((x) => x.dealId === bigDeal)).toMatchObject({ releasedMinor: 0, status: 'releasing' });
  });

  test('in grace after the partial release: approve captures only the rest', async () => {
    const g = await deliveredDeal(dealTerms({ clock: CLOCK(), title: 'Grace deal' }));
    const sched = (await dealService().get(g)).milestones[0].clock.schedule;
    now = Date.parse(sched.steps.find((s) => s.id === 'release_partial').atISO) + 60 * 1000;
    await dealService().advanceClocks(iso());
    const row = (await request(app).get(`${base()}/payables`).set(auth(U.client))).body.data.rows.find((x) => x.dealId === g);
    expect(row).toMatchObject({ clockStatus: 'released_partial', heldMinor: 20000, releasedMinor: 20000, businessDaysLeft: 0 });
    const mine = (await request(app).get(`${base()}/my-money`).set(auth(U.motion))).body.data.rows.find((x) => x.dealId === g);
    expect(mine).toMatchObject({ status: 'in_grace', releasedMinor: 6000, simulated: true });
    expect(mine.expected).toEqual([{ amountMinor: 6000, at: row.graceDeadline, label: 'grace deadline (the rest)' }]);

    const item = [{ dealId: g, milestoneKey: 'reel1' }];
    const dry = await bulk(U.client, item, true).expect(200);
    expect(dry.body.data.items[0]).toMatchObject({ outcome: 'would_capture', captureMinor: 20000, payoutMinor: 20000 });
    expect(dry.body.data.items[0].payees.map((p) => p.amountMinor)).toEqual([14000, 6000]);
    const real = await bulk(U.client, item, false).expect(200);
    expect(real.body.data.items[0]).toMatchObject({ outcome: 'captured', capturedMinor: 20000, paidOutMinor: 20000 });
    const m = (await dealService().get(g)).milestones[0];
    expect(m.capturedMinor).toBe(40000);
    expect(m.paidOutMinor).toBe(40000);
  });
});
