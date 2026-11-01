/**
 * Phase 1 - real Postiz: OAuth connect/reconnect + channel health, per-platform
 * settings validation and mapping, media upload caching, two-way reconcile
 * with failure reasons + retry, and "suggest best time" (find-slot / heuristic).
 * All Postiz HTTP is mocked with a fake fetch.
 */
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const config = require('../src/config');
const Role = require('../src/models/role.model');
const Project = require('../src/models/project.model');
const ProjectVersion = require('../src/models/projectVersion.model');
const Publication = require('../src/models/publication.model');
const SocialChannel = require('../src/models/socialChannel.model');
const scheduling = require('../src/services/scheduling.service');
const settings = require('../src/integrations/postiz/settings');
const storage = require('../src/storage');
const { localParts } = require('../src/utils/tz');

const HOUR = 3600000;

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname.replace(/^\/public\/v1/, '')}`;
    calls.push({ key, url, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    const handler = routes[key] || Object.entries(routes).find(([k]) => key.startsWith(k))?.[1];
    if (!handler) return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'no route' }) };
    const { status = 200, body } = await handler(u, init);
    return { ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) };
  };
  fn.calls = calls;
  return fn;
}

let admin;
let orgId;
const auth = () => ({ Authorization: `Bearer ${admin.token}` });
const api = (p) => `/api/v1/organizations/${orgId}/scheduling${p}`;

function postiz(routes) {
  config.postiz.apiUrl = 'https://postiz.test/public/v1';
  config.postiz.apiKey = 'k';
  const f = fakeFetch(routes);
  jest.spyOn(globalThis, 'fetch').mockImplementation(f);
  return f;
}

async function approvedProject(title, files) {
  const project = await Project.create({ organizationId: orgId, title, status: 'APPROVED' });
  const stored = [];
  for (const f of files || [{ filename: 'final.mp4', mimeType: 'video/mp4' }]) {
    const { storageRef, size } = await storage.saveFile(Buffer.from(`bytes-${f.filename}`), { filename: f.filename, mimeType: f.mimeType });
    stored.push({ ...f, storageRef, size });
  }
  const version = await ProjectVersion.create({ projectId: project._id, versionNumber: 1, changeSummary: 'final', files: stored });
  project.approvedVersionId = version._id;
  await project.save();
  return { project, version };
}

beforeAll(async () => {
  await require('../src/db/mongo').connect();
  await Role.create({ name: 'admin', permissions: ['*'] });
  await request(app).post('/api/v1/auth/register').send({ name: 'P1 Admin', email: 'p1@example.com', password: 'P@ssw0rd' });
  const login = await request(app).post('/api/v1/auth/login').send({ email: 'p1@example.com', password: 'P@ssw0rd' });
  admin = { token: login.body.data.accessToken };
  const org = await request(app).post('/api/v1/organizations').set(auth()).send({ name: 'P1 Org', slug: 'p1-org' });
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

describe('connect channel (OAuth) + reconnect state', () => {
  test('demo mode simulates the OAuth round-trip', async () => {
    const res = await request(app).post(api('/channels/connect')).set(auth()).send({ platform: 'instagram', handle: 'demo.ig' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ mode: 'demo', simulated: true });
    expect(res.body.data.channel).toMatchObject({ platform: 'instagram', mode: 'demo', status: 'connected' });
  });

  test('real mode returns the Postiz OAuth URL, imports on complete, and flags expired channels', async () => {
    let integrations = [
      { id: 'int_x', name: 'Kalpa X', identifier: 'x', picture: '' },
      { id: 'int_yt', name: 'Kalpa YT', identifier: 'youtube', picture: '' },
    ];
    const f = postiz({
      'GET /social/x': async (u) => ({ body: { url: `https://x.com/i/oauth2/authorize?state=1${u.searchParams.get('refresh') ? `&refresh=${u.searchParams.get('refresh')}` : ''}` } }),
      'GET /integrations': async () => ({ body: integrations }),
      'GET /is-connected': async () => ({ body: { connected: true } }),
    });
    const start = await request(app).post(api('/channels/connect')).set(auth()).send({ platform: 'x' });
    expect(start.status).toBe(200);
    expect(start.body.data.mode).toBe('postiz');
    expect(start.body.data.url).toMatch(/^https:\/\/x\.com\/i\/oauth2\/authorize/);
    expect(f.calls[0].init.headers.Authorization).toBe('k');

    const done = await request(app).post(api('/channels/connect/complete')).set(auth());
    expect(done.status).toBe(200);
    const xs = done.body.data.channels.filter((c) => c.mode === 'postiz');
    expect(xs.map((c) => c.platform).sort()).toEqual(['x', 'youtube']);
    expect(xs.every((c) => c.status === 'connected')).toBe(true);

    // token expires on X, YouTube is removed from Postiz
    integrations = [{ id: 'int_x', name: 'Kalpa X', identifier: 'x', refreshNeeded: true }];
    const check = await request(app).post(api('/channels/check')).set(auth());
    expect(check.body.data).toMatchObject({ mode: 'postiz', apiKeyValid: true, checked: 2, expired: 2 });
    const xCh = await SocialChannel.findOne({ organizationId: orgId, externalId: 'int_x' });
    expect(xCh.status).toBe('expired');
    expect(xCh.statusReason).toMatch(/expired/i);
    const listed = await request(app).get(api('/channels')).set(auth());
    expect(listed.body.data.find((c) => c.externalId === 'int_x').status).toBe('expired');

    // reconnect asks Postiz for a refresh URL for that integration
    const re = await request(app).post(api(`/channels/${xCh._id}/reconnect`)).set(auth());
    expect(re.body.data).toMatchObject({ mode: 'postiz', reconnect: true });
    expect(re.body.data.url).toContain('refresh=int_x');

    // scheduling to an expired channel is refused up front
    const { project } = await approvedProject('Expired channel');
    const sched = await request(app)
      .post(api('/posts'))
      .set(auth())
      .send({ projectId: String(project._id), channelIds: [String(xCh._id)], caption: 'hi', scheduledAt: new Date(Date.now() + HOUR).toISOString() });
    expect(sched.status).toBe(409);
    expect(sched.body.error.code).toBe('channel_expired');

    // after re-authorising, health returns to connected
    integrations = [{ id: 'int_x', name: 'Kalpa X', identifier: 'x' }];
    await request(app).post(api('/channels/connect/complete')).set(auth());
    expect((await SocialChannel.findById(xCh._id)).status).toBe('connected');
    await SocialChannel.deleteMany({ organizationId: orgId, mode: 'postiz' });
  });
});

