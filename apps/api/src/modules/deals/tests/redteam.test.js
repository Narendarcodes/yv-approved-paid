/**
 * Policy red-team suite: the attacks a confused or hostile agent (or a person
 * replaying requests) would try against the money path. Every attack must be
 * refused for the right reason, and PayPal must never be asked to move money.
 *
 *   attack                                         refused by
 *   over-capture                                   P3_amount
 *   double capture (sequential)                    P5_already_ran + P1_state
 *   double capture (stale copy, no lock)           PayPal-Request-Id = policy idempotency key (one capture at PayPal)
 *   double capture (concurrent HTTP-level ticks)   per-deal lock (deal_busy), then P1/P5 on the next pass
 *   capture after void                             P9_auth_window (+ P1_state)
 *   capture on a wrong / old / unknown version     P6_version
 *   dispute split accepted by one side only        P3_amount ("no split accepted by both sides")
 *   capture beyond what is still held              P3_amount (+ P1_state / P5_already_ran)
 *   AI-supplied amounts                            P3_amount / P11_rate_card; the planner uses signed terms only
 *   replayed webhook                               event-id dedup ("duplicate"), nothing re-applied
 *   unsigned / forged webhook                      401 bad_signature, nothing recorded
 *   cross-org access                               404 deal_not_found (no existence leak)
 *
 * The pure attacks run on the engine with the mock gateway; the lock, webhook
 * and cross-org attacks run on Mongo + the HTTP app.
 */
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../../../app');
const { seedDefaultRoles } = require('../../../seed/roles');
const { engine, proposals, hashOf } = require('../engine.cts');
const { configureDeals, handlePaypalEvent } = require('../service.cts');
const { makeMockGateway } = require('../paypal.cts');
const { harness, signedAndFunded, terms: baseTerms, ms, T0, HOUR } = require('./fixtures');

const V1 = { id: 'v1', sha256: '1'.repeat(64) };
const V2 = { id: 'v2', sha256: '2'.repeat(64) };
const STYLE = { id: 's1', sha256: 'c'.repeat(64) };

const rules = (r) => (r.result ? r.result.violations : r.violations || []).map((v) => v.rule);
const gwCaptures = (h) => h.gateway.state().captures;
const captureCalls = (h) => h.gateway.calls.filter((c) => c.op === 'capture');
const capture = (over = {}) => ({ kind: 'capture', milestoneKey: 'reel1', amountMinor: 40000, versionId: 'v1', final: true, reason: 'approval', ...over });
const split = (amountMinor) => ({ kind: 'partial_capture', milestoneKey: 'reel1', amountMinor, reason: 'dispute_split' });

/** Signed, funded, style OK'd, v1 submitted and checked; stops in IN_REVIEW. */
async function inReview(h, passed = true) {
  await signedAndFunded(h);
  h.deal = engine.submitStyleSample(h.deal, 'reel1', 'u_worker', STYLE, h.clock.now());
  h.deal = engine.decideStyle(h.deal, 'reel1', 'u_client', true, h.clock.now());
  h.deal = engine.submitVersion(h.deal, 'reel1', 'u_worker', V1, h.clock.now());
  h.deal = engine.recordChecks(h.deal, 'reel1', 'v1', { reportId: 'r1', passed, failed: passed ? [] : ['loud'] }, h.clock.now());
  return h;
}
async function approved() {
  const h = await inReview(harness());
  h.deal = engine.approve(h.deal, 'reel1', 'u_client', 'v1', h.clock.now());
  return h;
}
async function disputed() {
  const h = await inReview(harness());
  h.deal = engine.openDispute(h.deal, 'reel1', 'u_client', h.clock.now());
  return h;
}

/* ------------------------------------------------------------- pure engine */

