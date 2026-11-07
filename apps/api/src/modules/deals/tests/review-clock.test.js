/**
 * The Fair Review Clock wired into the deal engine, over HTTP + Mongo + the
 * mock PayPal gateway: the clock starts only on passing checks, silence
 * releases the partial share then the rest (each exactly once), change requests
 * need a citation and pause the clock, rounds past the included ones become a
 * change order, a dispute freezes what is held, approval releases everything,
 * holds are kept alive, and the internal driver endpoint is guarded.
 */
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../../../app');
const { seedDefaultRoles } = require('../../../seed/roles');
const { configureDeals, dealService } = require('../service.cts');
const { makeMockGateway } = require('../paypal.cts');
const Notification = require('../../../models/notification.model');
const { terms: baseTerms, T0, HOUR, DAY } = require('./fixtures');

const PASSWORD = 'P@ssw0rd-review-clock';
const MIN = 60 * 1000;
let now = T0;
let gw;
let orgId;
const U = {};

const auth = (u) => ({ Authorization: `Bearer ${u.token}` });
const iso = () => new Date(now).toISOString();
const setNow = (t) => {
  now = typeof t === 'string' ? Date.parse(t) : t;
};

async function user(key, role) {
  const email = `${key}@review-clock.example.com`;
  await request(app).post('/api/v1/auth/register').send({ name: key, email, password: PASSWORD });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  const out = { token: login.body.data.accessToken, userId: login.body.data.user._id, email };
  if (role) {
    const add = await request(app).post(`/api/v1/organizations/${orgId}/members`).set(auth(U.admin)).send({ email, role });
    expect(add.statusCode).toBe(201);
  }
  return out;
}
const base = () => `/api/v1/organizations/${orgId}/deals`;
const M = (dealId) => `${base()}/${dealId}/milestones/reel1`;

function clockTerms(clock) {
  const t = baseTerms();
  t.client = { ...t.client, userId: U.client.userId, country: 'IN' };
  t.worker = { ...t.worker, userId: U.worker.userId };
  t.milestones = [{ ...t.milestones[0], styleSample: false }];
  t.milestones[0].payees = [
    { userId: U.worker.userId, email: 'ravi@example.com', shareBp: 7000, displayName: 'Ravi' },
    { userId: U.motion.userId, email: 'sana@example.com', shareBp: 3000, displayName: 'Sana' },
  ];
  if (clock) t.milestones[0].clock = clock;
  return t;
}
const DEFAULT_CLOCK = () => ({
  reviewWindowBusinessDays: 3,
  partialReleasePct: 50,
  graceBusinessDays: 3,
  includedRevisionRounds: 1,
  backupReviewerId: U.backup.userId,
});

/** Draft, sign by both sides and fund the milestone (buyer approval simulated). */
async function signedAndFunded(clock = DEFAULT_CLOCK()) {
  const r = await request(app).post(base()).set(auth(U.worker)).send({ terms: clockTerms(clock) });
  expect(r.status).toBe(201);
  expect(r.body.data.problems).toEqual([]);
  const dealId = r.body.data.id;
  const h = r.body.data.termsHashNow;
  await request(app).post(`${base()}/${dealId}/sign`).set(auth(U.client)).send({ termsHash: h }).expect(200);
  await request(app).post(`${base()}/${dealId}/sign`).set(auth(U.worker)).send({ termsHash: h }).expect(200);
  const f = await request(app).post(`${M(dealId)}/fund`).set(auth(U.client)).expect(200);
  gw.approveOrder(f.body.data.milestones[0].funding.orderId);
  const c = await request(app).post(`${M(dealId)}/fund/confirm`).set(auth(U.client));
  expect(c.status).toBe(200);
  return dealId;
}
async function deliver(dealId, versionId, passed, failed = []) {
  await request(app)
    .post(`${M(dealId)}/versions`)
    .set(auth(U.worker))
    .send({ versionId, sha256: versionId.padEnd(64, 'a').slice(0, 64) })
    .expect(200);
  return dealService().recordChecks(dealId, 'reel1', versionId, { reportId: `r_${versionId}`, passed, failed });
}
const getClock = async (dealId, who = U.client) => {
  const r = await request(app).get(`${M(dealId)}/clock`).set(auth(who));
  expect(r.status).toBe(200);
  return r.body.data;
};
const milestone = async (dealId) => (await dealService().get(dealId)).milestones[0];
const capturesFor = (dealId) => gw.calls.filter((c) => c.op === 'capture' && String(c.args.requestId).includes(`:${dealId}:`));

