/**
 * Stored agent proposals (Phase 4 gaps 1 + 3): the Review Agent's merged
 * Fix/Taste list and the Scope & Dispute Agent's evidence pack + split are
 * dry-run through policy, then kept on the milestone and shown in the deal view.
 * Agents never supply amounts; the split is computed in Node from the checklist.
 */
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../../../app');
const { createInternalApp } = require('../../../internal-app');
const config = require('../../../config');
const { mintServiceToken } = require('../../../agent/serviceToken');
const { seedDefaultRoles } = require('../../../seed/roles');
const { configureDeals, dealService } = require('../service.cts');
const { makeMockGateway } = require('../paypal.cts');
const { terms: baseTerms, T0 } = require('./fixtures');

const internal = createInternalApp();
const PASSWORD = 'P@ssw0rd-deals-proposals';
let now = T0;
let gw;
let orgId;
let otherOrgId;
let dealId;
const U = {};
const SHA = 'c'.repeat(64);

const auth = (u) => ({ Authorization: `Bearer ${u.token}` });
const svc = (scopes, org = orgId) => ({
  'X-Internal-Token': config.internal.token,
  Authorization: `Bearer ${mintServiceToken({ orgId: org, userId: U.worker.userId, scopes })}`,
});
async function user(key, org, role) {
  const email = `${key}@deals-proposals.example.com`;
  await request(app).post('/api/v1/auth/register').send({ name: key, email, password: PASSWORD });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  const out = { token: login.body.data.accessToken, userId: login.body.data.user._id, email };
  if (role) {
    const add = await request(app).post(`/api/v1/organizations/${org}/members`).set(auth(U.admin)).send({ email, role });
    expect(add.statusCode).toBe(201);
  }
  return out;
}
const base = (o = orgId) => `/api/v1/organizations/${o}/deals`;
const I = () => `/internal/deals/${dealId}`;
const ev = [{ t_start: 0, t_end: 2, note: 'measured on the file', screenshot: '/evidence/loud_002.40.jpg' }];
const results = [
  { checklist_id: 'len', metric: 'duration_s', measured: 41.2, passed: true, evidence: ev },
  { checklist_id: 'hook', metric: 'hook_by_s', measured: 0.4, passed: true, evidence: ev },
  { checklist_id: 'logo', metric: 'logo_present', measured: true, passed: true, evidence: ev },
  { checklist_id: 'loud', metric: 'loudness_lufs', measured: -20.1, passed: false, evidence: ev },
];
const review = (over = {}) => ({
  items: [
    { text: 'too quiet', tag: 'fix', checklistId: 'loud' },
    { text: 'make it more festive', tag: 'taste' },
  ],
  contradictions: [],
  rationale: '1 fix, 1 taste',
  ...over,
});
const view = async (u = U.client) => (await request(app).get(`${base()}/${dealId}`).set(auth(u))).body.data;

beforeAll(async () => {
  await require('../../../db/mongo').connect();
  await seedDefaultRoles();
  gw = makeMockGateway({ now: () => now });
  configureDeals({ gateway: gw, now: () => new Date(now).toISOString(), publicBaseUrl: 'https://app.test' });
  U.admin = await user('admin');
  orgId = (await request(app).post('/api/v1/organizations').set(auth(U.admin)).send({ name: 'Deals Proposals', slug: 'deals-proposals' })).body.data._id;
  otherOrgId = (await request(app).post('/api/v1/organizations').set(auth(U.admin)).send({ name: 'Other', slug: 'deals-proposals-other' })).body.data._id;
  U.worker = await user('worker', orgId, 'editor');
  U.client = await user('client', orgId, 'reviewer');
  U.otherMember = await user('othermember', otherOrgId, 'reviewer');

  const t = baseTerms();
  t.client = { ...t.client, userId: U.client.userId };
  t.worker = { ...t.worker, userId: U.worker.userId };
  t.milestones = [{ ...t.milestones[0], styleSample: false, payees: [{ userId: U.worker.userId, email: 'ravi@example.com', shareBp: 10000, displayName: 'Ravi' }] }];
  const s = dealService();
  let d = await s.create(String(orgId), U.worker.userId, t);
  const h = (await request(app).get(`${base()}/${d.id}`).set(auth(U.client))).body.data.termsHashNow;
  await s.sign(d.id, String(orgId), U.client.userId, h);
  await s.sign(d.id, String(orgId), U.worker.userId, h);
  d = await s.startFunding(d.id, String(orgId), U.client.userId, 'reel1');
  gw.approveOrder(d.milestones[0].funding.orderId);
  await s.confirmFunding(d.id, String(orgId), U.client.userId, 'reel1');
  await s.submitVersion(d.id, String(orgId), U.worker.userId, 'reel1', { id: 'v1', sha256: SHA });
  dealId = d.id;
  const r = await request(internal).post(`${I()}/milestones/reel1/checks`).set(svc(['deals:checks'])).send({ versionId: 'v1', sha256: SHA, results });
  expect(r.status).toBe(201);
});
afterAll(async () => {
  await mongoose.disconnect();
});