describe('red team: over-capture', () => {
  test('one minor unit over the signed amount -> P3_amount, PayPal never called', async () => {
    const h = await approved();
    const r = await engine.execute(h.deps, h.deal, capture({ amountMinor: 40001 }));
    expect(r.result.outcome).toBe('blocked');
    expect(rules(r)).toContain('P3_amount');
    expect(captureCalls(h)).toHaveLength(0);
  });

  test('a non-final capture of the full amount (to sneak a second one later) -> P3_amount', async () => {
    const h = await approved();
    const r = await engine.execute(h.deps, h.deal, capture({ final: false }));
    expect(rules(r)).toContain('P3_amount');
    expect(captureCalls(h)).toHaveLength(0);
  });

  test('NaN, Infinity, float, negative and zero amounts -> P3_amount, logged as a clean block (no crash)', async () => {
    const h = await approved();
    for (const amountMinor of [NaN, Infinity, 40000.5, -40000, 0]) {
      const r = await engine.execute(h.deps, h.deal, capture({ amountMinor }));
      expect(r.result.outcome).toBe('blocked');
      expect(rules(r)).toContain('P3_amount');
      expect(r.result.entry.moved).toBe(false);
    }
    expect(captureCalls(h)).toHaveLength(0);
    const { ledger } = require('../engine.cts');
    expect(ledger.verifyChain(await h.ledger.list(h.deal.id)).ok).toBe(true);
  });
});

describe('red team: double capture', () => {
  test('sequential: the second capture -> P5_already_ran + P1_state', async () => {
    const h = await approved();
    const first = await engine.execute(h.deps, h.deal, capture());
    expect(first.result.outcome).toBe('done');
    const second = await engine.execute(h.deps, first.deal, capture());
    expect(second.result.outcome).toBe('blocked');
    expect(rules(second)).toEqual(expect.arrayContaining(['P5_already_ran', 'P1_state']));
    expect(gwCaptures(h)).toHaveLength(1);
  });

  test('two runs from the same stale copy (no lock): PayPal-Request-Id makes the second a replay, one capture at PayPal', async () => {
    const h = await approved();
    const stale = h.deal;
    const [a, b] = await Promise.all([engine.execute(h.deps, stale, capture()), engine.execute(h.deps, stale, capture())]);
    expect(a.result.idempotencyKey || a.result.entry.idempotencyKey).toBe(b.result.entry.idempotencyKey);
    expect(gwCaptures(h)).toHaveLength(1);
    expect(gwCaptures(h)[0].amountMinor).toBe(40000);
    // both copies point at the same PayPal capture, so nothing was charged twice
    expect(ms(a.deal).captures[0].id).toBe(ms(b.deal).captures[0].id);
  });

  test('the Money Agent ticking twice captures once', async () => {
    const h = await approved();
    const t1 = await engine.tick(h.deps, h.deal);
    const t2 = await engine.tick(h.deps, t1.deal);
    expect(gwCaptures(h)).toHaveLength(1);
    expect(t2.results.filter((x) => x.entry.type === 'capture')).toHaveLength(0);
  });
});

describe('red team: capture after void', () => {
  test('after a mutual cancel voided the hold -> P9_auth_window + P1_state', async () => {
    const h = await inReview(harness());
    const v = await engine.execute(h.deps, h.deal, { kind: 'void', milestoneKey: 'reel1', reason: 'mutual' }, { mutualConsent: true });
    expect(v.result.outcome).toBe('done');
    expect(ms(v.deal).state).toBe('CANCELLED');
    const r = await engine.execute(h.deps, v.deal, capture());
    expect(r.result.outcome).toBe('blocked');
    expect(rules(r)).toEqual(expect.arrayContaining(['P9_auth_window', 'P1_state']));
    expect(captureCalls(h)).toHaveLength(0);
  });

  test('client approves after PayPal voided the hold outside yv. -> P9_auth_window', async () => {
    const h = await approved();
    const d = JSON.parse(JSON.stringify(h.deal));
    ms(d).funding.status = 'VOIDED'; // what the PAYMENT.AUTHORIZATION.VOIDED webhook records
    const r = await engine.execute(h.deps, d, capture());
    expect(rules(r)).toContain('P9_auth_window');
    expect(captureCalls(h)).toHaveLength(0);
  });

  test('a void without mutual consent is itself refused -> P1_state', async () => {
    const h = await inReview(harness());
    const r = await engine.execute(h.deps, h.deal, { kind: 'void', milestoneKey: 'reel1', reason: 'mutual' });
    expect(rules(r)).toContain('P1_state');
  });
});

