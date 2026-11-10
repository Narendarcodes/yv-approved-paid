/**
 * Crew members see only their own payout lines everywhere, not just on the
 * payout-receipts endpoint: GET /deals/:id, the deal list, the ledger (and its
 * totals), Money Agent results from a tick, the payables board and the live
 * ledger socket. The brand and deal managers who are not on the crew keep the
 * full view. Leo (lead editor, editor role = can manage deals) 70%, Maya 30%
 * of a $400 milestone: Leo 28000, Maya 12000.
 */
const http = require('node:http');
const request = require('supertest');
const mongoose = require('mongoose');
const { io: connect } = require('socket.io-client');
const app = require('../../../app');
const { initSocketServer } = require('../../../realtime/socket');
const { seedDefaultRoles } = require('../../../seed/roles');
const { configureDeals, dealService } = require('../service.cts');
const { makeMockGateway } = require('../paypal.cts');
const { terms: baseTerms, T0, DAY } = require('./fixtures');

const PASSWORD = 'P@ssw0rd-payout-visibility';
let now = T0 + 20 * DAY;
let gw;
let orgId;
const U = {};
const sockets = [];
let server;
let url;

const auth = (u) => ({ Authorization: `Bearer ${u.token}` });
const iso = () => new Date(now).toISOString();
const base = () => `/api/v1/organizations/${orgId}/deals`;
const M = (dealId, key = 'reel1') => `${base()}/${dealId}/milestones/${key}`;

async function user(key, role) {
  const email = `${key}@payout-visibility.example.com`;
  await request(app).post('/api/v1/auth/register').send({ name: key, email, password: PASSWORD });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  const out = { token: login.body.data.accessToken, userId: login.body.data.user._id, email };
  if (role) {
    const add = await request(app)
      .post(`/api/v1/organizations/${orgId}/members`)
      .set(auth(U.admin))
      .send({ email, role });
    expect(add.statusCode).toBe(201);
  }
  return out;
}

function dealTerms() {
  const t = baseTerms();
  t.client = { ...t.client, userId: U.client.userId, country: 'IN' };
  t.worker = { ...t.worker, userId: U.worker.userId };
  t.milestones = [{ ...t.milestones[0], styleSample: false }];
  t.milestones[0].payees = [
    { userId: U.worker.userId, email: 'ravi@example.com', shareBp: 7000, displayName: 'Leo' },
    { userId: U.motion.userId, email: 'sana@example.com', shareBp: 3000, displayName: 'Maya' },
  ];
  return t;
}

async function signedFundedApproved() {
  const r = await request(app).post(base()).set(auth(U.worker)).send({ terms: dealTerms() });
  expect(r.status).toBe(201);
  const dealId = r.body.data.id;
  const h = r.body.data.termsHashNow;
  for (const who of [U.client, U.worker])
    await request(app)
      .post(`${base()}/${dealId}/sign`)
      .set(auth(who))
      .send({ termsHash: h })
      .expect(200);
  const f = await request(app)
    .post(`${M(dealId)}/fund`)
    .set(auth(U.client))
    .expect(200);
  gw.approveOrder(f.body.data.milestones[0].funding.orderId);
  await request(app)
    .post(`${M(dealId)}/fund/confirm`)
    .set(auth(U.client))
    .expect(200);
  await request(app)
    .post(`${M(dealId)}/versions`)
    .set(auth(U.worker))
    .send({ versionId: 'v1', sha256: 'v1'.padEnd(64, 'a') })
    .expect(200);
  await dealService().recordChecks(dealId, 'reel1', 'v1', {
    reportId: 'r_v1',
    passed: true,
    failed: [],
  });
  await request(app)
    .post(`${M(dealId)}/approve`)
    .set(auth(U.client))
    .send({ versionId: 'v1' })
    .expect(200);
  return dealId;
}