describe('per-platform settings', () => {
  const video = { _id: 'v1', filename: 'cut.mp4', mimeType: 'video/mp4' };
  const img = (n) => ({ _id: `i${n}`, filename: `${n}.png`, mimeType: 'image/png' });

  test('maps each platform onto the Postiz __type settings', () => {
    const s = settings.validateAll(
      ['instagram', 'youtube', 'x', 'linkedin'],
      {
        instagram: { format: 'reel', collaborators: ['@kavya.makes', 'studio_two'] },
        youtube: { title: 'Diya workshop', visibility: 'unlisted', madeForKids: false, tags: ['diya', 'diwali'], thumbnailFileId: 'i1' },
        x: { whoCanReply: 'following' },
        linkedin: { carousel: true, carouselName: 'Steps' },
      },
      { caption: 'short caption', file: video, files: [video, img(1), img(2)] }
    );
    expect(settings.toPostizSettings('instagram', s.instagram, { postizIdentifier: 'instagram-standalone' })).toEqual({
      __type: 'instagram-standalone',
      post_type: 'post',
      is_trial_reel: false,
      collaborators: [{ label: 'kavya.makes' }, { label: 'studio_two' }],
    });
    expect(settings.toPostizSettings('youtube', s.youtube, { thumbnail: { id: 't', path: 'https://u/t.png' } })).toEqual({
      __type: 'youtube',
      title: 'Diya workshop',
      type: 'unlisted',
      selfDeclaredMadeForKids: 'no',
      tags: [{ value: 'diya', label: 'diya' }, { value: 'diwali', label: 'diwali' }],
      thumbnail: { id: 't', path: 'https://u/t.png' },
    });
    expect(settings.toPostizSettings('x', s.x)).toEqual({ __type: 'x', who_can_reply_post: 'following' });
    expect(settings.toPostizSettings('linkedin', s.linkedin, { postizIdentifier: 'linkedin-page' })).toEqual({
      __type: 'linkedin-page',
      post_as_images_carousel: true,
      carousel_name: 'Steps',
    });
  });

  test('rejects invalid settings with per-field details before scheduling', () => {
    let err;
    try {
      settings.validateAll(
        ['instagram', 'youtube', 'x', 'linkedin'],
        {
          instagram: { format: 'reel', collaborators: ['a', 'b', 'c', 'd'] },
          youtube: { title: 'x', visibility: 'public' },
          x: { whoCanReply: 'everyone' },
          linkedin: { carousel: true },
        },
        { caption: 'y'.repeat(300), file: img(1), files: [img(1)] }
      );
    } catch (e) {
      err = e;
    }
    expect(err.status).toBe(400);
    const fields = err.details.map((d) => `${d.platform}.${d.field}`);
    expect(fields).toEqual(
      expect.arrayContaining([
        'instagram.format',
        'instagram.collaborators',
        'youtube.title',
        'youtube.madeForKids',
        'youtube.media',
        'x.caption',
        'linkedin.carousel',
      ])
    );
  });

  test('the schedule endpoint returns 400 with details and creates nothing', async () => {
    const ch = await SocialChannel.create({ organizationId: orgId, platform: 'x', name: 'X demo', mode: 'demo' });
    const { project } = await approvedProject('Too long for X');
    const res = await request(app)
      .post(api('/posts'))
      .set(auth())
      .send({ projectId: String(project._id), channelIds: [String(ch._id)], caption: 'z'.repeat(281), scheduledAt: new Date(Date.now() + HOUR).toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0]).toMatchObject({ platform: 'x', field: 'caption' });
    expect(await Publication.countDocuments({ projectId: project._id })).toBe(0);
  });
});

