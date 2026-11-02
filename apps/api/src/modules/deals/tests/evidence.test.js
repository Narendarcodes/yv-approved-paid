/**
 * Evidence screenshots (Phase 4 gap 2): GET /deals/:dealId/evidence/:file serves
 * only image names that this deal's stored check results reference, from inside
 * the evidence dir, to signed-in parties of the deal's org. Everything else 404s:
 * traversal, encoded traversal, symlinks out of the dir, unreferenced files,
 * other deals' files, other orgs.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
const PASSWORD = 'P@ssw0rd-deals-evidence';
const SHA = 'e'.repeat(64);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
let now = T0;
let gw;
let orgId;
let otherOrgId;
let dealId;
let otherDealId;
let root;
let outside;
const U = {};

const auth = (u) => ({ Authorization: `Bearer ${u.token}` });
async function user(key, org, role) {
  const email = `${key}@deals-evidence.example.com`;
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
const E = (file, id = dealId, o = orgId) => `${base(o)}/${id}/evidence/${file}`;

async function dealWithChecks(shots) {
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
  const ev = (shot) => [{ t_start: 0, t_end: 1, note: 'frame', screenshot: shot }];
  const results = ['len', 'hook', 'logo', 'loud'].map((id, i) => ({ checklist_id: id, metric: 'm', measured: 1, passed: true, evidence: ev(shots[i]) }));
  const r = await request(internal)
    .post(`/internal/deals/${d.id}/milestones/reel1/checks`)
    .set({ 'X-Internal-Token': config.internal.token, Authorization: `Bearer ${mintServiceToken({ orgId, userId: U.worker.userId, scopes: ['deals:checks'] })}` })
    .send({ versionId: 'v1', sha256: SHA, results });
  expect(r.status).toBe(201);
  return d.id;
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yv-evidence-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'yv-outside-'));
  process.env.DEALS_EVIDENCE_DIR = root;
  await require('../../../db/mongo').connect();
  await seedDefaultRoles();
  gw = makeMockGateway({ now: () => now });
  configureDeals({ gateway: gw, now: () => new Date(now).toISOString(), publicBaseUrl: 'https://app.test' });
  U.admin = await user('admin');
  orgId = (await request(app).post('/api/v1/organizations').set(auth(U.admin)).send({ name: 'Deals Evidence', slug: 'deals-evidence' })).body.data._id;
  otherOrgId = (await request(app).post('/api/v1/organizations').set(auth(U.admin)).send({ name: 'Other', slug: 'deals-evidence-other' })).body.data._id;
  U.worker = await user('worker', orgId, 'editor');
  U.client = await user('client', orgId, 'reviewer');
  U.bystander = await user('bystander', orgId, 'reviewer');
  U.otherMember = await user('othermember', otherOrgId, 'reviewer');

  dealId = await dealWithChecks(['/agent/evidence/loud_002.40.jpg', 'len_041.10.jpg', 'link_000.00.jpg', '../../secret_000.00.png']);
  otherDealId = await dealWithChecks(['other_001.00.jpg', 'other_001.00.jpg', 'other_001.00.jpg', 'other_001.00.jpg']);

  fs.writeFileSync(path.join(root, 'loud_002.40.jpg'), JPEG);
  fs.mkdirSync(path.join(root, dealId));
  fs.writeFileSync(path.join(root, dealId, 'len_041.10.jpg'), JPEG);
  fs.writeFileSync(path.join(root, 'unreferenced_000.00.jpg'), JPEG);
  fs.writeFileSync(path.join(root, 'other_001.00.jpg'), JPEG);
  fs.writeFileSync(path.join(outside, 'secret.jpg'), Buffer.from('not for you'));
  fs.writeFileSync(path.join(outside, 'secret_000.00.png'), Buffer.from('not for you'));
  fs.symlinkSync(path.join(outside, 'secret.jpg'), path.join(root, 'link_000.00.jpg'));
});
afterAll(async () => {
  delete process.env.DEALS_EVIDENCE_DIR;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  await mongoose.disconnect();
});

describe('evidence screenshots', () => {
  test('a party gets a referenced frame (flat or under the deal folder) as an image', async () => {
    const r = await request(app).get(E('loud_002.40.jpg')).set(auth(U.client));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/image\/jpeg/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toMatch(/private/);
    expect(Buffer.compare(r.body, JPEG)).toBe(0);
    expect((await request(app).get(E('len_041.10.jpg')).set(auth(U.worker))).status).toBe(200);
  });

  test('signed out is 401', async () => {
    expect((await request(app).get(E('loud_002.40.jpg'))).status).toBe(401);
  });

  test("a file in the dir that this deal does not reference is 404, including another deal's frame", async () => {
    expect((await request(app).get(E('unreferenced_000.00.jpg')).set(auth(U.client))).status).toBe(404);
    expect((await request(app).get(E('other_001.00.jpg')).set(auth(U.client))).status).toBe(404);
    expect((await request(app).get(E('other_001.00.jpg', otherDealId)).set(auth(U.client))).status).toBe(200);
  });

  test('traversal and odd names are 404', async () => {
    for (const f of [
      '..%2F..%2Fetc%2Fpasswd',
      '%2e%2e%2fsecret.jpg',
      '..%5Csecret.jpg',
      '.hidden.jpg',
      'loud_002.40.jpg%00.txt',
      'loud_002.40.JPG.exe',
      'secret_000.00.png', // referenced as ../../secret_000.00.png: only the base name counts, and it is not in the dir
      'a'.repeat(200) + '.jpg',
    ]) {
      const r = await request(app).get(E(f)).set(auth(U.client));
      expect([400, 404]).toContain(r.status);
      expect(JSON.stringify(r.body || '')).not.toMatch(/not for you|root:/);
    }
    const raw = await request(app).get(`${base()}/${dealId}/evidence/../../../../etc/passwd`).set(auth(U.client));
    expect(raw.status).toBe(404);
  });

  test('a referenced name that is a symlink out of the evidence dir is 404', async () => {
    const r = await request(app).get(E('link_000.00.jpg')).set(auth(U.client));
    expect(r.status).toBe(404);
  });

  test('cross-org and non-party members get 404', async () => {
    expect((await request(app).get(E('loud_002.40.jpg')).set(auth(U.otherMember))).status).toBe(404);
    expect((await request(app).get(E('loud_002.40.jpg', dealId, otherOrgId)).set(auth(U.otherMember))).status).toBe(404);
    expect((await request(app).get(E('loud_002.40.jpg')).set(auth(U.bystander))).status).toBe(404);
  });

  test('a referenced file that is missing on disk is 404', async () => {
    fs.unlinkSync(path.join(root, 'loud_002.40.jpg'));
    expect((await request(app).get(E('loud_002.40.jpg')).set(auth(U.client))).status).toBe(404);
  });
});
