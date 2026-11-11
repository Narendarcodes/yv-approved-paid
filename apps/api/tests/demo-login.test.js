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
const demoLogin = (body = {}) => request(app).post(`${API}/auth/demo-login`).send(body);

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
    expect((await demoLogin({ as: 'editor' })).status).toBe(404);
    process.env.DEMO_MODE = 'true';
    expect((await demoLogin()).status).toBe(404);
    expect((await demoLogin({ as: 'editor' })).status).toBe(404);
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
    expect(r.body.data.demo).toEqual({
      as: 'judge',
      dealId: DEMO.dealId,
      organizationId: seeded.orgId,
    });
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

  test('as: anything but judge or editor is a 400 (no other account can be opened)', async () => {
    process.env.DEMO_MODE = '1';
    for (const as of [
      'admin',
      'reviewer',
      'motion',
      'Editor',
      '',
      1,
      null,
      ['editor'],
      { as: 'editor' },
    ]) {
      store.clear(); // bad requests count against the same per-IP limit
      const r = await demoLogin({ as });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('validation_error');
      expect(r.headers['set-cookie']).toBeUndefined();
    }
  });

  test("as: 'editor' signs in as Leo Carter (crew view); My money shows his reel 1 share", async () => {
    process.env.DEMO_MODE = '1';
    const seeded = await seedDealDemo({ evidenceDir: false });
    const r = await demoLogin({ as: 'editor' });
    expect(r.status).toBe(200);
    expect(r.body.data.user.email).toBe(DEMO.editor.email);
    expect(r.body.data.user.role).toBe('editor');
    expect(r.body.data.demo).toEqual({
      as: 'editor',
      dealId: DEMO.dealId,
      organizationId: seeded.orgId,
    });
    const c = cookiesOf(r);
    expect(c.accessToken.attrs).toContain('httponly');
    const jar = [`accessToken=${c.accessToken.value}`, `csrfToken=${c.csrfToken.value}`];

    const deal = `${API}/organizations/${seeded.orgId}/deals/${DEMO.dealId}`;
    const view = await request(app).get(deal).set('Cookie', jar);
    expect(view.status).toBe(200);
    expect(view.body.data.me).toBe('worker');

    const money = await request(app)
      .get(`${API}/organizations/${seeded.orgId}/deals/my-money`)
      .set('Cookie', jar);
    expect(money.status).toBe(200);
    const text = JSON.stringify(money.body.data);
    expect(text).toContain(DEMO.dealId);
    expect(text).toContain('28000'); // Leo's 70% of reel 1's $400
  });

  test('Leo (editor) still cannot approve, capture or move money: permissions unchanged', async () => {
    process.env.DEMO_MODE = '1';
    const seeded = await seedDealDemo({ evidenceDir: false });
    const r = await demoLogin({ as: 'editor' });
    const c = cookiesOf(r);
    const jar = [`accessToken=${c.accessToken.value}`, `csrfToken=${c.csrfToken.value}`];
    const deal = `${API}/organizations/${seeded.orgId}/deals/${DEMO.dealId}`;
    const post = (path, body = {}) =>
      request(app)
        .post(`${deal}${path}`)
        .set('Cookie', jar)
        .set('X-CSRF-Token', c.csrfToken.value)
        .send(body);
    const before = (await request(app).get(deal).set('Cookie', jar)).body.data;
    const v3 = before.milestones.find((m) => m.key === 'reel3').versions[0];

    const approve = await post('/milestones/reel3/approve', {
      versionId: v3.id,
      sha256: v3.sha256,
    });
    expect(approve.status).toBe(403);
    const clockApprove = await post('/milestones/reel3/clock/approve', {
      versionId: v3.id,
      sha256: v3.sha256,
    });
    expect(clockApprove.status).toBe(403);
    const bulk = await request(app)
      .post(`${API}/organizations/${seeded.orgId}/deals/payables/bulk-approve`)
      .set('Cookie', jar)
      .set('X-CSRF-Token', c.csrfToken.value)
      .send({ items: [{ dealId: DEMO.dealId, milestoneKey: 'reel3' }], dryRun: false });
    // bulk approve answers per item: the crew member's item is refused and nothing moves
    expect(bulk.status).toBe(200);
    expect(bulk.body.data.moved).toBe(false);
    expect(bulk.body.data.items).toHaveLength(1);
    expect(bulk.body.data.items[0]).toMatchObject({ ok: false, capturedMinor: 0, paidOutMinor: 0 });

    const after = (await request(app).get(deal).set('Cookie', jar)).body.data;
    for (const k of ['reel1', 'reel2', 'reel3', 'reel4']) {
      const a = after.milestones.find((m) => m.key === k);
      const b = before.milestones.find((m) => m.key === k);
      expect([a.state, a.capturedMinor, a.paidOutMinor]).toEqual([
        b.state,
        b.capturedMinor,
        b.paidOutMinor,
      ]);
    }
  });

  test('rate-limited per IP: 429 with Retry-After past the limit', async () => {
    process.env.DEMO_MODE = '1';
    for (let i = 0; i < 4; i += 1) expect((await demoLogin()).status).toBe(200);
    expect((await demoLogin({ as: 'editor' })).status).toBe(200);
    // one shared per-IP budget across both people
    const r = await demoLogin({ as: 'editor' });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('rate_limited');
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  });
});