beforeAll(async () => {
  await require('../../../db/mongo').connect();
  await seedDefaultRoles();
  gw = makeMockGateway({ now: () => now });
  configureDeals({ gateway: gw, now: iso, publicBaseUrl: 'https://app.test' });
  U.admin = await user('admin');
  const org = await request(app).post('/api/v1/organizations').set(auth(U.admin)).send({ name: 'Review Clock', slug: 'review-clock' });
  orgId = org.body.data._id;
  U.worker = await user('worker', 'editor');
  U.motion = await user('motion', 'editor');
  U.client = await user('client', 'reviewer');
  U.backup = await user('backup', 'reviewer');
  U.bystander = await user('bystander', 'publisher');
});
afterAll(async () => {
  delete process.env.CLOCK_SHARED_SECRET;
  await mongoose.disconnect();
});

describe('Fair Review Clock: terms', () => {
  test('clock terms are validated with the brand country and lock at signing', async () => {
    const bad = clockTerms({ ...DEFAULT_CLOCK(), partialReleasePct: 95 });
    const r = await request(app).post(base()).set(auth(U.worker)).send({ terms: bad });
    expect(r.status).toBe(201);
    expect(r.body.data.problems.join(' ')).toMatch(/review clock: partialReleasePct/);
    const uk = clockTerms(DEFAULT_CLOCK());
    uk.client.country = 'GB';
    const r2 = await request(app).post(base()).set(auth(U.worker)).send({ terms: uk });
    expect(r2.body.data.problems.join(' ')).toMatch(/review clock: country/);

    const dealId = await signedAndFunded();
    const edit = await request(app).put(`${base()}/${dealId}/terms`).set(auth(U.client)).send({ terms: clockTerms({ ...DEFAULT_CLOCK(), partialReleasePct: 10 }) });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('deal_locked');
  });
});