describe('media upload once + two-way reconcile + retry', () => {
  test('uploads the approved file once and reuses the cached path', async () => {
    const f = postiz({
      'POST /upload': async () => ({ body: { id: 'med_1', path: 'https://uploads.postiz.test/cut.mp4' } }),
      'POST /posts': async () => ({ body: [{ postId: `pz_${Math.random().toString(36).slice(2, 7)}` }] }),
    });
    const ig = await SocialChannel.create({ organizationId: orgId, platform: 'instagram', name: 'IG', mode: 'postiz', externalId: 'int_ig', postizIdentifier: 'instagram' });
    const yt = await SocialChannel.create({ organizationId: orgId, platform: 'youtube', name: 'YT', mode: 'postiz', externalId: 'int_yt2' });
    const { project, version } = await approvedProject('Upload once');
    const res = await request(app)
      .post(api('/posts'))
      .set(auth())
      .send({
        projectId: String(project._id),
        channelIds: [String(ig._id), String(yt._id)],
        caption: 'two channels',
        scheduledAt: new Date(Date.now() + HOUR).toISOString(),
        settings: { instagram: { format: 'reel' }, youtube: { title: 'Upload once', visibility: 'public', madeForKids: false } },
      });
    expect(res.status).toBe(201);
    expect(f.calls.filter((c) => c.key === 'POST /upload')).toHaveLength(1);
    const posts = f.calls.filter((c) => c.key === 'POST /posts');
    expect(posts).toHaveLength(2);
    for (const p of posts) expect(p.body.posts[0].value[0].image).toEqual([{ id: 'med_1', path: 'https://uploads.postiz.test/cut.mp4' }]);
    expect(posts[1].body.posts[0].settings).toMatchObject({ __type: 'youtube', selfDeclaredMadeForKids: 'no' });
    const fresh = await ProjectVersion.findById(version._id);
    expect(fresh.files[0].postizMedia.path).toBe('https://uploads.postiz.test/cut.mp4');
    await Publication.updateMany({ projectId: project._id }, { status: 'cancelled' });
  });

  test('reconcile marks ERROR/deleted/overdue posts failed with a reason, follows moves; retry re-creates', async () => {
    const ch = await SocialChannel.create({ organizationId: orgId, platform: 'linkedin', name: 'LI', mode: 'postiz', externalId: 'int_li' });
    const { project } = await approvedProject('Reconcile', [{ filename: 'a.png', mimeType: 'image/png' }]);
    const t = Date.now() + HOUR;
    const mk = (id, when) =>
      Publication.create({ projectId: project._id, organizationId: orgId, platform: 'LinkedIn', channelId: ch._id, provider: 'postiz', status: 'scheduled', scheduledFor: new Date(when), externalPostId: id, publishedAt: null });
    const err = await mk('pz_err', t);
    const gone = await mk('pz_gone', t);
    const moved = await mk('pz_moved', t);
    const stale = await mk('pz_stale', Date.now() - 2 * HOUR);
    const movedTo = new Date(t + 3 * HOUR);
    postiz({
      'GET /posts': async () => ({
        body: {
          posts: [
            { id: 'pz_err', state: 'ERROR', error: 'LinkedIn token revoked' },
            { id: 'pz_moved', state: 'QUEUE', publishDate: movedTo.toISOString() },
            { id: 'pz_stale', state: 'QUEUE', publishDate: new Date(Date.now() - 2 * HOUR).toISOString() },
          ],
        },
      }),
      'GET /integrations': async () => ({ body: [{ id: 'int_li', name: 'LI', identifier: 'linkedin' }] }),
      'POST /posts': async () => ({ body: [{ postId: 'pz_retry' }] }),
      'DELETE /posts/': async () => ({ status: 404 }),
    });
    const r = await scheduling.reconcilePostiz(new Date(), { force: true });
    expect(r.failed).toBe(3);
    expect(r.moved).toBe(1);
    expect((await Publication.findById(err._id)).failureReason).toBe('LinkedIn token revoked');
    expect((await Publication.findById(gone._id)).failureReason).toMatch(/no longer exists/);
    expect((await Publication.findById(stale._id)).failureReason).toMatch(/not confirmed/);
    expect((await Publication.findById(moved._id)).scheduledFor.toISOString()).toBe(movedTo.toISOString());
    // failed posts are visible in the calendar feed with their reason
    const feed = await request(app).get(api(`/posts?projectId=${project._id}`)).set(auth());
    expect(feed.body.data.filter((p) => p.status === 'failed')).toHaveLength(3);

    const retried = await request(app).post(api(`/posts/${err._id}/retry`)).set(auth()).send({});
    expect(retried.status).toBe(200);
    expect(retried.body.data).toMatchObject({ status: 'scheduled', externalPostId: 'pz_retry', failureReason: '', retryCount: 1 });
    const notFailed = await request(app).post(api(`/posts/${moved._id}/retry`)).set(auth()).send({});
    expect(notFailed.status).toBe(409);
    await Publication.deleteMany({ projectId: project._id });
  });

  test('demo-mode retry re-queues a failed local post', async () => {
    const ch = await SocialChannel.create({ organizationId: orgId, platform: 'instagram', name: 'IG demo', mode: 'demo', handle: 'igdemo' });
    const { project } = await approvedProject('Local retry');
    const pub = await Publication.create({ projectId: project._id, organizationId: orgId, platform: 'Instagram', channelId: ch._id, provider: 'local', status: 'failed', failureReason: 'boom', scheduledFor: new Date(Date.now() - HOUR), publishedAt: null });
    const res = await request(app).post(api(`/posts/${pub._id}/retry`)).set(auth()).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('scheduled');
    const summary = await scheduling.runDue(new Date(Date.now() + 1000));
    expect(summary.published).toBeGreaterThanOrEqual(1);
    expect((await Publication.findById(pub._id)).status).toBe('published');
  });
});