describe('red team: wrong or old file version', () => {
  async function v2Approved() {
    const h = await inReview(harness(), false);
    h.deal = engine.requestChanges(h.deal, 'reel1', 'u_client', [{ text: 'too quiet', tag: 'fix', checklistId: 'loud' }], h.clock.now());
    h.deal = engine.submitVersion(h.deal, 'reel1', 'u_worker', V2, h.clock.now());
    h.deal = engine.recordChecks(h.deal, 'reel1', 'v2', { reportId: 'r2', passed: true, failed: [] }, h.clock.now());
    h.deal = engine.approve(h.deal, 'reel1', 'u_client', 'v2', h.clock.now());
    return h;
  }

  test('capture names the old v1 after the client approved v2 -> P6_version', async () => {
    const h = await v2Approved();
    const r = await engine.execute(h.deps, h.deal, capture({ versionId: 'v1' }));
    expect(rules(r)).toContain('P6_version');
    expect(captureCalls(h)).toHaveLength(0);
  });

  test('capture names a version that was never submitted -> P6_version', async () => {
    const h = await v2Approved();
    const r = await engine.execute(h.deps, h.deal, capture({ versionId: 'v3-unsubmitted' }));
    expect(rules(r)).toContain('P6_version');
  });

  test('approving the old version is refused by the engine (stale_version)', async () => {
    const h = await inReview(harness(), false);
    h.deal = engine.requestChanges(h.deal, 'reel1', 'u_client', [{ text: 'too quiet', tag: 'fix', checklistId: 'loud' }], h.clock.now());
    h.deal = engine.submitVersion(h.deal, 'reel1', 'u_worker', V2, h.clock.now());
    h.deal = engine.recordChecks(h.deal, 'reel1', 'v2', { reportId: 'r2', passed: true, failed: [] }, h.clock.now());
    expect(() => engine.approve(h.deal, 'reel1', 'u_client', 'v1', h.clock.now())).toThrow(expect.objectContaining({ code: 'stale_version' }));
  });

  test('auto-approval capture of a version that failed checks -> P6_version', async () => {
    const h = await inReview(harness(), false);
    const r = await engine.execute(h.deps, h.deal, capture({ reason: 'auto_approval' }));
    expect(rules(r)).toContain('P6_version');
  });
});

describe('red team: dispute split', () => {
  test('only the worker accepted -> P3_amount, and the planner proposes nothing', async () => {
    const h = await disputed();
    h.deal = engine.acceptSplit(h.deal, 'reel1', 'u_worker', 32000);
    expect(engine.plan(h.deal, h.clock.now())).toHaveLength(0);
    const r = await engine.execute(h.deps, h.deal, split(32000));
    expect(rules(r)).toContain('P3_amount');
    expect(r.result.violations.map((v) => v.message).join(' ')).toMatch(/both sides/);
    expect(captureCalls(h)).toHaveLength(0);
  });

  test('only the client accepted -> P3_amount', async () => {
    const h = await disputed();
    h.deal = engine.acceptSplit(h.deal, 'reel1', 'u_client', 8000);
    const r = await engine.execute(h.deps, h.deal, split(8000));
    expect(rules(r)).toContain('P3_amount');
  });

  test('both accepted, but different numbers -> no agreement, P3_amount', async () => {
    const h = await disputed();
    h.deal = engine.acceptSplit(h.deal, 'reel1', 'u_worker', 32000);
    h.deal = engine.acceptSplit(h.deal, 'reel1', 'u_client', 24000);
    const r = await engine.execute(h.deps, h.deal, split(32000));
    expect(rules(r)).toContain('P3_amount');
  });

  test('both accepted 32000, the agent tries 36000 -> P3_amount', async () => {
    const h = await disputed();
    h.deal = engine.acceptSplit(h.deal, 'reel1', 'u_worker', 32000);
    h.deal = engine.acceptSplit(h.deal, 'reel1', 'u_client', 32000);
    const r = await engine.execute(h.deps, h.deal, split(36000));
    expect(rules(r)).toContain('P3_amount');
  });

  test('a third party cannot accept a split', async () => {
    const h = await disputed();
    expect(() => engine.acceptSplit(h.deal, 'reel1', 'u_stranger', 32000)).toThrow(expect.objectContaining({ code: 'forbidden' }));
  });
});