describe('Fair Review Clock: start, silence and releases', () => {
  test('the clock does not start until the objective checks pass', async () => {
    setNow(T0);
    const dealId = await signedAndFunded();
    let c = await getClock(dealId);
    expect(c.status).toBe('waiting_checks');
    await deliver(dealId, 'v1', false, ['len']);
    c = await getClock(dealId);
    expect(c.status).toBe('waiting_checks');
    expect(c.state.status).toBe('waiting_checks');
    expect((await milestone(dealId)).clock).toBeUndefined();

    // a long silence after a failed delivery moves no money
    setNow(now + 2 * DAY);
    await dealService().advanceClocks(iso());
    expect(capturesFor(dealId)).toHaveLength(0);

    // the brand cites the failed check; the redelivery passes and the clock starts there
    const ch = await request(app).post(`${M(dealId)}/clock/changes`).set(auth(U.client)).send({ citation: 'len', text: 'Too long' });
    expect(ch.status).toBe(200);
    expect(ch.body.data.changeOrderRequired).toBe(false);
    await deliver(dealId, 'v2', true);
    c = await getClock(dealId);
    expect(c.status).toBe('running');
    expect(c.startedAt).toBe(iso());
    expect(c.timeline.map((e) => e.id)).toEqual(['started']);
    expect(c.amounts).toEqual({ amountMinor: 40000, partialAmountCents: 20000, remainderCents: 20000, currency: 'USD' });
  });

  test('silence: reminders, then the partial release, then the grace release, money moved exactly once', async () => {
    setNow(T0 + 10 * DAY);
    const dealId = await signedAndFunded();
    await deliver(dealId, 'v1', true);
    const m0 = await milestone(dealId);
    const at = Object.fromEntries(m0.clock.schedule.steps.map((s) => [s.id, Date.parse(s.atISO)]));

    // the reminders fire one by one, in schedule order (final_24h can come before remind_80 on a short window)
    const order = m0.clock.schedule.steps.map((s) => s.id);
    const reminders = order.filter((id) => !id.startsWith('release_'));
    for (const id of reminders) {
      setNow(at[id] + MIN);
      const adv0 = await dealService().advanceClocks(iso());
      expect(adv0.find((x) => x.dealId === dealId).steps).toEqual([id]);
    }
    const backupNote = await Notification.findOne({ userId: U.backup.userId, type: 'deal_clock_reminder', 'payload.dealId': dealId }).lean();
    expect(backupNote.payload.stepId).toBe('remind_80');
    const final = await Notification.findOne({ userId: U.client.userId, 'payload.stepId': 'final_24h', 'payload.dealId': dealId }).lean();
    expect(final.body).toMatch(/exactly \$200\.00 \(50%\)/);
    expect(await Notification.countDocuments({ userId: U.client.userId, type: 'deal_clock_reminder', 'payload.dealId': dealId })).toBe(3);
    expect(capturesFor(dealId)).toHaveLength(0);

    // deadline passes: the partial share is captured and split 70/30 by the locked team
    setNow(at.release_partial + MIN);
    let adv = await dealService().advanceClocks(iso());
    expect(adv.find((x) => x.dealId === dealId).steps).toEqual(['release_partial']);
    let m = await milestone(dealId);
    expect(m.capturedMinor).toBe(20000);
    expect(m.funding.status).toBe('PARTIALLY_CAPTURED');
    expect(m.payouts.map((p) => [p.email, p.amountMinor, p.tranche])).toEqual([
      ['ravi@example.com', 14000, 'clock_partial'],
      ['sana@example.com', 6000, 'clock_partial'],
    ]);
    expect(capturesFor(dealId).map((c) => c.args.requestId)).toEqual([`clock:${dealId}:reel1:release_partial`]);
    expect((await getClock(dealId)).state.status).toBe('released_partial');

    // running the step again, or advancing again, does nothing
    const again = await dealService().runClockStep(dealId, 'reel1', 'release_partial');
    expect(again.out.ran).toBe(false);
    await dealService().advanceClocks(iso());
    expect(capturesFor(dealId)).toHaveLength(1);
    expect((await milestone(dealId)).payouts).toHaveLength(2);

    // grace ends: the remainder is captured and paid; the milestone is done
    setNow(at.release_grace + MIN);
    adv = await dealService().advanceClocks(iso());
    expect(adv.find((x) => x.dealId === dealId).steps).toEqual(['release_grace']);
    m = await milestone(dealId);
    expect(m.state).toBe('PAID_OUT');
    expect(m.capturedMinor).toBe(40000);
    expect(m.clock.status).toBe('released');
    expect(m.clock.doneSteps).toEqual(order);
    expect(capturesFor(dealId).map((c) => [c.args.requestId, c.args.amountMinor])).toEqual([
      [`clock:${dealId}:reel1:release_partial`, 20000],
      [`clock:${dealId}:reel1:release_grace`, 20000],
    ]);
    const paid = (email) => m.payouts.filter((p) => p.email === email).reduce((a, p) => a + p.amountMinor, 0);
    expect(paid('ravi@example.com')).toBe(28000);
    expect(paid('sana@example.com')).toBe(12000);

    expect((await dealService().runClockStep(dealId, 'reel1', 'release_grace')).out.ran).toBe(false);
    await dealService().advanceClocks(iso());
    expect(capturesFor(dealId)).toHaveLength(2);
    const ledger = await dealService().ledgerOf(dealId, orgId);
    expect(ledger.chain.ok).toBe(true);
    const moved = ledger.entries.filter((e) => e.moved && (e.type === 'capture' || e.type === 'partial_capture'));
    expect(moved.reduce((a, e) => a + e.amountMinor, 0)).toBe(40000);

    // the timeline shows every step, readable by brand and editor alike
    const c = await getClock(dealId, U.worker);
    expect(c.timeline.filter((e) => e.kind === 'step').map((e) => e.id)).toEqual(order);
    expect((await request(app).get(`${M(dealId)}/clock`).set(auth(U.bystander))).status).toBe(404);
  });
});