describe('gates', () => {
  test('both routes need deals:propose', async () => {
    for (const p of ['review', 'dispute-proposal']) {
      const r = await request(internal).post(`${I()}/milestones/reel1/${p}`).set(svc(['deals:read', 'deals:checks'])).send(review());
      expect(r.status).toBe(403);
    }
  });

  test('a token for another org gets 404 and nothing is stored', async () => {
    for (const p of ['review', 'dispute-proposal']) {
      const r = await request(internal).post(`${I()}/milestones/reel1/${p}`).set(svc(['deals:propose'], otherOrgId)).send(p === 'review' ? review() : {});
      expect(r.status).toBe(404);
    }
    expect((await dealService().get(dealId)).milestones[0].proposals).toBeUndefined();
  });

  test('an unknown milestone is 404', async () => {
    expect((await request(internal).post(`${I()}/milestones/nope/review`).set(svc(['deals:propose'])).send(review())).status).toBe(404);
    expect((await request(internal).post(`${I()}/milestones/nope/dispute-proposal`).set(svc(['deals:propose'])).send({})).status).toBe(404);
  });
});

describe('Review Agent proposal', () => {
  test('"too quiet" stays Fix on the failing loudness line, "more festive" is Taste; stored and shown in the deal view', async () => {
    const r = await request(internal).post(`${I()}/milestones/reel1/review`).set(svc(['deals:propose'])).send(review());
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      id: expect.stringMatching(/^rvw_/),
      agent: 'review',
      versionId: 'v1',
      items: [
        { text: 'too quiet', tag: 'fix', checklistId: 'loud' },
        { text: 'make it more festive', tag: 'taste' },
      ],
      downgraded: [],
      costsRevisionRound: true,
      decision: { allowed: true, violations: [] },
    });
    const d = await view();
    expect(d.milestones[0].proposals.review.id).toBe(r.body.data.id);
    // dry-run only: the milestone did not move and no round was used
    expect(d.milestones[0].state).toBe('IN_REVIEW');
    expect(d.milestones[0].revisionRoundsUsed).toBe(0);
    expect(d.milestones[0].changeRequests).toEqual([]);
  });

  test('a Fix that cites a passing line is stored as Taste (downgraded), as the engine would treat it', async () => {
    const r = await request(internal).post(`${I()}/milestones/reel1/review`).set(svc(['deals:propose'])).send(review({ items: [{ text: 'shorter please', tag: 'fix', checklistId: 'len' }] }));
    expect(r.status).toBe(201);
    expect(r.body.data.items[0].tag).toBe('taste');
    expect(r.body.data.downgraded).toEqual(['shorter please']);
    // only the latest review proposal is kept
    expect((await view()).milestones[0].proposals.review.id).toBe(r.body.data.id);
  });

  test('contradictions keep only valid index pairs', async () => {
    const r = await request(internal).post(`${I()}/milestones/reel1/review`).set(svc(['deals:propose'])).send(
      review({ contradictions: [{ a: 0, b: 1, why: "'louder' vs 'quieter'" }, { a: 0, b: 9, why: 'x' }, { a: 'x', b: 1 }] }),
    );
    expect(r.status).toBe(201);
    expect(r.body.data.contradictions).toEqual([{ a: 0, b: 1, why: "'louder' vs 'quieter'" }]);
  });

  test('agents cannot send amounts, stale versions, or empty lists; nothing is stored', async () => {
    const before = (await view()).milestones[0].proposals.review.id;
    const money = await request(internal).post(`${I()}/milestones/reel1/review`).set(svc(['deals:propose'])).send(review({ amountMinor: 45000 }));
    expect(money.status).toBe(422);
    expect(money.body.error.code).toBe('ai_amount_refused');
    const nested = await request(internal).post(`${I()}/milestones/reel1/review`).set(svc(['deals:propose'])).send(review({ items: [{ text: 'pay less', tag: 'fix', checklistId: 'loud', priceMinor: 1 }] }));
    expect(nested.status).toBe(422);
    const stale = await request(internal).post(`${I()}/milestones/reel1/review`).set(svc(['deals:propose'])).send(review({ versionId: 'v0' }));
    expect(stale.status).toBe(409);
    const empty = await request(internal).post(`${I()}/milestones/reel1/review`).set(svc(['deals:propose'])).send({ items: [] });
    expect(empty.status).toBe(422);
    expect((await view()).milestones[0].proposals.review.id).toBe(before);
  });
});