describe('red team: capture beyond what is still held after a partial capture', () => {
  async function splitCaptured() {
    const h = await disputed();
    h.deal = engine.acceptSplit(h.deal, 'reel1', 'u_worker', 32000);
    h.deal = engine.acceptSplit(h.deal, 'reel1', 'u_client', 32000);
    const r = await engine.execute(h.deps, h.deal, split(32000));
    expect(r.result.outcome).toBe('done');
    h.deal = r.deal;
    return h;
  }

  test('a full capture after the 32000 split -> P3_amount (only 8000 held) + P1_state', async () => {
    const h = await splitCaptured();
    const r = await engine.execute(h.deps, h.deal, capture());
    expect(rules(r)).toEqual(expect.arrayContaining(['P3_amount', 'P1_state']));
    expect(r.result.violations.some((v) => /held amount 8000/.test(v.message))).toBe(true);
  });

  test('the same split again -> P5_already_ran + P3_amount', async () => {
    const h = await splitCaptured();
    const r = await engine.execute(h.deps, h.deal, split(32000));
    expect(rules(r)).toEqual(expect.arrayContaining(['P5_already_ran', 'P3_amount']));
    expect(gwCaptures(h)).toHaveLength(1);
  });

  test('kill fee taken, then the agent tries to capture the rest -> P1_state + P3_amount', async () => {
    const h = await inReview(harness());
    h.deal = engine.kill(h.deal, 'reel1', 'u_client', h.clock.now());
    const fee = await engine.execute(h.deps, h.deal, { kind: 'partial_capture', milestoneKey: 'reel1', amountMinor: 10000, reason: 'kill_fee' });
    expect(fee.result.outcome).toBe('done');
    const r = await engine.execute(h.deps, fee.deal, capture({ amountMinor: 40000 }));
    expect(rules(r)).toEqual(expect.arrayContaining(['P1_state', 'P3_amount']));
    expect(gwCaptures(h)).toHaveLength(1);
    expect(gwCaptures(h)[0].amountMinor).toBe(10000);
  });
});

describe('red team: amounts supplied by an AI are never trusted', () => {
  test('a proposal with an invented capture amount is refused in the dry run -> P3_amount', async () => {
    const h = await approved();
    const out = proposals.dryRun(h.deal, { kind: 'money', action: capture({ amountMinor: 99999 }) }, h.clock.now());
    expect(out.allowed).toBe(false);
    expect(out.violations.map((v) => v.rule)).toContain('P3_amount');
  });

  test('a string amount ("40000") from a model is rejected as an invalid action', async () => {
    const h = await approved();
    expect(() => proposals.dryRun(h.deal, { kind: 'money', action: capture({ amountMinor: '40000' }) }, h.clock.now())).toThrow(
      expect.objectContaining({ code: 'invalid_action' }),
    );
  });

  test('an invented change-order price -> P11_rate_card', async () => {
    const h = await inReview(harness());
    const out = proposals.dryRun(h.deal, { kind: 'money', action: { kind: 'invoice', milestoneKey: 'reel1', rateCardItemId: 'extra_cut', quantity: 1, amountMinor: 15000 } }, h.clock.now());
    expect(out.violations.map((v) => v.rule)).toContain('P11_rate_card');
  });

  test('the Money Agent plans from the signed terms only, whatever a proposal said', async () => {
    const h = await approved();
    proposals.dryRun(h.deal, { kind: 'money', action: capture({ amountMinor: 99999 }) }, h.clock.now()); // read-only, changes nothing
    const p = engine.plan(h.deal, h.clock.now()).find((x) => x.action.kind === 'capture');
    expect(p.action.amountMinor).toBe(40000);
    const t = await engine.tick(h.deps, h.deal);
    expect(gwCaptures(h).map((c) => c.amountMinor)).toEqual([40000]);
    expect(ms(t.deal).capturedMinor).toBe(40000);
  });
});