const getDeal = (dealId, who) => request(app).get(`${base()}/${dealId}`).set(auth(who));
const getLedger = (dealId, who) => request(app).get(`${base()}/${dealId}/ledger`).set(auth(who));
const payoutLines = (l) => l.entries.filter((e) => e.type === 'payout');
/** Maya's amount (12000) must not appear on any payout-shaped field Leo receives. */
const mentionsSana = (body) =>
  /"amountMinor":12000\b/.test(JSON.stringify(body)) ||
  /Maya/.test(
    JSON.stringify(body.data?.milestones?.map((m) => m.payouts) ?? body.data?.entries ?? body),
  );

function socketClient(u) {
  const s = connect(url, {
    auth: { token: u.token },
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  sockets.push(s);
  return new Promise((resolve, reject) => {
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}
const join = (s, dealId) => new Promise((resolve) => s.emit('deal:join', { dealId }, resolve));

let dealId;
beforeAll(async () => {
  await require('../../../db/mongo').connect();
  await seedDefaultRoles();
  gw = makeMockGateway({ now: () => now });
  configureDeals({ gateway: gw, now: iso, publicBaseUrl: 'https://app.test' });
  U.admin = await user('admin');
  const org = await request(app)
    .post('/api/v1/organizations')
    .set(auth(U.admin))
    .send({ name: 'Payout Visibility', slug: 'payout-visibility' });
  orgId = org.body.data._id;
  U.worker = await user('worker', 'editor'); // lead editor: on the crew AND can manage deals
  U.motion = await user('motion', 'publisher'); // crew, not a party, no deal.manage
  U.client = await user('client', 'reviewer'); // the brand
  U.manager = await user('manager', 'editor'); // can manage deals, not on the crew
  server = http.createServer(app);
  initSocketServer(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;

  dealId = await signedFundedApproved();
  await request(app).post(`${base()}/${dealId}/tick`).set(auth(U.client)).expect(200);
});
afterAll(async () => {
  for (const s of sockets) s.close();
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
});

describe('brand view (and deal managers not on the crew): every member line', () => {
  test('GET deal: both payouts, the milestone paid-out total and the batch', async () => {
    for (const who of [U.client, U.manager]) {
      const d = (await getDeal(dealId, who)).body.data;
      expect(d.payoutScope).toBe('all');
      const m = d.milestones[0];
      expect(m.payouts.map((p) => [p.displayName, p.amountMinor])).toEqual([
        ['Leo', 28000],
        ['Maya', 12000],
      ]);
      expect(m.paidOutMinor).toBe(40000);
      expect(m.payoutBatches).toHaveLength(1);
      expect(m.payoutBatches[0]).toMatchObject({ amountMinor: 40000 });
      expect(m.payoutBatches[0].items).toHaveLength(2);
    }
  });

  test('ledger: one payout line per member, totals add up, chain verified', async () => {
    const l = (await getLedger(dealId, U.client)).body.data;
    expect(l.scope).toBe('all');
    expect(payoutLines(l).map((e) => e.amountMinor)).toEqual([28000, 12000]);
    expect(l.totals.paidOutMinor).toBe(40000);
    expect(l.chain.ok).toBe(true);
    const mgr = (await getLedger(dealId, U.manager)).body.data;
    expect(payoutLines(mgr)).toHaveLength(2);
  });

  test('payables board: the brand and a manager off the crew both see the row', async () => {
    for (const who of [U.client, U.manager]) {
      const rows = (await request(app).get(`${base()}/payables`).set(auth(who))).body.data.rows;
      expect(rows.find((r) => r.dealId === dealId)).toMatchObject({ paidOutMinor: 40000 });
    }
  });
});

describe('editor view (crew): only their own payout lines', () => {
  test('GET deal: own payout only, own paid-out total, no batches; terms untouched', async () => {
    const r = await getDeal(dealId, U.worker);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.me).toBe('worker');
    expect(d.payoutScope).toBe('own');
    const m = d.milestones[0];
    expect(m.payouts.map((p) => [p.displayName, p.amountMinor])).toEqual([['Leo', 28000]]);
    expect(m.paidOutMinor).toBe(28000);
    expect(m.payoutBatches).toEqual([]);
    expect(mentionsSana(r.body)).toBe(false);
    // the signed contract is not rewritten: same hash the parties signed
    expect(d.termsHashNow).toBe(d.termsHash);
    expect(d.terms.milestones[0].payees).toHaveLength(2);
  });

  test('deal list (also ?all=1 for a deal manager on the crew) is redacted the same way', async () => {
    for (const q of ['', '?all=1']) {
      const r = await request(app).get(`${base()}${q}`).set(auth(U.worker));
      const d = r.body.data.find((x) => x.id === dealId);
      expect(d.payoutScope).toBe('own');
      expect(d.milestones[0].payouts.map((p) => p.amountMinor)).toEqual([28000]);
      expect(d.milestones[0].payoutBatches).toEqual([]);
      expect(/"amountMinor":12000\b/.test(JSON.stringify(d.milestones))).toBe(false);
    }
  });

  test('ledger: own payout line only, totals from what they see, chain still verified', async () => {
    const r = await getLedger(dealId, U.worker);
    expect(r.status).toBe(200);
    const l = r.body.data;
    expect(l.scope).toBe('own');
    expect(
      payoutLines(l).map((e) => [e.amountMinor, e.idempotencyKey.endsWith(`:${U.worker.userId}`)]),
    ).toEqual([[28000, true]]);
    expect(l.totals.paidOutMinor).toBe(28000);
    expect(l.chain.ok).toBe(true);
    expect(mentionsSana(r.body)).toBe(false);
    // non-payout lines (the hold, the capture) are still there
    expect(l.entries.map((e) => e.type)).toEqual(expect.arrayContaining(['authorize', 'capture']));
  });

  test('payables board: a deal manager on the crew does not get the deal there', async () => {
    const rows = (await request(app).get(`${base()}/payables`).set(auth(U.worker))).body.data.rows;
    expect(rows.find((r) => r.dealId === dealId)).toBeUndefined();
  });

  test('a crew member who is not a party and cannot manage deals still cannot read the deal', async () => {
    expect((await getDeal(dealId, U.motion)).status).toBe(404);
    expect((await getLedger(dealId, U.motion)).status).toBe(404);
  });

  test('payout-receipts agrees: own line only', async () => {
    const d = (
      await request(app)
        .get(`${M(dealId)}/payout-receipts`)
        .set(auth(U.worker))
    ).body.data;
    expect(d.scope).toBe('own');
    expect(d.lines.map((l) => l.amountMinor)).toEqual([28000]);
  });
});

describe('Money Agent results and the live ledger socket', () => {
  test('a tick nudged by the editor returns only their payout line; the socket pushes theirs only', async () => {
    const id = await signedFundedApproved();
    const brand = await socketClient(U.client);
    const editor = await socketClient(U.worker);
    expect(await join(brand, id)).toEqual({ ok: true });
    expect(await join(editor, id)).toEqual({ ok: true });
    const brandGot = [];
    const editorGot = [];
    brand.on('deal:ledger', (m) => brandGot.push(m.entry));
    editor.on('deal:ledger', (m) => editorGot.push(m.entry));

    const r = await request(app).post(`${base()}/${id}/tick`).set(auth(U.worker));
    expect(r.status).toBe(200);
    const results = r.body.data.results;
    const payout = results.find((x) => x.entry?.type === 'payout');
    expect(payout.entries.map((e) => e.amountMinor)).toEqual([28000]);
    expect(payout.entry.amountMinor).toBe(28000);
    expect(/"amountMinor":12000\b/.test(JSON.stringify(results))).toBe(false);
    expect(r.body.data.deal.milestones[0].payouts.map((p) => p.amountMinor)).toEqual([28000]);

    await new Promise((ok) => setTimeout(ok, 300));
    expect(brandGot.filter((e) => e.type === 'payout').map((e) => e.amountMinor)).toEqual([
      28000, 12000,
    ]);
    expect(editorGot.filter((e) => e.type === 'payout').map((e) => e.amountMinor)).toEqual([28000]);
    // everything else reaches both
    expect(editorGot.filter((e) => e.type !== 'payout').map((e) => e.seq)).toEqual(
      brandGot.filter((e) => e.type !== 'payout').map((e) => e.seq),
    );
    expect(editorGot.filter((e) => e.type === 'capture')).toHaveLength(1);
  });
});
