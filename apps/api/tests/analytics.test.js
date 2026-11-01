/**
 * Phase 2 analytics: ingestion (Postiz mocked + demo simulation), cadence,
 * and the read API under /api/v1/organizations/:orgId/analytics/...
 */
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const config = require('../src/config');
const Role = require('../src/models/role.model');
const Project = require('../src/models/project.model');
const Publication = require('../src/models/publication.model');
const SocialChannel = require('../src/models/socialChannel.model');
const PerformanceMetric = require('../src/models/performanceMetric.model');
const Concept = require('../src/models/concept.model');
const ingest = require('../src/services/analytics.ingest');
const analytics = require('../src/services/analytics.service');

const DAY = 86400000;
let token;
let orgId;
let userId;
const auth = () => ({ Authorization: `Bearer ${token}` });
const api = (p) => `/api/v1/organizations/${orgId}/analytics${p}`;

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname.replace(/^\/public\/v1/, '')}`;
    calls.push({ key, url });
    const handler = routes[key];
    if (!handler) return { ok: false, status: 404, text: async () => '{"message":"no route"}' };
    const { status = 200, body } = await handler(u);
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  fn.calls = calls;
  return fn;
}

beforeAll(async () => {
  await require('../src/db/mongo').connect();
  await Role.create({ name: 'admin', permissions: ['*'] });
  await request(app)
    .post('/api/v1/auth/register')
    .send({ name: 'An Admin', email: 'an@example.com', password: 'P@ssw0rd' });
  const login = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: 'an@example.com', password: 'P@ssw0rd' });
  token = login.body.data.accessToken;
  userId = login.body.data.user._id;
  const org = await request(app)
    .post('/api/v1/organizations')
    .set(auth())
    .send({ name: 'An Org', slug: 'an-org' });
  orgId = org.body.data._id;
});

afterAll(async () => {
  await mongoose.disconnect();
});

afterEach(() => {
  config.postiz.apiUrl = '';
  config.postiz.apiKey = '';
  jest.restoreAllMocks();
});

describe('ingestion', () => {
  test('stores Postiz post analytics as a daily series with raw label + normalized metric', async () => {
    config.postiz.apiUrl = 'https://postiz.test/public/v1';
    config.postiz.apiKey = 'k';
    const f = fakeFetch({
      'GET /analytics/post/pz_1': async (u) => {
        expect(u.searchParams.get('date')).toBe('7');
        return {
          body: [
            {
              label: 'Impressions',
              data: [
                { total: '100', date: '2026-10-10' },
                { total: '180', date: '2026-10-11' },
              ],
              percentageChange: 80,
            },
            {
              label: 'Likes',
              data: [
                { total: '10', date: '2026-10-10' },
                { total: '16', date: '2026-10-11' },
              ],
            },
            { label: 'Profile visits', data: [{ total: '3', date: '2026-10-11' }] },
          ],
        };
      },
      'GET /analytics/int_ig': async () => ({
        body: [
          {
            label: 'Followers',
            data: [
              { total: '1000', date: '2026-10-10' },
              { total: '1012', date: '2026-10-11' },
            ],
          },
        ],
      }),
    });
    jest.spyOn(globalThis, 'fetch').mockImplementation(f);
    const ch = await SocialChannel.create({
      organizationId: orgId,
      platform: 'instagram',
      name: 'IG',
      mode: 'postiz',
      externalId: 'int_ig',
    });
    const project = await Project.create({
      organizationId: orgId,
      title: 'Postiz post',
      status: 'PUBLISHED',
    });
    const pub = await Publication.create({
      projectId: project._id,
      organizationId: orgId,
      platform: 'Instagram',
      channelId: ch._id,
      provider: 'postiz',
      status: 'published',
      externalPostId: 'pz_1',
      publishedAt: new Date('2026-10-10T08:00:00Z'),
    });
    const now = new Date('2026-10-11T12:00:00Z');
    const r = await ingest.ingestPublication(pub, now);
    expect(r).toEqual({ rows: 5, simulated: false });
    const rows = await PerformanceMetric.find({ publicationId: pub._id }).sort({
      metric: 1,
      date: 1,
    });
    expect(
      rows.map((x) => `${x.metric}:${x.rawLabel}:${x.date.toISOString().slice(0, 10)}=${x.value}`),
    ).toEqual([
      'likes:Likes:2026-10-10=10',
      'likes:Likes:2026-10-11=16',
      'raw:profile visits:Profile visits:2026-10-11=3',
      'views:Impressions:2026-10-10=100',
      'views:Impressions:2026-10-11=180',
    ]);
    expect(
      rows.every((x) => x.source === 'postiz' && !x.simulated && x.platform === 'instagram'),
    ).toBe(true);
    expect((await Publication.findById(pub._id)).metrics).toEqual({ views: 180, likes: 16 });
    // idempotent
    await ingest.ingestPublication(pub, now);
    expect(await PerformanceMetric.countDocuments({ publicationId: pub._id })).toBe(5);

    // platform analytics with a derived followersGained
    const c = await ingest.ingestChannel(ch, now, 7);
    expect(c.rows).toBe(3);
    const gained = await PerformanceMetric.findOne({
      channelId: ch._id,
      metric: 'followersGained',
    });
    expect(gained).toMatchObject({ value: 12, scope: 'platform', cumulative: false });
    await PerformanceMetric.deleteMany({ organizationId: orgId });
    await Publication.deleteMany({ _id: pub._id });
    await SocialChannel.deleteMany({ _id: ch._id });
  });

  test('cadence: hourly for the first 48h, then daily, stop after 90 days', () => {
    const now = new Date('2026-10-12T12:00:00Z');
    const pub = (ageH, sinceH) => ({
      status: 'published',
      publishedAt: new Date(now - ageH * 3600000),
      analyticsSyncedAt: sinceH === null ? null : new Date(now - sinceH * 3600000),
    });
    expect(ingest.isDue(pub(5, null), now)).toBe(true);
    expect(ingest.isDue(pub(5, 0.5), now)).toBe(false);
    expect(ingest.isDue(pub(5, 1), now)).toBe(true);
    expect(ingest.isDue(pub(72, 2), now)).toBe(false);
    expect(ingest.isDue(pub(72, 24), now)).toBe(true);
    expect(ingest.isDue(pub(24 * 91, 48), now)).toBe(false);
    expect(ingest.windowFor(new Date(now - 3 * DAY), now)).toBe(7);
    expect(ingest.windowFor(new Date(now - 20 * DAY), now)).toBe(30);
    expect(ingest.windowFor(new Date(now - 60 * DAY), now)).toBe(90);
  });
});

describe('analytics API (demo mode, simulated series)', () => {
  const now = new Date();
  let projects;
  let channels;
  let concept;

  beforeAll(async () => {
    channels = {
      ig: await SocialChannel.create({
        organizationId: orgId,
        platform: 'instagram',
        name: 'IG demo',
        mode: 'demo',
        handle: 'ig',
      }),
      yt: await SocialChannel.create({
        organizationId: orgId,
        platform: 'youtube',
        name: 'YT demo',
        mode: 'demo',
        handle: 'yt',
      }),
    };
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 12, 13, 30));
    projects = [
      await Project.create({
        organizationId: orgId,
        title: 'Diwali diya reel',
        status: 'PUBLISHED',
        client: 'Kalpa Crafts',
        campaign: 'Festive',
        publishedAt: lastMonth,
      }),
      await Project.create({
        organizationId: orgId,
        title: 'Pottery basics',
        status: 'PUBLISHED',
        client: 'Kalpa Crafts',
        campaign: 'Evergreen',
        publishedAt: new Date(now - 3 * DAY),
      }),
      await Project.create({
        organizationId: orgId,
        title: 'Studio tour',
        status: 'PUBLISHED',
        client: 'Clay Co',
        campaign: 'Evergreen',
        publishedAt: new Date(now - 10 * DAY),
      }),
    ];
    concept = await Concept.create({
      organizationId: orgId,
      title: 'Diya idea',
      description: 'd',
      proposer: userId,
      status: 'APPROVED',
      approvedProjectId: projects[0]._id,
    });
    const mk = (project, channel, at) =>
      Publication.create({
        projectId: project._id,
        organizationId: orgId,
        platform: channel.platform === 'youtube' ? 'YouTube' : 'Instagram',
        channelId: channel._id,
        provider: 'local',
        status: 'published',
        publishedAt: at,
      });
    const pubs = [
      await mk(projects[0], channels.ig, projects[0].publishedAt),
      await mk(projects[0], channels.yt, projects[0].publishedAt),
      await mk(projects[1], channels.ig, projects[1].publishedAt),
      await mk(projects[2], channels.yt, projects[2].publishedAt),
    ];
    for (const p of pubs) await ingest.ingestPublication(p, now);
    for (const c of Object.values(channels)) await ingest.ingestChannel(c, now, 90);
  });

  test('summary: totals + % change, trend, top content, platforms, client/campaign rollups', async () => {
    const res = await request(app).get(api('/summary?days=30')).set(auth());
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.days).toBe(30);
    expect(d.simulated).toBe(true);
    expect(d.totals.views).toBeGreaterThan(0);
    expect(d.totals.engagementRate).toBeGreaterThan(0);
    expect(d.totals.followersGained).toBeGreaterThan(0);
    expect(d.trend).toHaveLength(30);
    expect(d.topContent.length).toBeGreaterThan(0);
    const rates = d.topContent.map((t) => t.engagementRate);
    expect([...rates].sort((a, b) => b - a)).toEqual(rates);
    expect(d.platforms.map((p) => p.platform).sort()).toEqual(['instagram', 'youtube']);
    expect(d.rollups.client.map((c) => c.name).sort()).toEqual(
      expect.arrayContaining(['Kalpa Crafts', 'Clay Co']),
    );
    expect(d.rollups.campaign.find((c) => c.name === 'Evergreen').projects).toBe(2);

    const seven = await request(app).get(api('/summary?days=7')).set(auth());
    expect(seven.body.data.days).toBe(7);
    expect(seven.body.data.totals.views).toBeLessThanOrEqual(d.totals.views);
    const bad = await request(app).get(api('/summary?days=13')).set(auth());
    expect(bad.body.data.days).toBe(30); // clamped to an allowed window
  });

  test('heatmap: best posting day/hour from our own history', async () => {
    const res = await request(app).get(api('/heatmap')).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.posts).toBe(4);
    expect(res.body.data.byDay).toHaveLength(7);
    expect(res.body.data.best).toMatchObject({
      posts: expect.any(Number),
      engagementRate: expect.any(Number),
    });
  });

  test('project performance: one row per channel with sparkline and % change', async () => {
    const res = await request(app)
      .get(api(`/projects/${projects[0]._id}/performance?days=30`))
      .set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.channels).toHaveLength(2);
    const row = res.body.data.channels[0];
    expect(row.metrics.views).toBeGreaterThan(0);
    expect(row.sparkline.length).toBeGreaterThan(1);
    expect(row.simulated).toBe(true);
    expect(res.body.data.totals.views).toBe(
      res.body.data.channels.reduce((a, c) => a + c.metrics.views, 0),
    );
  });

  test("top performers: last month's projects with their concept", async () => {
    const res = await request(app).get(api('/top-performers')).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({
      title: 'Diwali diya reel',
      concept: { title: 'Diya idea' },
    });
    expect(String(res.body.data.items[0].concept._id)).toBe(String(concept._id));
  });

  test('client report for a project and for a month', async () => {
    const byProject = await request(app)
      .get(api(`/report?projectId=${projects[0]._id}`))
      .set(auth());
    expect(byProject.status).toBe(200);
    expect(byProject.body.data.period.kind).toBe('project');
    expect(byProject.body.data.posts).toHaveLength(2);
    expect(byProject.body.data.client).toBe('Kalpa Crafts');
    expect(byProject.body.data.highlights.length).toBeGreaterThan(1);
    const month = analytics.monthRange(null, now).key;
    const byMonth = await request(app)
      .get(api(`/report?month=${month}&client=${encodeURIComponent('Kalpa Crafts')}`))
      .set(auth());
    expect(byMonth.body.data.period).toMatchObject({ kind: 'month', month });
    expect(byMonth.body.data.projects.map((p) => p.title)).toEqual(['Diwali diya reel']);
    const bad = await request(app).get(api('/report?month=2026-13x')).set(auth());
    expect(bad.status).toBe(400);
  });

  test('ingest endpoint runs a pass; other orgs cannot read', async () => {
    const res = await request(app).post(api('/ingest')).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ errors: 0 });
    await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Out', email: 'out@example.com', password: 'P@ssw0rd' });
    const out = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'out@example.com', password: 'P@ssw0rd' });
    const denied = await request(app)
      .get(api('/summary'))
      .set({ Authorization: `Bearer ${out.body.data.accessToken}` });
    expect(denied.status).toBe(404); // non-members: 404, not 403 (ADR-0015)
  });
});

describe('dashboard pipeline', () => {
  test('stage counts, blocked-on-whom, going live today and last week best', async () => {
    const User = require('../src/models/user.model');
    const Input = require('../src/models/input.model');
    const Membership = require('../src/models/membership.model');
    const editor = await User.create({
      name: 'Ravi Editor',
      email: 'ravi.pipe@example.com',
      passwordHash: 'x'.repeat(60),
    });
    await Membership.create({ userId: editor._id, organizationId: orgId, role: 'editor' });
    const pub = await User.create({
      name: 'Priya Publisher',
      email: 'priya.pipe@example.com',
      passwordHash: 'x'.repeat(60),
    });
    await Membership.create({ userId: pub._id, organizationId: orgId, role: 'publisher' });
    await Project.create({
      organizationId: orgId,
      title: 'Owned draft',
      status: 'IN_PROGRESS',
      assignee: editor._id,
    });
    await Project.create({ organizationId: orgId, title: 'Orphan idea', status: 'IDEA' });
    const approved = await Project.create({
      organizationId: orgId,
      title: 'Ready to ship',
      status: 'APPROVED',
    });
    const waiting = await Project.create({
      organizationId: orgId,
      title: 'Needs inputs',
      status: 'WAITING_FOR_INPUTS',
    });
    await Input.create({ projectId: waiting._id, title: 'Logo files', owner: editor._id });
    const sched = await Project.create({
      organizationId: orgId,
      title: 'Live later today',
      status: 'SCHEDULED',
    });
    await Publication.create({
      projectId: sched._id,
      organizationId: orgId,
      platform: 'Instagram',
      provider: 'local',
      status: 'scheduled',
      scheduledFor: new Date(Date.now() + 5 * 60000),
      publishedAt: null,
    });

    const res = await request(app).get(`/api/v1/organizations/${orgId}/pipeline`).set(auth());
    expect(res.status).toBe(200);
    const d = res.body.data;
    const stage = (k) => d.stages.find((s) => s.key === k);
    expect(d.stages.map((s) => s.key)).toEqual([
      'idea',
      'brief',
      'production',
      'review',
      'publish',
      'live',
    ]);
    expect(
      stage('production').items.find((i) => i.title === 'Owned draft').blockedOn,
    ).toMatchObject({ kind: 'user', name: 'Ravi Editor' });
    expect(stage('idea').items.find((i) => i.title === 'Orphan idea').blockedOn.kind).toBe(
      'unassigned',
    );
    expect(
      stage('publish').items.find((i) => String(i._id) === String(approved._id)).blockedOn,
    ).toMatchObject({ name: 'Priya Publisher', action: 'Schedule it' });
    expect(stage('brief').items.find((i) => i.title === 'Needs inputs').blockedOn.name).toBe(
      'Ravi Editor',
    );
    expect(d.blocked.find((b) => b.name === 'Ravi Editor').count).toBe(2);
    expect(d.goingLiveToday.map((g) => g.title)).toContain('Live later today');
    expect(d.lastWeekBest).not.toBeNull();
  });
});
