/**
 * The agents' private routes (/internal/deals) and the human side of their
 * proposals (change-order accept/decline, policy-check) over HTTP + Mongo:
 * Video QA reports with evidence, priced change orders, dry-runs, scopes,
 * and cross-org isolation (a token for org B never sees org A's deal).
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
const PASSWORD = 'P@ssw0rd-deals-internal';
let now = T0;
let gw;
let orgId;
let otherOrgId;
let dealId;
const U = {};
const SHA = 'a'.repeat(64);

const auth = (u) => ({ Authorization: `Bearer ${u.token}` });
const svc = (scopes, org = orgId) => ({
  'X-Internal-Token': config.internal.token,
  Authorization: `Bearer ${mintServiceToken({ orgId: org, userId: U.worker.userId, scopes })}`,
});
async function user(key, org, role) {
  const email = `${key}@deals-internal.example.com`;
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
const ev = [{ t_start: 0, t_end: 2, note: 'measured on the file', screenshot: 'evidence/x.jpg' }];
const results = (failLoud = false) => [
  { checklist_id: 'len', metric: 'duration_s', measured: 41.2, passed: true, evidence: ev },
  { checklist_id: 'hook', metric: 'hook_by_s', measured: 0.4, passed: true, evidence: ev },
  { checklist_id: 'logo', metric: 'logo_present', measured: true, passed: true, evidence: ev },
  { checklist_id: 'loud', metric: 'loudness_lufs', measured: failLoud ? -20.1 : -14.2, passed: !failLoud, evidence: ev },
];

beforeAll(async () => {
  await require('../../../db/mongo').connect();
  await seedDefaultRoles();
  gw = makeMockGateway({ now: () => now });
  configureDeals({ gateway: gw, now: () => new Date(now).toISOString(), publicBaseUrl: 'https://app.test' });
  U.admin = await user('admin');
  orgId = (await request(app).post('/api/v1/organizations').set(auth(U.admin)).send({ name: 'Deals Internal', slug: 'deals-internal' })).body.data._id;
  otherOrgId = (await request(app).post('/api/v1/organizations').set(auth(U.admin)).send({ name: 'Other Org', slug: 'deals-internal-other' })).body.data._id;
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
});
afterAll(async () => {
  await mongoose.disconnect();
});

describe('gates on /internal/deals', () => {
  test('needs the internal token, a service JWT, and the right scope', async () => {
    expect((await request(internal).get(I())).status).toBe(401);
    expect((await request(internal).get(I()).set({ 'X-Internal-Token': config.internal.token })).status).toBe(401);
    expect((await request(internal).get(I()).set({ ...svc(['deals:read']), 'X-Internal-Token': 'wrong' })).status).toBe(401);
    const noScope = await request(internal).post(`${I()}/milestones/reel1/checks`).set(svc(['deals:read'])).send({});
    expect(noScope.status).toBe(403);
    expect(noScope.body.error.code).toBe('insufficient_scope');
    expect((await request(internal).post(`${I()}/change-orders`).set(svc(['deals:checks'])).send({})).status).toBe(403);
  });

  test('a user JWT is not a service token', async () => {
    const r = await request(internal).get(I()).set({ 'X-Internal-Token': config.internal.token, Authorization: `Bearer ${U.worker.token}` });
    expect(r.status).toBe(401);
  });

  test('the agent view has the terms but no payee emails or PayPal ids', async () => {
    const r = await request(internal).get(I()).set(svc(['deals:read']));
    expect(r.status).toBe(200);
    expect(r.body.data.terms.milestones[0].checklist).toHaveLength(5);
    const raw = JSON.stringify(r.body.data);
    expect(raw).not.toMatch(/ravi@example\.com|authorizationId|orderId/);
  });
});

describe('cross-org isolation', () => {
  test('a token for another org gets 404 on every deal route, and changes nothing', async () => {
    const other = (s) => svc(s, otherOrgId);
    expect((await request(internal).get(I()).set(other(['deals:read']))).status).toBe(404);
    expect((await request(internal).post(`${I()}/milestones/reel1/checks`).set(other(['deals:checks'])).send({ versionId: 'v1', sha256: SHA, results: results() })).status).toBe(404);
    expect((await request(internal).post(`${I()}/policy-check`).set(other(['deals:propose'])).send({ kind: 'money', action: { kind: 'void', milestoneKey: 'reel1', reason: 'mutual' } })).status).toBe(404);
    expect((await request(internal).post(`${I()}/change-orders`).set(other(['deals:propose'])).send({ milestoneKey: 'reel1', rateCardItemId: 'extra_cut', quantity: 1, ask: 'x' })).status).toBe(404);
    const d = await dealService().get(dealId);
    expect(d.milestones[0].state).toBe('CHECKS');
    expect(d.changeOrders).toEqual([]);
  });

  test('members of another org cannot reach the public routes either', async () => {
    expect((await request(app).post(`${base()}/${dealId}/policy-check`).set(auth(U.otherMember)).send({ kind: 'money', action: { kind: 'void', milestoneKey: 'reel1', reason: 'mutual' } })).status).toBe(404);
    // using their own org in the URL does not find a deal of org A
    expect((await request(app).post(`${base(otherOrgId)}/${dealId}/policy-check`).set(auth(U.otherMember)).send({ kind: 'money', action: { kind: 'void', milestoneKey: 'reel1', reason: 'mutual' } })).status).toBe(404);
    expect((await request(app).post(`${base(otherOrgId)}/${dealId}/change-orders`).set(auth(U.otherMember)).send({ milestoneKey: 'reel1', rateCardItemId: 'extra_cut', quantity: 1, ask: 'x' })).status).toBe(404);
  });
});

describe('Video QA report -> review', () => {
  test('a report that disagrees with its own results is refused; nothing recorded', async () => {
    const r = await request(internal).post(`${I()}/milestones/reel1/checks`).set(svc(['deals:checks'])).send({ versionId: 'v1', sha256: SHA, passed: true, results: results(true) });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('inconsistent_report');
    const wrongFile = await request(internal).post(`${I()}/milestones/reel1/checks`).set(svc(['deals:checks'])).send({ versionId: 'v1', sha256: 'b'.repeat(64), results: results() });
    expect(wrongFile.status).toBe(409);
    expect(wrongFile.body.error.code).toBe('version_mismatch');
    expect((await dealService().get(dealId)).milestones[0].versions[0].checks).toBeUndefined();
  });

  test('a valid report with evidence moves the milestone to review; the client sees the evidence', async () => {
    const r = await request(internal).post(`${I()}/milestones/reel1/checks`).set(svc(['deals:checks'])).send({ versionId: 'v1', sha256: SHA, passed: false, failed: ['loud'], results: results(true), notes: { loud: 'About 6 LU too quiet.' } });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ passed: false, failed: ['loud'], reportId: expect.stringMatching(/^chk_/) });
    const d = (await request(app).get(`${base()}/${dealId}`).set(auth(U.client))).body.data;
    expect(d.milestones[0].state).toBe('IN_REVIEW');
    const checks = d.milestones[0].versions[0].checks;
    expect(checks.results.find((x) => x.checklistId === 'loud')).toMatchObject({ passed: false, measured: -20.1, evidence: [{ tStart: 0, tEnd: 2, screenshot: 'evidence/x.jpg' }] });
    expect(checks.notes).toEqual({ loud: 'About 6 LU too quiet.' });
    const again = await request(internal).post(`${I()}/milestones/reel1/checks`).set(svc(['deals:checks'])).send({ versionId: 'v1', sha256: SHA, results: results() });
    expect(again.status).toBe(409);
  });

  test('dry-run of the Review Agent proposal: Fix on the failing line stays Fix, Fix on a passing line shows as Taste', async () => {
    const r = await request(internal).post(`${I()}/policy-check`).set(svc(['deals:propose'])).send({
      kind: 'request_changes', milestoneKey: 'reel1',
      items: [{ text: 'audio is too quiet', tag: 'fix', checklistId: 'loud' }, { text: 'shorter please', tag: 'fix', checklistId: 'len' }],
    });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ allowed: true, downgraded: ['shorter please'], costsRevisionRound: true });
  });
});

describe('change orders', () => {
  let coId;
  test('the Scope Agent drafts one priced from the rate card; an invented price is blocked (P11)', async () => {
    const bad = await request(internal).post(`${I()}/change-orders`).set(svc(['deals:propose'])).send({ milestoneKey: 'reel1', rateCardItemId: 'extra_cut', quantity: 2, amountMinor: 50000, ask: 'two 15s cutdowns' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.map((v) => v.rule)).toContain('P11_rate_card');
    const r = await request(internal).post(`${I()}/change-orders`).set(svc(['deals:propose'])).send({ milestoneKey: 'reel1', rateCardItemId: 'extra_cut', quantity: 2, amountMinor: 12000, ask: 'two 15s cutdowns' });
    expect(r.status).toBe(201);
    expect(r.body.data.changeOrder).toMatchObject({ amountMinor: 12000, status: 'draft', by: 'agent' });
    expect(r.body.data.decision.allowed).toBe(true);
    coId = r.body.data.changeOrder.id;
  });

  test('a party may draft one too; the price ignores what the request says', async () => {
    const r = await request(app).post(`${base()}/${dealId}/change-orders`).set(auth(U.worker)).send({ milestoneKey: 'reel1', rateCardItemId: 'revision_round', quantity: 1, ask: 'one more round' });
    expect(r.status).toBe(201);
    expect(r.body.data.changeOrder).toMatchObject({ amountMinor: 4000, by: 'worker' });
    const decline = await request(app).post(`${base()}/${dealId}/change-orders/${r.body.data.changeOrder.id}/decline`).set(auth(U.client));
    expect(decline.status).toBe(200);
    expect(decline.body.data.deal.changeOrders.find((c) => c.id === r.body.data.changeOrder.id).status).toBe('declined');
  });

  test('only the client accepts; accepting drafts the PayPal invoice through policy, once', async () => {
    const w = await request(app).post(`${base()}/${dealId}/change-orders/${coId}/accept`).set(auth(U.worker));
    expect(w.status).toBe(403);
    const before = gw.calls.filter((c) => c.op === 'invoice').length;
    const r = await request(app).post(`${base()}/${dealId}/change-orders/${coId}/accept`).set(auth(U.client));
    expect(r.status).toBe(200);
    expect(r.body.data.result.outcome).toBe('done');
    expect(r.body.data.deal.changeOrders.find((c) => c.id === coId)).toMatchObject({ status: 'invoiced', invoiceId: expect.any(String) });
    const twice = await request(app).post(`${base()}/${dealId}/change-orders/${coId}/accept`).set(auth(U.client));
    expect(twice.status).toBe(409);
    expect(gw.calls.filter((c) => c.op === 'invoice').length - before).toBe(1);
    const l = (await request(app).get(`${base()}/${dealId}/ledger`).set(auth(U.client))).body.data;
    expect(l.chain.ok).toBe(true);
    expect(l.entries[l.entries.length - 1]).toMatchObject({ type: 'invoice', moved: false, amountMinor: 12000 });
  });

  test('the client UI can dry-run too (same policy), and a capture before approval is blocked', async () => {
    const r = await request(app).post(`${base()}/${dealId}/policy-check`).set(auth(U.client)).send({ kind: 'money', action: { kind: 'capture', milestoneKey: 'reel1', amountMinor: 40000, versionId: 'v1', final: true, reason: 'approval' } });
    expect(r.status).toBe(200);
    expect(r.body.data.allowed).toBe(false);
    expect(r.body.data.violations.map((v) => v.rule)).toEqual(expect.arrayContaining(['P1_state', 'P6_version']));
  });
});
