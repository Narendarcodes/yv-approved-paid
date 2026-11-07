/**
 * Review clock terms on a draft over HTTP: a party sets (or removes) the clock
 * on one milestone before signing, with the same validation the signing rules
 * use (validateTerms' clock rules), a dry run that previews when review would
 * end, a backup reviewer that must be an org member (and not the editor), and
 * a lock once both sides sign.
 */
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../../../app');
const { seedDefaultRoles } = require('../../../seed/roles');
const { configureDeals } = require('../service.cts');
const { makeMockGateway } = require('../paypal.cts');
const { terms: baseTerms } = require('./fixtures');

const PASSWORD = 'P@ssw0rd-clock-terms';
let orgId;
let dealId;
const U = {};

const auth = (u) => ({ Authorization: `Bearer ${u.token}` });
async function user(key, role) {
  const email = `${key}@clock-terms.example.com`;
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
const ct = (rest = '') => `${base()}/${dealId}/milestones/reel1/clock-terms${rest}`;
const GOOD = () => ({ reviewWindowBusinessDays: 3, partialReleasePct: 50, graceBusinessDays: 3, includedRevisionRounds: 2, backupReviewerId: U.backup.userId });

beforeAll(async () => {
  await require('../../../db/mongo').connect();
  await seedDefaultRoles();
  configureDeals({ gateway: makeMockGateway(), publicBaseUrl: 'https://app.test' });
  U.admin = await user('admin');
  const org = await request(app).post('/api/v1/organizations').set(auth(U.admin)).send({ name: 'Clock Terms', slug: 'clock-terms' });
  orgId = org.body.data._id;
  U.worker = await user('ravi', 'editor');
  U.client = await user('client', 'reviewer');
  U.backup = await user('backup', 'reviewer');
  U.outsider = await user('outsider');
  const t = baseTerms();
  t.client = { ...t.client, userId: U.client.userId, country: 'IN' };
  t.worker = { ...t.worker, userId: U.worker.userId };
  t.milestones = [{ ...t.milestones[0], styleSample: false }];
  t.milestones[0].payees = [{ userId: U.worker.userId, email: 'ravi@example.com', shareBp: 10000, displayName: 'Editor' }];
  const r = await request(app).post(base()).set(auth(U.client)).send({ terms: t });
  expect(r.status).toBe(201);
  dealId = r.body.data.id;
});
afterAll(async () => {
  await mongoose.disconnect();
});

describe('review clock terms on a draft', () => {
  test('dry run: valid terms preview when review ends; nothing is saved', async () => {
    const r = await request(app).post(ct('/check')).set(auth(U.client)).send({ clock: GOOD() });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ allowed: true, problems: [], locked: false });
    expect(r.body.data.clock).toMatchObject({ reviewWindowBusinessDays: 3, partialReleasePct: 50, country: 'IN', tz: 'Asia/Kolkata' });
    const p = r.body.data.preview;
    expect(Date.parse(p.deadline)).toBeGreaterThan(Date.parse(p.deliverAt));
    expect(Date.parse(p.graceDeadline)).toBeGreaterThan(Date.parse(p.deadline));
    expect(p.deadlineText).toMatch(/6:00 PM IST$/);
    expect(p.partialAmountMinor + p.remainderMinor).toBe(40000);
    expect(p.line).toMatch(/^If no reply by .+, .+ \(50%\) releases to the team\.$/);
    const d = (await request(app).get(`${base()}/${dealId}`).set(auth(U.client))).body.data;
    expect(d.terms.milestones[0].clock).toBeUndefined();
  });

  test('out-of-range values and unknown fields are refused with the clock rules, 422 on save', async () => {
    const c = await request(app).post(ct('/check')).set(auth(U.client)).send({ clock: { ...GOOD(), reviewWindowBusinessDays: 1 } });
    expect(c.body.data.allowed).toBe(false);
    expect(c.body.data.problems.join(' ')).toMatch(/reviewWindowBusinessDays must be a whole number from 2 to 10/);
    const pct = await request(app).put(ct()).set(auth(U.client)).send({ clock: { ...GOOD(), partialReleasePct: 95 } });
    expect(pct.status).toBe(422);
    expect(pct.body.error.code).toBe('invalid_terms');
    const odd = await request(app).post(ct('/check')).set(auth(U.client)).send({ clock: { ...GOOD(), releaseEverything: true } });
    expect(odd.body.data.problems).toContain('unknown clock field releaseEverything');
    const bad = await request(app).post(ct('/check')).set(auth(U.client)).send({ clock: 'fast' });
    expect(bad.body.data.allowed).toBe(false);
  });

  test('the backup reviewer must be an org member and cannot be the editor', async () => {
    const out = await request(app).put(ct()).set(auth(U.client)).send({ clock: { ...GOOD(), backupReviewerId: U.outsider.userId } });
    expect(out.status).toBe(422);
    expect(out.body.error.message).toMatch(/member of this organization/);
    const ed = await request(app).post(ct('/check')).set(auth(U.client)).send({ clock: { ...GOOD(), backupReviewerId: U.worker.userId } });
    expect(ed.body.data.problems[0]).toMatch(/cannot be the editor/);
  });

  test('outsiders cannot edit; a party saves, which clears a signature', async () => {
    const no = await request(app).put(ct()).set(auth(U.outsider)).send({ clock: GOOD() });
    expect([403, 404]).toContain(no.status);
    const d0 = (await request(app).get(`${base()}/${dealId}`).set(auth(U.client))).body.data;
    await request(app).post(`${base()}/${dealId}/sign`).set(auth(U.worker)).send({ termsHash: d0.termsHashNow }).expect(200);
    const r = await request(app).put(ct()).set(auth(U.client)).send({ clock: GOOD() });
    expect(r.status).toBe(200);
    expect(r.body.data.deal.terms.milestones[0].clock).toEqual(GOOD());
    expect(r.body.data.deal.signatures).toEqual([]);
    expect(r.body.data.deal.problems).toEqual([]);
    expect(r.body.data.preview.deadlineText).toBeTruthy();
  });

  test('clock: null removes the clock', async () => {
    const r = await request(app).put(ct()).set(auth(U.worker)).send({ clock: null });
    expect(r.status).toBe(200);
    expect(r.body.data.deal.terms.milestones[0].clock).toBeUndefined();
    await request(app).put(ct()).set(auth(U.client)).send({ clock: GOOD() }).expect(200);
  });

  test('once both sides sign, clock terms are locked: 409 deal_locked; the dry run says locked', async () => {
    const d = (await request(app).get(`${base()}/${dealId}`).set(auth(U.client))).body.data;
    await request(app).post(`${base()}/${dealId}/sign`).set(auth(U.client)).send({ termsHash: d.termsHashNow }).expect(200);
    await request(app).post(`${base()}/${dealId}/sign`).set(auth(U.worker)).send({ termsHash: d.termsHashNow }).expect(200);
    const r = await request(app).put(ct()).set(auth(U.client)).send({ clock: { ...GOOD(), partialReleasePct: 0 } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('deal_locked');
    const c = await request(app).post(ct('/check')).set(auth(U.client)).send({ clock: GOOD() });
    expect(c.body.data.locked).toBe(true);
    const after = (await request(app).get(`${base()}/${dealId}`).set(auth(U.client))).body.data;
    expect(after.terms.milestones[0].clock.partialReleasePct).toBe(50);
  });
});
