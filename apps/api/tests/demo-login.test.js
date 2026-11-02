/**
 * Phase 4 gap 5: POST /auth/demo-login. 404 unless DEMO_MODE=1; 503 until the
 * demo is seeded; then one tap gives the seeded judge the normal cookie session
 * (httpOnly access/refresh + CSRF double-submit), rate-limited per IP. With that
 * session the judge can finish the seeded dispute: accept the 80% split and the
 * Money Agent captures exactly that.
 */
process.env.AUTH_DEMO_IP_MAX = '5';

const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const authRouter = require('../src/routes/auth');
const { configureDeals } = require('../src/modules/deals/service.cts');
const { makeMockGateway } = require('../src/modules/deals/paypal.cts');
const { DEMO, seedDealDemo } = require('../src/modules/deals/demo.cts');

const API = '/api/v1';
const store = authRouter.limits.store;
const demoLogin = () => request(app).post(`${API}/auth/demo-login`).send({});

function cookiesOf(res) {
  const out = {};
  for (const line of res.headers['set-cookie'] || []) {
    const [pair, ...attrs] = line.split(';').map((s) => s.trim());
    const i = pair.indexOf('=');
    out[pair.slice(0, i)] = {
      value: decodeURIComponent(pair.slice(i + 1)),
      attrs: attrs.map((a) => a.toLowerCase()),
    };
  }
  return out;
}

beforeAll(async () => {
  await require('../src/db/mongo').connect();
  configureDeals({ gateway: makeMockGateway() });
});
beforeEach(() => store.clear());
afterAll(async () => {
  delete process.env.DEMO_MODE;
  await mongoose.disconnect();
});

describe('POST /auth/demo-login', () => {
  test('404 when DEMO_MODE is not 1', async () => {
    delete process.env.DEMO_MODE;
    expect((await demoLogin()).status).toBe(404);
    process.env.DEMO_MODE = 'true';
    expect((await demoLogin()).status).toBe(404);
  });

  test('503 when the demo is not seeded yet', async () => {
    process.env.DEMO_MODE = '1';
    const r = await demoLogin();
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('demo_not_seeded');
  });

  test('after seeding: a cookie session for the judge with CSRF, landing on the demo deal; the judge finishes the dispute', async () => {
    process.env.DEMO_MODE = '1';
    const seeded = await seedDealDemo({ evidenceDir: false });
    const r = await demoLogin();
    expect(r.status).toBe(200);
    expect(r.body.data.user.email).toBe(DEMO.judge.email);
    expect(r.body.data.demo).toEqual({ dealId: DEMO.dealId, organizationId: seeded.orgId });
    expect(r.body.data.refreshToken).toBeUndefined();
    const c = cookiesOf(r);
    expect(c.accessToken.attrs).toContain('httponly');
    expect(c.refreshToken.attrs).toContain('httponly');
    expect(c.csrfToken.value).toBe(r.body.data.csrfToken);

    const jar = [`accessToken=${c.accessToken.value}`, `csrfToken=${c.csrfToken.value}`];
    const me = await request(app).get(`${API}/auth/me`).set('Cookie', jar);
    expect(me.status).toBe(200);

    const deal = `${API}/organizations/${seeded.orgId}/deals/${DEMO.dealId}`;
    const view = await request(app).get(deal).set('Cookie', jar);
    expect(view.status).toBe(200);
    expect(view.body.data.me).toBe('client');

    // cookie sessions need the CSRF header on unsafe methods
    const noCsrf = await request(app)
      .post(`${deal}/milestones/reel2/split`)
      .set('Cookie', jar)
      .send({ workerMinor: 24000 });
    expect(noCsrf.status).toBe(403);
    const split = await request(app)
      .post(`${deal}/milestones/reel2/split`)
      .set('Cookie', jar)
      .set('X-CSRF-Token', c.csrfToken.value)
      .send({ workerMinor: 24000 });
    expect(split.status).toBe(200);
    const tick = await request(app)
      .post(`${deal}/tick`)
      .set('Cookie', jar)
      .set('X-CSRF-Token', c.csrfToken.value);
    expect(tick.status).toBe(200);
    const m = tick.body.data.deal.milestones.find((x) => x.key === 'reel2');
    expect(m.capturedMinor).toBe(24000);
  });

  test('rate-limited per IP: 429 with Retry-After past the limit', async () => {
    process.env.DEMO_MODE = '1';
    for (let i = 0; i < 5; i += 1) expect((await demoLogin()).status).toBe(200);
    const r = await demoLogin();
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('rate_limited');
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  });
});