describe('Scope & Dispute Agent proposal', () => {
  test('before a dispute is open the split is stored but blocked (P1_state), so the UI shows a rule chip, not a button', async () => {
    const r = await request(internal).post(`${I()}/milestones/reel1/dispute-proposal`).set(svc(['deals:propose'])).send({ notes: 'loudness is the only failed line' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      id: expect.stringMatching(/^dsp_/),
      agent: 'scope_dispute',
      basis: { passedChecks: 3, totalChecks: 4, shareBp: 7500, amountMinor: 40000, remainingMinor: 40000 },
      workerMinor: 30000,
      clientMinor: 10000,
      notes: 'loudness is the only failed line',
      decision: { allowed: false },
    });
    expect(r.body.data.decision.violations.map((v) => v.rule)).toContain('P1_state');
  });

  test('agents cannot propose a split number', async () => {
    const r = await request(internal).post(`${I()}/milestones/reel1/dispute-proposal`).set(svc(['deals:propose'])).send({ workerMinor: 40000 });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('ai_amount_refused');
    expect((await request(internal).post(`${I()}/milestones/reel1/dispute-proposal`).set(svc(['deals:propose'])).send([1])).status).toBe(422);
  });

  test('with a dispute open: evidence pack from Node, 3/4 checks -> 75%, allowed if both sides accept; accepting that number captures it', async () => {
    expect((await request(app).post(`${base()}/${dealId}/milestones/reel1/dispute`).set(auth(U.client))).status).toBe(200);
    const r = await request(internal).post(`${I()}/milestones/reel1/dispute-proposal`).set(svc(['deals:propose'])).send({});
    expect(r.status).toBe(201);
    const p = r.body.data;
    expect(p.workerMinor).toBe(30000);
    expect(p.decision).toMatchObject({ allowed: true, violations: [], needsHumanApproval: false, assumed: ['both sides accept this split'] });
    expect(p.evidence.checks.find((c) => c.id === 'loud')).toMatchObject({ passed: false, measured: -20.1, evidence: [{ tStart: 0, tEnd: 2, screenshot: '/evidence/loud_002.40.jpg' }] });
    expect(p.evidence.tasteLines).toEqual(['Feels warm and festive']);
    expect(p.evidence).toMatchObject({ unmeasured: [], rounds: { included: 1, used: 0, tasteRounds: 0 }, versions: 1 });

    const d = await view(U.worker);
    expect(d.milestones[0].proposals.dispute.id).toBe(p.id);
    expect(d.milestones[0].proposals.review).toBeDefined();
    // the agents' own view carries the proposals too
    const a = await request(internal).get(I()).set(svc(['deals:read']));
    expect(a.body.data.milestones[0].proposals.dispute.workerMinor).toBe(30000);

    for (const u of [U.client, U.worker]) {
      expect((await request(app).post(`${base()}/${dealId}/milestones/reel1/split`).set(auth(u)).send({ workerMinor: p.workerMinor })).status).toBe(200);
    }
    const t = await request(app).post(`${base()}/${dealId}/tick`).set(auth(U.client));
    expect(t.status).toBe(200);
    expect(t.body.data.deal.milestones[0].capturedMinor).toBe(30000);
  });
});