describe('Fair Review Clock: brand actions', () => {
  let dealId;
  test('a change request without a citation is refused with 422; a cited one pauses the clock', async () => {
    setNow(T0 + 30 * DAY);
    dealId = await signedAndFunded();
    await deliver(dealId, 'v1', true);
    const none = await request(app).post(`${M(dealId)}/clock/changes`).set(auth(U.client)).send({ text: 'make it pop' });
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('citation_required');
    const unknown = await request(app).post(`${M(dealId)}/clock/changes`).set(auth(U.client)).send({ citation: 'nope', text: 'x' });
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('citation_unknown');
    // the plain change route on a clock milestone needs citations too
    const plain = await request(app).post(`${M(dealId)}/changes`).set(auth(U.client)).send({ items: [{ text: 'warmer', tag: 'taste' }] });
    expect(plain.status).toBe(422);
    expect(plain.body.error.code).toBe('citation_required');

    setNow(now + 2 * HOUR);
    const ok = await request(app).post(`${M(dealId)}/clock/changes`).set(auth(U.client)).send({ citation: 'vibe', text: 'Warmer colours' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.changeOrderRequired).toBe(false);
    expect(ok.body.data.clock.status).toBe('paused');
    expect(ok.body.data.clock.revisionsUsed).toBe(1);
    expect(ok.body.data.deal.milestones[0].state).toBe('CHANGES_REQUESTED');

    // paused: nothing is due however long it stays paused
    setNow(now + 10 * DAY);
    await dealService().advanceClocks(iso());
    expect(capturesFor(dealId)).toHaveLength(0);

    // redelivery that passes resumes, and the deadlines move by the paused time
    const before = (await milestone(dealId)).clock.schedule.deadline;
    await deliver(dealId, 'v2', true);
    const c = await getClock(dealId);
    expect(c.status).toBe('running');
    expect(c.pausedMs).toBe(10 * DAY);
    expect(Date.parse(c.state.deadline)).toBe(Date.parse(before) + 10 * DAY);
    // (the hold is refreshed while paused, so hold upkeep lines sit in between)
    expect(c.timeline.map((e) => e.id).filter((id) => !id.startsWith('hold_'))).toEqual(['started', 'changes_requested', 'resumed']);
  });

  test('a round past the included ones creates a change-order invoice instead', async () => {
    const r = await request(app).post(`${M(dealId)}/clock/changes`).set(auth(U.client)).send({ citation: 'hook', text: 'Different hook' });
    expect(r.status).toBe(200);
    expect(r.body.data.changeOrderRequired).toBe(true);
    expect(r.body.data.changeOrder.status).toBe('invoiced');
    expect(r.body.data.changeOrder.rateCardItemId).toBe('revision_round');
    expect(r.body.data.invoice.outcome).toBe('done');
    // no pause and no extra round: the clock keeps running on the delivered version
    expect(r.body.data.clock.status).toBe('running');
    expect(r.body.data.clock.revisionsUsed).toBe(1);
    expect(r.body.data.deal.milestones[0].state).toBe('IN_REVIEW');
    // the paid change order unlocks the round
    const coId = r.body.data.changeOrder.id;
    const used = await request(app).post(`${M(dealId)}/clock/changes`).set(auth(U.client)).send({ citation: 'hook', text: 'Different hook', changeOrderId: coId });
    expect(used.status).toBe(200);
    expect(used.body.data.changeOrderRequired).toBe(false);
    expect(used.body.data.clock.revisionsUsed).toBe(2);
    expect(used.body.data.clock.status).toBe('paused');
  });

  test('approve releases the full amount and ends the clock', async () => {
    setNow(T0 + 50 * DAY);
    const id = await signedAndFunded();
    await deliver(id, 'v1', true);
    expect((await request(app).post(`${M(id)}/clock/approve`).set(auth(U.worker))).status).toBe(403);
    const r = await request(app).post(`${M(id)}/clock/approve`).set(auth(U.client));
    expect(r.status).toBe(200);
    const m = await milestone(id);
    expect(m.capturedMinor).toBe(40000);
    expect(m.state).toBe('PAID_OUT');
    expect(m.clock.status).toBe('approved');
    expect(r.body.data.clock.status).toBe('approved');
    // nothing more happens when the old deadlines pass
    setNow(now + 20 * DAY);
    await dealService().advanceClocks(iso());
    expect(capturesFor(id)).toHaveLength(1);
  });

  test('a dispute freezes the remainder and stops the clock', async () => {
    setNow(T0 + 80 * DAY);
    const id = await signedAndFunded();
    await deliver(id, 'v1', true);
    const m0 = await milestone(id);
    const at = Object.fromEntries(m0.clock.schedule.steps.map((s) => [s.id, Date.parse(s.atISO)]));
    setNow(at.release_partial + MIN);
    await dealService().advanceClocks(iso());
    expect((await milestone(id)).capturedMinor).toBe(20000);

    const d = await request(app).post(`${M(id)}/clock/dispute`).set(auth(U.client));
    expect(d.status).toBe(200);
    expect(d.body.data.clock.status).toBe('disputed');
    expect(d.body.data.deal.milestones[0].state).toBe('DISPUTED');

    setNow(at.release_grace + DAY);
    await dealService().advanceClocks(iso());
    await dealService().tick(id);
    const m = await milestone(id);
    expect(m.capturedMinor).toBe(20000);
    expect(m.funding.status).toBe('PARTIALLY_CAPTURED');
    expect(m.clock.doneSteps).not.toContain('release_grace');
    expect(capturesFor(id)).toHaveLength(1);
  });
});

describe('Fair Review Clock: hold upkeep', () => {
  test('reauthorizes after day 3 and warns both sides when the hold would lapse', async () => {
    setNow(T0 + 120 * DAY);
    const id = await signedAndFunded({ ...DEFAULT_CLOCK(), reviewWindowBusinessDays: 10, graceBusinessDays: 10 });
    const authAt = Date.parse((await milestone(id)).funding.authorizedAt);
    setNow(authAt + 5 * DAY);
    await deliver(id, 'v1', true);
    await dealService().advanceClocks(iso());
    const m = await milestone(id);
    expect(m.funding.reauthorizations).toHaveLength(1);
    expect(m.clock.timeline.map((e) => e.id)).toEqual(expect.arrayContaining(['hold_reauthorized', 'hold_lapsing']));
    const brand = await Notification.findOne({ userId: U.client.userId, type: 'deal_hold_refund', 'payload.dealId': id }).lean();
    const editor = await Notification.findOne({ userId: U.worker.userId, type: 'deal_hold_lapsing', 'payload.dealId': id }).lean();
    expect(brand.title).toMatch(/^Re-fund hold/);
    expect(editor.title).toMatch(/^Hold lapsing/);
    // a second pass sends nothing new and does not reauthorize inside the new honor period
    await dealService().advanceClocks(iso());
    expect((await milestone(id)).funding.reauthorizations).toHaveLength(1);
    expect(await Notification.countDocuments({ type: { $in: ['deal_hold_refund', 'deal_hold_lapsing'] }, 'payload.dealId': id })).toBe(2);
  });
});

describe('Fair Review Clock: internal driver endpoint', () => {
  test('404 without CLOCK_SHARED_SECRET, 401 with a wrong secret, 200 with the right one', async () => {
    delete process.env.CLOCK_SHARED_SECRET;
    expect((await request(app).post('/api/v1/internal/clock/advance').set('X-Clock-Secret', 'x')).status).toBe(404);
    process.env.CLOCK_SHARED_SECRET = 'clock-secret-for-tests';
    expect((await request(app).post('/api/v1/internal/clock/advance')).status).toBe(401);
    expect((await request(app).post('/api/v1/internal/clock/advance').set('X-Clock-Secret', 'wrong')).status).toBe(401);
    const ok = await request(app).post('/api/v1/internal/clock/advance').set('X-Clock-Secret', 'clock-secret-for-tests');
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body.data.advanced)).toBe(true);
  });

  test('the Money Agent tick drives the clock too', async () => {
    setNow(T0 + 160 * DAY);
    const id = await signedAndFunded();
    await deliver(id, 'v1', true);
    const m0 = await milestone(id);
    setNow(Date.parse(m0.clock.schedule.deadline) + MIN);
    await dealService().tickAll();
    expect((await milestone(id)).capturedMinor).toBe(20000);
  });
});

