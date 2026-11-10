/**
 * Deal team over HTTP: the client picks who is paid for a milestone and the
 * split on a draft; the server enforces members-only and shares = 100%; a
 * signed deal refuses (payees move money); amounts are never taken from the
 * request.
 */
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../../../app');
const { seedDefaultRoles } = require('../../../seed/roles');
const { configureDeals } = require('../service.cts');
const { makeMockGateway } = require('../paypal.cts');
const { terms: baseTerms } = require('./fixtures');

const PASSWORD = 'P@ssw0rd-deals-team';
let orgId;
let dealId;
const U = {};

const auth = (u) => ({ Authorization: `Bearer ${u.token}` });
async function user(key, role) {
  const email = `${key}@deals-team.example.com`;
  await request(app).post('/api/v1/auth/register').send({ name: `${key[0].toUpperCase()}${key.slice(1)}`, email, password: PASSWORD });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  const out = { token: login.body.data.accessToken, userId: login.body.data.user._id, email };
  if (role) {
    const add = await request(app).post(`/api/v1/organizations/${orgId}/members`).set(auth(U.admin)).send({ email, role });
    expect(add.statusCode).toBe(201);
  }
  return out;
}
const base = () => `/api/v1/organizations/${orgId}/deals`;
const team = (rest = '') => `${base()}/${dealId}/milestones/reel1/team${rest}`;

beforeAll(async () => {
  await require('../../../db/mongo').connect();
  await seedDefaultRoles();
  configureDeals({ gateway: makeMockGateway(), publicBaseUrl: 'https://app.test' });
  U.admin = await user('admin');
  const org = await request(app).post('/api/v1/organizations').set(auth(U.admin)).send({ name: 'Deals Team', slug: 'deals-team' });
  orgId = org.body.data._id;
  U.worker = await user('ravi', 'editor');
  U.motion = await user('sana', 'editor');
  U.client = await user('client', 'reviewer');
  U.outsider = await user('outsider');

  const t = baseTerms();
  t.client = { ...t.client, userId: U.client.userId };
  t.worker = { ...t.worker, userId: U.worker.userId };
  t.milestones = [t.milestones[0]];
  t.milestones[0].payees = [{ userId: U.worker.userId, email: 'ravi@example.com', shareBp: 10000, displayName: 'Editor' }];
  const r = await request(app).post(base()).set(auth(U.client)).send({ terms: t });
  expect(r.status).toBe(201);
  dealId = r.body.data.id;
});
afterAll(async () => {
  await mongoose.disconnect();
});

describe('deal team', () => {
  test('dry run: shares that do not add up to 100% are refused with T4, nothing saved', async () => {
    const r = await request(app)
      .post(team('/check'))
      .set(auth(U.client))
      .send({ payees: [{ userId: U.worker.userId, shareBp: 6000 }, { userId: U.motion.userId, shareBp: 3000 }] });
    expect(r.status).toBe(200);
    expect(r.body.data.allowed).toBe(false);
    expect(r.body.data.violations.map((v) => v.rule)).toEqual(['T4_total_100']);
    const save = await request(app)
      .put(team())
      .set(auth(U.client))
      .send({ payees: [{ userId: U.worker.userId, shareBp: 6000 }, { userId: U.motion.userId, shareBp: 3000 }] });
    expect(save.status).toBe(422);
    expect(save.body.error.code).toBe('shares_not_100');
    const d = (await request(app).get(`${base()}/${dealId}`).set(auth(U.client))).body.data;
    expect(d.terms.milestones[0].payees).toHaveLength(1);
  });

  test('the client sets Leo 70% / Maya 30%; amounts come from the milestone, not the request', async () => {
    const r = await request(app)
      .put(team())
      .set(auth(U.client))
      .send({
        payees: [
          { userId: U.worker.userId, shareBp: 7000, amountMinor: 1 },
          { userId: U.motion.userId, shareBp: 3000, label: 'Motion designer', email: 'attacker@evil.test' },
        ],
      });
    expect(r.status).toBe(200);
    const payees = r.body.data.terms.milestones[0].payees;
    expect(payees).toEqual([
      { userId: U.worker.userId, email: 'ravi@example.com', shareBp: 7000, displayName: 'Editor' },
      { userId: U.motion.userId, email: U.motion.email, shareBp: 3000, displayName: 'Motion designer' },
    ]);
    expect(r.body.plan.payees.map((p) => p.amountMinor)).toEqual([28000, 12000]);
    expect(r.body.data.problems).toEqual([]);
  });

  test('only the client picks the team', async () => {
    const r = await request(app).put(team()).set(auth(U.worker)).send({ payees: [{ userId: U.worker.userId, shareBp: 10000 }] });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('client_only');
  });

  test('payees must be active members of the org, once each', async () => {
    const out = await request(app)
      .put(team())
      .set(auth(U.client))
      .send({ payees: [{ userId: U.worker.userId, shareBp: 5000 }, { userId: U.outsider.userId, shareBp: 5000 }] });
    expect(out.status).toBe(422);
    expect(out.body.error.details.map((v) => v.rule)).toContain('T5_member');
    const dup = await request(app)
      .post(team('/check'))
      .set(auth(U.client))
      .send({ payees: [{ userId: U.worker.userId, shareBp: 5000 }, { userId: U.worker.userId, shareBp: 5000 }] });
    expect(dup.body.data.violations.map((v) => v.rule)).toContain('T3_shape');
    const none = await request(app).post(team('/check')).set(auth(U.client)).send({ payees: [] });
    expect(none.body.data.allowed).toBe(false);
  });

  test('editing the team clears a signature: both sign the new split', async () => {
    const d = (await request(app).get(`${base()}/${dealId}`).set(auth(U.client))).body.data;
    await request(app).post(`${base()}/${dealId}/sign`).set(auth(U.worker)).send({ termsHash: d.termsHashNow }).expect(200);
    const r = await request(app)
      .put(team())
      .set(auth(U.client))
      .send({ payees: [{ userId: U.worker.userId, shareBp: 7000 }, { userId: U.motion.userId, shareBp: 3000, label: 'Motion designer' }] });
    expect(r.status).toBe(200);
    expect(r.body.data.signatures).toEqual([]);
    expect(r.body.plan.clearsSignatures).toBe(true);
  });

  test('once both sides sign, the team is locked: 409 deal_locked, and the dry run says T2', async () => {
    const d = (await request(app).get(`${base()}/${dealId}`).set(auth(U.client))).body.data;
    await request(app).post(`${base()}/${dealId}/sign`).set(auth(U.client)).send({ termsHash: d.termsHashNow }).expect(200);
    await request(app).post(`${base()}/${dealId}/sign`).set(auth(U.worker)).send({ termsHash: d.termsHashNow }).expect(200);
    const r = await request(app).put(team()).set(auth(U.client)).send({ payees: [{ userId: U.worker.userId, shareBp: 10000 }] });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('deal_locked');
    const c = await request(app).post(team('/check')).set(auth(U.client)).send({ payees: [{ userId: U.worker.userId, shareBp: 10000 }] });
    expect(c.body.data.violations.map((v) => v.rule)).toContain('T2_signed_terms');
    const after = (await request(app).get(`${base()}/${dealId}`).set(auth(U.client))).body.data;
    expect(after.terms.milestones[0].payees.map((p) => p.shareBp)).toEqual([7000, 3000]);
  });

  test('an unknown milestone is a 404', async () => {
    const r = await request(app).put(`${base()}/${dealId}/milestones/nope/team`).set(auth(U.client)).send({ payees: [] });
    expect(r.status).toBe(404);
  });
});