/* -------------------------------------------- Mongo + HTTP: lock, webhooks, orgs */

describe('red team over the running service', () => {
  const PASSWORD = 'P@ssw0rd-deals-redteam';
  let now = T0;
  let gw;
  let svc;
  let orgA;
  let orgB;
  const U = {};
  const auth = (u) => ({ Authorization: `Bearer ${u.token}` });

  async function user(key, org, role) {
    const email = `${key}@deals-redteam.example.com`;
    await request(app).post('/api/v1/auth/register').send({ name: key, email, password: PASSWORD });
    const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    const out = { token: login.body.data.accessToken, userId: login.body.data.user._id, email };
    if (role) {
      const add = await request(app).post(`/api/v1/organizations/${org}/members`).set(auth(U.admin)).send({ email, role });
      expect(add.statusCode).toBe(201);
    }
    return out;
  }
  function dealTerms() {
    const t = baseTerms();
    t.client = { ...t.client, userId: U.client.userId };
    t.worker = { ...t.worker, userId: U.worker.userId };
    t.milestones = [t.milestones[0]];
    t.milestones[0].payees = [{ userId: U.worker.userId, email: 'ravi@example.com', shareBp: 10000, displayName: 'Leo' }];
    return t;
  }
  /** A deal in org A, approved and waiting for the Money Agent to capture. */
  async function approvedDeal() {
    const d0 = await svc.create(orgA, U.client.userId, dealTerms());
    const h = hashOf(d0.terms);
    await svc.sign(d0.id, orgA, U.client.userId, h);
    await svc.sign(d0.id, orgA, U.worker.userId, h);
    const f = await svc.startFunding(d0.id, orgA, U.client.userId, 'reel1');
    gw.approveOrder(ms(f).funding.orderId);
    await svc.confirmFunding(d0.id, orgA, U.client.userId, 'reel1');
    await svc.submitStyleSample(d0.id, orgA, U.worker.userId, 'reel1', STYLE);
    await svc.decideStyle(d0.id, orgA, U.client.userId, 'reel1', true);
    await svc.submitVersion(d0.id, orgA, U.worker.userId, 'reel1', V1);
    await svc.recordChecks(d0.id, 'reel1', 'v1', { reportId: 'r1', passed: true, failed: [] });
    return svc.approve(d0.id, orgA, U.client.userId, 'reel1', 'v1', false);
  }
  function webhook(event, headers) {
    const raw = typeof event === 'string' ? event : JSON.stringify(event);
    return request(app)
      .post('/api/v1/webhooks/paypal')
      .set('Content-Type', 'application/json')
      .set(headers === undefined ? gw.signWebhook(raw) : headers)
      .send(raw);
  }

  beforeAll(async () => {
    await require('../../../db/mongo').connect();
    await seedDefaultRoles();
    gw = makeMockGateway({ now: () => now });
    // a slow PayPal: captures take 150 ms, so concurrent ticks really overlap
    const realCapture = gw.capture.bind(gw);
    gw.capture = async (...args) => {
      await new Promise((r) => setTimeout(r, 150));
      return realCapture(...args);
    };
    svc = configureDeals({ gateway: gw, now: () => new Date(now).toISOString(), publicBaseUrl: 'https://app.test' });
    U.admin = await user('admin');
    orgA = (await request(app).post('/api/v1/organizations').set(auth(U.admin)).send({ name: 'Redteam A', slug: 'deals-redteam-a' })).body.data._id;
    orgB = (await request(app).post('/api/v1/organizations').set(auth(U.admin)).send({ name: 'Redteam B', slug: 'deals-redteam-b' })).body.data._id;
    U.worker = await user('worker', orgA, 'editor');
    U.client = await user('client', orgA, 'reviewer');
    U.otherAdmin = await user('otheradmin', orgB, 'admin');
    U.otherMember = await user('othermember', orgB, 'reviewer');
  });
  afterAll(async () => {
    await mongoose.disconnect();
  });

  test('five concurrent Money Agent ticks: the per-deal lock lets one through, PayPal captures once', async () => {
    const d = await approvedDeal();
    const before = gw.state().captures.length;
    const runs = await Promise.allSettled([1, 2, 3, 4, 5].map(() => svc.tick(d.id, orgA)));
    const ok = runs.filter((r) => r.status === 'fulfilled');
    const busy = runs.filter((r) => r.status === 'rejected');
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of busy) expect(r.reason.code).toBe('deal_busy');
    expect(gw.state().captures.length - before).toBe(1);
    // a later pass finds nothing left to capture
    const again = await svc.tick(d.id, orgA);
    expect(again.out.filter((x) => x.entry.type === 'capture')).toHaveLength(0);
    const l = await svc.ledgerOf(d.id, orgA);
    expect(l.entries.filter((e) => e.type === 'capture')).toHaveLength(1);
    expect(l.chain.ok).toBe(true);
  });

  test('concurrent ticks over HTTP: one capture, the rest 409 deal_busy or a no-op', async () => {
    const d = await approvedDeal();
    const before = gw.state().captures.length;
    const res = await Promise.all([1, 2, 3].map(() => request(app).post(`/api/v1/organizations/${orgA}/deals/${d.id}/tick`).set(auth(U.client))));
    for (const r of res) {
      expect([200, 409]).toContain(r.status);
      if (r.status === 409) expect(r.body.error.code).toBe('deal_busy');
    }
    expect(gw.state().captures.length - before).toBe(1);
  });

  describe('webhooks', () => {
    let deal;
    beforeAll(async () => {
      deal = (await svc.tick((await approvedDeal()).id, orgA)).deal;
    });
    const capId = () => ms(deal).captures[0].id;
    const ledgerLines = async () => (await svc.ledgerOf(deal.id, orgA)).entries.filter((e) => e.type === 'webhook');
    const alerts = async () => (await svc.get(deal.id, orgA)).alerts || [];

    test('unsigned webhook -> 401 bad_signature, nothing recorded', async () => {
      const r = await webhook({ id: 'WH-RT-unsigned', event_type: 'PAYMENT.CAPTURE.REVERSED', resource: { id: capId() } }, {});
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('bad_signature');
      expect(await ledgerLines()).toHaveLength(0);
      expect(await alerts()).toHaveLength(0);
    });

    test('forged webhook (signature of a different body) -> 401, nothing recorded', async () => {
      const genuine = JSON.stringify({ id: 'WH-RT-forged', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: capId() } });
      const forged = JSON.stringify({ id: 'WH-RT-forged', event_type: 'PAYMENT.CAPTURE.REVERSED', resource: { id: capId() } });
      const r = await webhook(forged, gw.signWebhook(genuine));
      expect(r.status).toBe(401);
      const wrongKey = await webhook(forged, { 'x-mock-signature': 'f'.repeat(64) });
      expect(wrongKey.status).toBe(401);
      expect(await ledgerLines()).toHaveLength(0);
      expect(await alerts()).toHaveLength(0);
    });

    test('replayed webhook -> applied once; a replay with a changed type is still a duplicate', async () => {
      const ev = { id: 'WH-RT-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: capId(), status: 'COMPLETED' } };
      const first = await webhook(ev);
      expect(first.status).toBe(200);
      expect(first.body.data.outcome).toBe('recorded');
      const replay = await webhook(ev);
      expect(replay.body.data.outcome).toBe('duplicate');
      const mutated = await webhook({ ...ev, event_type: 'PAYMENT.CAPTURE.REVERSED' });
      expect(mutated.body.data.outcome).toBe('duplicate');
      expect(await ledgerLines()).toHaveLength(1);
      expect(await alerts()).toHaveLength(0);
    });

    test('a replayed CHECKOUT.ORDER.APPROVED never authorizes twice', async () => {
      const orderId = ms(deal).funding.orderId;
      const r = await handlePaypalEvent(svc, { id: 'WH-RT-order', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: orderId } });
      expect(r.outcome).toBe('already_funded');
      expect((await svc.ledgerOf(deal.id, orgA)).entries.filter((e) => e.type === 'authorize')).toHaveLength(1);
    });

    test('a signed webhook can flag, but never moves money', async () => {
      const before = gw.calls.length;
      const r = await webhook({ id: 'WH-RT-rev', event_type: 'PAYMENT.CAPTURE.REVERSED', resource: { id: capId() } });
      expect(r.body.data.outcome).toBe('flagged');
      expect(gw.calls.length).toBe(before);
      const l = await svc.ledgerOf(deal.id, orgA);
      expect(l.entries.filter((e) => e.type === 'webhook').every((e) => e.moved === false)).toBe(true);
    });
  });

  describe('cross-org', () => {
    let dealId;
    beforeAll(async () => {
      dealId = (await approvedDeal()).id;
    });

    test("org B's admin and members get 404 for org A's deal on every route", async () => {
      const B = `/api/v1/organizations/${orgB}/deals/${dealId}`;
      for (const u of [U.otherAdmin, U.otherMember]) {
        expect((await request(app).get(B).set(auth(u))).status).toBe(404);
        expect((await request(app).get(`${B}/ledger`).set(auth(u))).status).toBe(404);
        expect((await request(app).post(`${B}/tick`).set(auth(u))).status).toBe(404);
        expect((await request(app).post(`${B}/milestones/reel1/kill`).set(auth(u))).status).toBe(404);
      }
      const list = await request(app).get(`/api/v1/organizations/${orgB}/deals?all=1`).set(auth(U.otherAdmin));
      expect(list.status).toBe(200);
      expect(list.body.data.map((d) => d.id)).not.toContain(dealId);
    });

    test("org B's member cannot reach org A's deal through org A's path either (404, no existence leak)", async () => {
      expect((await request(app).get(`/api/v1/organizations/${orgA}/deals/${dealId}`).set(auth(U.otherMember))).status).toBe(404);
      expect((await request(app).post(`/api/v1/organizations/${orgA}/deals/${dealId}/tick`).set(auth(U.otherMember))).status).toBe(404);
    });

    test('the service refuses a wrong org id with deal_not_found and moves nothing', async () => {
      const before = gw.calls.length;
      await expect(svc.tick(dealId, orgB)).rejects.toMatchObject({ code: 'deal_not_found', status: 404 });
      await expect(svc.ledgerOf(dealId, orgB)).rejects.toMatchObject({ code: 'deal_not_found' });
      await expect(svc.approveHuman(dealId, orgB, U.client.userId, `capture:${dealId}:reel1`)).rejects.toMatchObject({ code: 'deal_not_found' });
      expect(gw.calls.length).toBe(before);
      expect((await svc.get(dealId, orgA)).milestones[0].state).toBe('APPROVED');
    });
  });

  test('HOUR sanity', () => expect(HOUR).toBe(3600000));
});
