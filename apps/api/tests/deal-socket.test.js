/**
 * Phase 4 gap 6: live MoneyTimeline. A socket joins `deal:<id>` only after the
 * org-access + party (or deal.manage) check; every ledger append for that deal
 * is pushed as `deal:ledger`. Other orgs, non-party reviewers and unknown deals
 * get `not_found` and receive nothing.
 */
const http = require('node:http');
const request = require('supertest');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { io: connect } = require('socket.io-client');
const app = require('../src/app');
const { initSocketServer } = require('../src/realtime/socket');
const { generateAccessToken } = require('../src/utils/tokens');
const User = require('../src/models/user.model');
const Organization = require('../src/models/organization.model');
const Membership = require('../src/models/membership.model');
const { configureDeals } = require('../src/modules/deals/service.cts');
const { makeMockGateway } = require('../src/modules/deals/paypal.cts');
const { DEMO, seedDealDemo } = require('../src/modules/deals/demo.cts');

const API = '/api/v1';
let server;
let url;
let seeded;
const sockets = [];
const T = {};

async function makeUser(email, orgId, role) {
  const u = await User.create({
    name: email,
    email,
    passwordHash: bcrypt.hashSync('x-unused-x', 4),
  });
  if (orgId) await Membership.create({ userId: u._id, organizationId: orgId, role });
  return String(u._id);
}
function client(userId) {
  const s = connect(url, {
    auth: { token: generateAccessToken({ sub: userId }) },
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
const bearer = (userId) => ({ Authorization: `Bearer ${generateAccessToken({ sub: userId })}` });

beforeAll(async () => {
  await require('../src/db/mongo').connect();
  configureDeals({ gateway: makeMockGateway() });
  seeded = await seedDealDemo({ evidenceDir: false });
  const other = await Organization.create({ name: 'Socket Other Org', slug: 'socket-other-org' });
  T.judge = seeded.judge.userId;
  T.editor = seeded.editor.userId;
  T.reviewer = await makeUser('reviewer@socket.example.com', seeded.orgId, 'reviewer');
  T.outsider = await makeUser('outsider@socket.example.com', other._id, 'admin');
  server = http.createServer(app);
  initSocketServer(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  for (const s of sockets) s.close();
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
});

describe('deal:<id> socket room', () => {
  test('only parties (or deal.manage holders) of the deal org can join; everyone else gets not_found', async () => {
    expect(await join(await client(T.judge), DEMO.dealId)).toEqual({ ok: true });
    expect(await join(await client(T.editor), DEMO.dealId)).toEqual({ ok: true });
    expect(await join(await client(T.outsider), DEMO.dealId)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(await join(await client(T.reviewer), DEMO.dealId)).toEqual({
      ok: false,
      error: 'not_found',
    });
    const j = await client(T.judge);
    expect(await join(j, 'deal_does_not_exist')).toEqual({ ok: false, error: 'not_found' });
    expect(await join(j, '../../x')).toEqual({ ok: false, error: 'not_found' });
    expect(await join(j, { $ne: null })).toEqual({ ok: false, error: 'not_found' });
  });

  test('every ledger append reaches the room, and only the room', async () => {
    const watcher = await client(T.judge);
    expect(await join(watcher, DEMO.dealId)).toEqual({ ok: true });
    const outsider = await client(T.outsider);
    await join(outsider, DEMO.dealId);
    const got = [];
    const leaked = [];
    watcher.on('deal:ledger', (m) => got.push(m));
    outsider.on('deal:ledger', (m) => leaked.push(m));

    // the judge accepts the editor's 80% split; the Money Agent captures it, voids the rest, pays out
    const deal = `${API}/organizations/${seeded.orgId}/deals/${DEMO.dealId}`;
    expect(
      (
        await request(app)
          .post(`${deal}/milestones/reel2/split`)
          .set(bearer(T.judge))
          .send({ workerMinor: 24000 })
      ).status,
    ).toBe(200);
    const tick = await request(app).post(`${deal}/tick`).set(bearer(T.judge));
    expect(tick.status).toBe(200);
    const done = tick.body.data.results.filter((r) => r.entry).length;
    expect(done).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 300));
    expect(got.length).toBe(done);
    expect(got.every((m) => m.dealId === DEMO.dealId && m.entry.dealId === DEMO.dealId)).toBe(true);
    expect(got[0].entry).toMatchObject({
      type: 'partial_capture',
      amountMinor: 24000,
      moved: true,
    });
    expect(leaked).toEqual([]);
  });

  test('after deal:leave nothing more arrives', async () => {
    const s = await client(T.judge);
    expect(await join(s, DEMO.dealId)).toEqual({ ok: true });
    const got = [];
    s.on('deal:ledger', (m) => got.push(m));
    const stay = await client(T.editor);
    expect(await join(stay, DEMO.dealId)).toEqual({ ok: true });
    const stayed = [];
    stay.on('deal:ledger', (m) => stayed.push(m));
    s.emit('deal:leave', { dealId: DEMO.dealId });
    await new Promise((r) => setTimeout(r, 100));
    // a refused money step is still a ledger line (blocked, no money moved): reel1 is already paid out
    const r = await request(app)
      .post(`${API}/organizations/${seeded.orgId}/deals/${DEMO.dealId}/milestones/reel1/void-missed-deadline`)
      .set(bearer(T.judge));
    expect(r.status).toBe(409);
    expect(r.body.data.result.outcome).toBe('blocked');
    await new Promise((r2) => setTimeout(r2, 300));
    expect(stayed.map((m) => m.entry.type)).toEqual(['blocked']);
    expect(got).toEqual([]);
  });
});