describe('suggest best time', () => {
  test('Postiz channels use find-slot (latest of the per-channel slots)', async () => {
    const a = await SocialChannel.create({ organizationId: orgId, platform: 'x', name: 'X1', mode: 'postiz', externalId: 'int_a' });
    const b = await SocialChannel.create({ organizationId: orgId, platform: 'linkedin', name: 'L1', mode: 'postiz', externalId: 'int_b' });
    postiz({
      'GET /find-slot/int_a': async () => ({ body: { date: '2030-01-15T10:00:00.000Z' } }),
      'GET /find-slot/int_b': async () => ({ body: { date: '2030-01-15T12:30:00.000Z' } }),
    });
    const res = await request(app).get(api(`/suggest-time?channelIds=${a._id},${b._id}`)).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.source).toBe('postiz');
    expect(res.body.data.suggestedAt).toBe('2030-01-15T12:30:00.000Z');
    await SocialChannel.deleteMany({ _id: { $in: [a._id, b._id] } });
  });

  test('demo channels fall back to platform defaults, then learn from history', async () => {
    const ch = await SocialChannel.create({ organizationId: orgId, platform: 'youtube', name: 'YT demo', mode: 'demo' });
    const first = await request(app).get(api(`/suggest-time?channelIds=${ch._id}`)).set(auth());
    expect(first.body.data.source).toBe('heuristic');
    expect(localParts(first.body.data.suggestedAt, config.timezone).hour).toBe(17);

    // history: two strong YouTube posts on the same weekday/hour
    const { project } = await approvedProject('History');
    const base = new Date('2026-09-02T14:30:00.000Z'); // Wed 20:00 IST
    for (const k of [0, 7]) {
      await Publication.create({
        projectId: project._id,
        organizationId: orgId,
        platform: 'YouTube',
        channelId: ch._id,
        provider: 'local',
        status: 'published',
        publishedAt: new Date(base.getTime() + k * 86400000),
        metrics: { views: 1000, likes: 200, comments: 20, shares: 10 },
      });
    }
    const learned = await request(app).get(api(`/suggest-time?channelIds=${ch._id}`)).set(auth());
    expect(learned.body.data.source).toBe('history');
    const parts = localParts(learned.body.data.suggestedAt, config.timezone);
    expect(parts.weekday).toBe(3);
    expect(parts.hour).toBe(20);
    expect(learned.body.data.reason).toMatch(/engagement/);
  });
});
