/**
 * Social scheduling (PRD §17): adapter boundary, local fallback, Postiz
 * provider (fake fetch), webhook, and project status sync.
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
const PerformanceMetric = require('../src/models/performanceMetric.model');
const scheduling = require('../src/services/scheduling.service');
const adapter = require('../src/services/scheduling');
const postizClient = require('../src/integrations/postiz/client');
const postizProvider = require('../src/services/scheduling/postiz.provider');
const settings = require('../src/integrations/postiz/settings');

const HOUR = 3600000;

async function registerAndLogin(name, email) {
  await request(app).post('/api/v1/auth/register').send({ name, email, password: 'P@ssw0rd' });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: 'P@ssw0rd' });
  return { token: login.body.data.accessToken, userId: login.body.data.user._id };
}

/** Minimal fake fetch: routes "METHOD /path" to handlers, records calls. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname.replace(/^\/public\/v1/, '')}`;
    calls.push({ key, url, init });
    const handler = routes[key] || Object.entries(routes).find(([k]) => key.startsWith(k))?.[1];
    if (!handler) return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'no route' }) };
    const { status = 200, body } = await handler(u, init);
    return { ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) };
  };
  fn.calls = calls;
  return fn;
}

let admin;
let editor;
let orgId;

async function approvedProject(title = 'Approved reel') {
  const project = await Project.create({ organizationId: orgId, title, status: 'APPROVED' });
  const version = await ProjectVersion.create({
    projectId: project._id,
    versionNumber: 1,
    changeSummary: 'final',
    files: [{ filename: 'final.mp4', mimeType: 'video/mp4', size: 10, storageRef: '' }],
  });
  project.approvedVersionId = version._id;
  project.approvedAt = new Date();
  await project.save();
  return { project, version };
}

const auth = (u) => ({ Authorization: `Bearer ${u.token}` });
const api = (p) => `/api/v1/organizations/${orgId}/scheduling${p}`;

beforeAll(async () => {
  await require('../src/db/mongo').connect();
  await Role.create({ name: 'admin', permissions: ['*'] });
  await Role.create({ name: 'editor', permissions: ['project.create', 'project.view', 'project.upload_version'] });
  admin = await registerAndLogin('Sched Admin', 'sched-admin@example.com');
  editor = await registerAndLogin('Sched Editor', 'sched-editor@example.com');
  const org = await request(app).post('/api/v1/organizations').set(auth(admin)).send({ name: 'Sched Org', slug: 'sched-org' });
  orgId = org.body.data._id;
  await request(app).post(`/api/v1/organizations/${orgId}/members`).set(auth(admin)).send({ email: 'sched-editor@example.com', role: 'editor' });
});

afterAll(async () => {
  await mongoose.disconnect();
});

afterEach(() => {
  config.postiz.apiUrl = '';
  config.postiz.apiKey = '';
  config.postiz.webhookSecret = '';
  jest.restoreAllMocks();
});

describe('adapter boundary', () => {
  test('falls back to the local scheduler when Postiz is not configured', () => {
    expect(adapter.mode()).toBe('local');
    expect(adapter.providerFor({ mode: 'demo' }).name).toBe('local');
    expect(adapter.providerFor({ provider: 'local' }).name).toBe('local');
    expect(adapter.providerFor({ mode: 'postiz' }).name).toBe('postiz');
    config.postiz.apiUrl = 'https://postiz.test/public/v1';
    config.postiz.apiKey = 'k';
    expect(adapter.mode()).toBe('postiz');
  });

  test('status endpoint reports mode and the four platforms', async () => {
    const res = await request(app).get(api('/status')).set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.mode).toBe('local');
    expect(res.body.data.platforms.map((p) => p.key)).toEqual(['instagram', 'youtube', 'linkedin', 'x']);
  });

  test('platform settings carry __type and validate required fields', () => {
    expect(settings.buildSettings('instagram')).toEqual({ __type: 'instagram', post_type: 'post' });
    expect(settings.buildSettings('youtube', { title: 'Diwali reel' })).toMatchObject({ __type: 'youtube', title: 'Diwali reel', type: 'public' });
    expect(settings.buildSettings('x')).toEqual({ __type: 'x', who_can_reply_post: 'everyone' });
    expect(() => settings.validate('youtube', { __type: 'youtube', title: 'x', type: 'public' })).toThrow();
    expect(() => settings.validate('instagram', { __type: 'instagram', post_type: 'reel' })).toThrow();
  });
});

describe('Postiz client + provider (fake fetch)', () => {
  const opts = (fetch) => ({ apiUrl: 'https://postiz.test/public/v1', apiKey: 'secret-key', fetch });

  test('createPost sends the documented payload with the API key', async () => {
    const fetch = fakeFetch({ 'POST /posts': async () => ({ body: [{ postId: 'pz_1', integration: 'int_ig' }] }) });
    const pub = new Publication({ projectId: new mongoose.Types.ObjectId(), platform: 'Instagram', caption: 'Hello', scheduledFor: new Date(Date.now() + HOUR) });
    const channel = { platform: 'instagram', externalId: 'int_ig', postizIdentifier: 'instagram' };
    const out = await postizProvider.createPost({ publication: pub, channel, project: { title: 'T' }, file: null }, opts(fetch));
    expect(out.externalPostId).toBe('pz_1');
    const call = fetch.calls[0];
    expect(call.init.headers.Authorization).toBe('secret-key');
    const body = JSON.parse(call.init.body);
    expect(body.type).toBe('schedule');
    expect(body.posts[0].integration.id).toBe('int_ig');
    expect(body.posts[0].value[0].content).toBe('Hello');
    expect(body.posts[0].settings).toEqual({ __type: 'instagram', post_type: 'post' });
  });

  test('maps Postiz errors to stable codes and treats DELETE 404 as done', async () => {
    expect(postizClient._mapError(401, '', '').code).toBe('postiz_auth_failed');
    expect(postizClient._mapError(429, '', '').status).toBe(429);
    expect(postizClient._mapError(500, '', '').code).toBe('postiz_upstream_error');
    const fetch = fakeFetch({ 'DELETE /posts': async () => ({ status: 404, body: { message: 'gone' } }) });
    await expect(postizClient.deletePost('pz_x', opts(fetch))).resolves.toBeUndefined();
    await expect(postizClient.listIntegrations({ apiUrl: '', apiKey: '' })).rejects.toMatchObject({ code: 'postiz_not_configured' });
  });

  test('syncPublications reads state + releaseURL; fetchMetrics maps analytics labels', async () => {
    const fetch = fakeFetch({
      'GET /posts': async () => ({
        body: {
          posts: [
            { id: 'pz_ok', state: 'PUBLISHED', releaseURL: 'https://instagram.com/p/abc' },
            { id: 'pz_bad', state: 'ERROR', error: 'token expired' },
            { id: 'pz_wait', state: 'QUEUE' },
          ],
        },
      }),
      'GET /analytics/post/pz_ok': async () => ({
        body: [
          { label: 'Impressions', data: [{ total: '100' }, { total: '250' }] },
          { label: 'Likes', data: [{ total: '20' }] },
          { label: 'Unknown thing', data: [{ total: '1' }] },
        ],
      }),
    });
    const mk = (id) => ({ externalPostId: id, scheduledFor: new Date() });
    const updates = await postizProvider.syncPublications([mk('pz_ok'), mk('pz_bad'), mk('pz_wait')], opts(fetch));
    expect(updates.map((u) => [u.publication.externalPostId, u.state])).toEqual([
      ['pz_ok', 'published'],
      ['pz_bad', 'failed'],
    ]);
    expect(updates[0].postUrl).toBe('https://instagram.com/p/abc');
    const { metrics, simulated } = await postizProvider.fetchMetrics({ externalPostId: 'pz_ok' }, new Date(), opts(fetch));
    expect(metrics).toEqual({ views: 250, likes: 20 });
    expect(simulated).toBe(false);
  });
});

describe('local fallback: channels -> schedule -> publish -> metrics', () => {
  let channels;

  test('connects demo channels for Instagram, YouTube, LinkedIn and X', async () => {
    channels = [];
    for (const [platform, handle] of [['instagram', 'kalpa.demo'], ['youtube', 'kalpademo'], ['linkedin', 'kalpa'], ['x', 'kalpa']]) {
      const res = await request(app).post(api('/channels')).set(auth(admin)).send({ platform, handle });
      expect(res.status).toBe(201);
      expect(res.body.data.mode).toBe('demo');
      channels.push(res.body.data);
    }
    const list = await request(app).get(api('/channels')).set(auth(admin));
    expect(list.body.data).toHaveLength(4);
  });

  test('editors without project.schedule cannot connect channels or schedule', async () => {
    const res = await request(app).post(api('/channels')).set(auth(editor)).send({ platform: 'x' });
    expect(res.status).toBe(403);
    const list = await request(app).get(api('/channels')).set(auth(editor));
    expect(list.status).toBe(200);
  });

  test('rejects scheduling a project that is not Approved', async () => {
    const p = await Project.create({ organizationId: orgId, title: 'Draft', status: 'IN_PROGRESS' });
    const res = await request(app)
      .post(api('/posts'))
      .set(auth(admin))
      .send({ projectId: String(p._id), channelIds: [channels[0]._id], caption: 'x', scheduledAt: new Date(Date.now() + HOUR).toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('not_approved');
  });

  test('scheduling moves the project to SCHEDULED; the scheduler publishes it and syncs URL + metrics', async () => {
    const { project, version } = await approvedProject('Diwali reel');
    const eligible = await request(app).get(api('/eligible-projects')).set(auth(admin));
    const row = eligible.body.data.find((e) => e._id === String(project._id));
    expect(row.approvedVersion.label).toBe('v1');
    expect(row.approvedVersion.files[0].filename).toBe('final.mp4');

    const when = new Date(Date.now() + 2 * HOUR);
    const res = await request(app)
      .post(api('/posts'))
      .set(auth(admin))
      .send({ projectId: String(project._id), channelIds: [channels[0]._id, channels[1]._id], caption: 'Shape your own diya 🪔', scheduledAt: when.toISOString() });
    expect(res.status).toBe(201);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every((p) => p.status === 'scheduled' && p.provider === 'local')).toBe(true);
    expect(String(res.body.data[0].versionId)).toBe(String(version._id));

    let fresh = await Project.findById(project._id);
    expect(fresh.status).toBe('SCHEDULED');
    expect(fresh.scheduledAt.toISOString()).toBe(when.toISOString());

    // calendar feed
    const cal = await request(app)
      .get(api(`/posts?from=${new Date(Date.now()).toISOString()}&to=${new Date(Date.now() + 86400000).toISOString()}`))
      .set(auth(admin));
    expect(cal.body.data.filter((p) => p.project.title === 'Diwali reel')).toHaveLength(2);

    // nothing due yet
    let summary = await scheduling.runDue(new Date());
    expect(summary.published).toBe(0);

    summary = await scheduling.runDue(new Date(when.getTime() + 1000));
    expect(summary.published).toBe(2);
    fresh = await Project.findById(project._id);
    expect(fresh.status).toBe('PUBLISHED');
    expect(fresh.publishedAt).toBeTruthy();
    const pubs = await Publication.find({ projectId: project._id });
    expect(pubs.every((p) => p.status === 'published' && p.postUrl.startsWith('https://'))).toBe(true);
    expect(pubs[0].metricsSimulated).toBe(true);
    expect(pubs[0].metrics.views).toBeGreaterThan(0);
    const metrics = await PerformanceMetric.find({ projectId: project._id });
    // daily series: one row per metric per day; IG has 5 metrics, YouTube adds watch time
    expect(metrics.length).toBe(11);
    expect(metrics.every((m) => m.simulated && m.date && m.scope === 'post')).toBe(true);
    expect(new Set(metrics.map((m) => m.metric))).toEqual(new Set(['views', 'likes', 'comments', 'shares', 'saves', 'watchTime']));

    // re-sync upserts instead of duplicating
    await request(app).post(api(`/posts/${pubs[0]._id}/sync`)).set(auth(admin)).expect(200);
    expect(await PerformanceMetric.countDocuments({ projectId: project._id })).toBe(11);

    // activity trail recorded on the project
    const activity = await request(app).get(`/api/v1/projects/${project._id}/activity`).set(auth(admin));
    const actions = (activity.body.data.items || activity.body.data).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['scheduled', 'published']));
  });

  test('publish now publishes immediately', async () => {
    const { project } = await approvedProject('Publish now project');
    const res = await request(app)
      .post(api('/posts'))
      .set(auth(admin))
      .send({ projectId: String(project._id), channelIds: [channels[3]._id], caption: 'now', scheduledAt: new Date(Date.now() + HOUR).toISOString() });
    const now = await request(app).post(api(`/posts/${res.body.data[0]._id}/publish-now`)).set(auth(admin));
    expect(now.status).toBe(200);
    expect(now.body.data.status).toBe('published');
    expect((await Project.findById(project._id)).status).toBe('PUBLISHED');
  });

  test('cancelling the only scheduled post returns the project to APPROVED', async () => {
    const { project } = await approvedProject('Cancel me');
    const res = await request(app)
      .post(api('/posts'))
      .set(auth(admin))
      .send({ projectId: String(project._id), channelIds: [channels[2]._id], caption: 'c', scheduledAt: new Date(Date.now() + HOUR).toISOString() });
    expect((await Project.findById(project._id)).status).toBe('SCHEDULED');
    const moved = await request(app)
      .patch(api(`/posts/${res.body.data[0]._id}`))
      .set(auth(admin))
      .send({ scheduledAt: new Date(Date.now() + 5 * HOUR).toISOString() });
    expect(moved.status).toBe(200);
    const cancel = await request(app).post(api(`/posts/${res.body.data[0]._id}/cancel`)).set(auth(admin));
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.status).toBe('cancelled');
    const fresh = await Project.findById(project._id);
    expect(fresh.status).toBe('APPROVED');
    expect(fresh.scheduledAt).toBeNull();
  });

  test('manual fallback: mark a scheduled post published with its URL', async () => {
    const { project } = await approvedProject('Manual fallback');
    const res = await request(app)
      .post(api('/posts'))
      .set(auth(admin))
      .send({ projectId: String(project._id), channelIds: [channels[0]._id], caption: 'm', scheduledAt: new Date(Date.now() + HOUR).toISOString() });
    const done = await request(app)
      .post(api(`/posts/${res.body.data[0]._id}/mark-published`))
      .set(auth(admin))
      .send({ postUrl: 'https://www.instagram.com/p/manual123/' });
    expect(done.status).toBe(200);
    expect(done.body.data.provider).toBe('manual');
    expect(done.body.data.postUrl).toBe('https://www.instagram.com/p/manual123/');
    expect((await Project.findById(project._id)).status).toBe('PUBLISHED');
  });

  test('partial publish keeps the project SCHEDULED with n/m progress until every post is live', async () => {
    const { project } = await approvedProject('Partial publish');
    const early = new Date(Date.now() + HOUR);
    const late = new Date(Date.now() + 3 * HOUR);
    const a = await request(app)
      .post(api('/posts'))
      .set(auth(admin))
      .send({ projectId: String(project._id), channelIds: [channels[0]._id], caption: 'a', scheduledAt: early.toISOString() });
    await request(app)
      .post(api('/posts'))
      .set(auth(admin))
      .send({ projectId: String(project._id), channelIds: [channels[1]._id], caption: 'b', scheduledAt: late.toISOString() });
    expect(a.status).toBe(201);
    await scheduling.runDue(new Date(early.getTime() + 1000));
    let fresh = await Project.findById(project._id);
    expect(fresh.status).toBe('SCHEDULED');
    expect(fresh.publishProgress.published).toBe(1);
    expect(fresh.publishProgress.total).toBe(2);
    expect(fresh.publishedAt).toBeTruthy();
    await scheduling.runDue(new Date(late.getTime() + 1000));
    fresh = await Project.findById(project._id);
    expect(fresh.status).toBe('PUBLISHED');
    expect(fresh.publishProgress.published).toBe(2);
  });

  test('legacy manual publish cannot duplicate a scheduled post', async () => {
    const { project } = await approvedProject('No duplicates');
    const res = await request(app)
      .post(api('/posts'))
      .set(auth(admin))
      .send({ projectId: String(project._id), channelIds: [channels[1]._id], caption: 'yt', scheduledAt: new Date(Date.now() + HOUR).toISOString() });
    const platform = res.body.data[0].platform;
    // different platform -> refused with a pointer to the calendar
    const refused = await request(app)
      .post(`/api/v1/projects/${project._id}/publications`)
      .set(auth(admin))
      .send({ platform: 'Pinterest' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('has_scheduled_posts');
    // same platform -> routed onto the scheduled post (no second publication)
    const routed = await request(app)
      .post(`/api/v1/projects/${project._id}/publications`)
      .set(auth(admin))
      .send({ platform, postUrl: 'https://youtube.com/watch?v=x1' });
    expect(routed.status).toBe(201);
    const pubs = await Publication.find({ projectId: project._id });
    expect(pubs).toHaveLength(1);
    expect(pubs[0].status).toBe('published');
    expect((await Project.findById(project._id)).status).toBe('PUBLISHED');
  });

  test('cannot disconnect a channel with scheduled posts; can once cleared', async () => {
    const { project } = await approvedProject('Blocks disconnect');
    const ch = await request(app).post(api('/channels')).set(auth(admin)).send({ platform: 'x', handle: 'temp' });
    const res = await request(app)
      .post(api('/posts'))
      .set(auth(admin))
      .send({ projectId: String(project._id), channelIds: [ch.body.data._id], scheduledAt: new Date(Date.now() + HOUR).toISOString() });
    const blocked = await request(app).delete(api(`/channels/${ch.body.data._id}`)).set(auth(admin));
    expect(blocked.status).toBe(409);
    await request(app).post(api(`/posts/${res.body.data[0]._id}/cancel`)).set(auth(admin)).expect(200);
    await request(app).delete(api(`/channels/${ch.body.data._id}`)).set(auth(admin)).expect(200);
  });
});

describe('Postiz mode: schedule through Postiz, publish via webhook', () => {
  test('imports Postiz integrations, schedules, and the webhook publishes the project', async () => {
    config.postiz.apiUrl = 'https://postiz.test/public/v1';
    config.postiz.apiKey = 'k';
    config.postiz.webhookSecret = 'hook-secret';
    const fetch = fakeFetch({
      'GET /integrations': async () => ({
        body: [
          { id: 'int_ig', name: 'Kalpa IG', providerIdentifier: 'instagram', picture: '' },
          { id: 'int_tt', name: 'TikTok', providerIdentifier: 'tiktok' },
        ],
      }),
      'POST /posts': async () => ({ body: [{ postId: 'pz_live', integration: 'int_ig' }] }),
      'GET /posts': async () => ({ body: { posts: [{ id: 'pz_live', state: 'QUEUE' }] } }),
      'GET /analytics/post/pz_live': async () => ({ body: [{ label: 'Likes', data: [{ total: '42' }] }] }),
    });
    jest.spyOn(globalThis, 'fetch').mockImplementation(fetch);

    const imported = await request(app).post(api('/postiz/import')).set(auth(admin));
    expect(imported.status).toBe(200);
    expect(imported.body.data).toHaveLength(1); // tiktok is not a yv. channel
    const channel = imported.body.data[0];
    expect(channel).toMatchObject({ mode: 'postiz', platform: 'instagram', externalId: 'int_ig' });

    const { project } = await approvedProject('Postiz project');
    const res = await request(app)
      .post(api('/posts'))
      .set(auth(admin))
      .send({ projectId: String(project._id), channelIds: [channel._id], caption: 'via postiz', scheduledAt: new Date(Date.now() + HOUR).toISOString() });
    expect(res.status).toBe(201);
    expect(res.body.data[0]).toMatchObject({ provider: 'postiz', externalPostId: 'pz_live', status: 'scheduled' });
    expect((await Project.findById(project._id)).status).toBe('SCHEDULED');

    // the local scheduler never publishes a Postiz post on its own
    // (still inside the confirm window, so it stays scheduled)
    await scheduling.runDue(new Date(Date.now() + HOUR + 5 * 60000));
    expect((await Publication.findOne({ externalPostId: 'pz_live' })).status).toBe('scheduled');

    const bad = await request(app).post('/api/v1/webhooks/postiz').send({ id: 'pz_live', state: 'PUBLISHED' });
    expect(bad.status).toBe(401);

    const hook = await request(app)
      .post('/api/v1/webhooks/postiz')
      .set('X-Postiz-Signature', 'hook-secret')
      .send({ id: 'pz_live', state: 'PUBLISHED', releaseURL: 'https://www.instagram.com/p/real1/' });
    expect(hook.status).toBe(200);
    expect(hook.body.data.updated).toBe(1);

    const again = await request(app)
      .post('/api/v1/webhooks/postiz')
      .set('X-Postiz-Signature', 'hook-secret')
      .send([{ postId: 'pz_live', releaseURL: 'https://www.instagram.com/p/real1/' }]);
    expect(again.body.data.updated).toBe(0); // idempotent

    const pub = await Publication.findOne({ externalPostId: 'pz_live' });
    expect(pub.status).toBe('published');
    expect(pub.postUrl).toBe('https://www.instagram.com/p/real1/');
    const fresh = await Project.findById(project._id);
    expect(fresh.status).toBe('PUBLISHED');

    const synced = await request(app).post(api(`/posts/${pub._id}/sync`)).set(auth(admin));
    expect(synced.body.data.metrics).toEqual({ likes: 42 });
    expect(synced.body.data.metricsSimulated).toBe(false);
  });

  test('a Postiz failure is recorded on the post and surfaced as an error', async () => {
    config.postiz.apiUrl = 'https://postiz.test/public/v1';
    config.postiz.apiKey = 'k';
    jest.spyOn(globalThis, 'fetch').mockImplementation(fakeFetch({ 'POST /posts': async () => ({ status: 401, body: { message: 'bad key' } }) }));
    const channel = await SocialChannel.create({ organizationId: orgId, platform: 'linkedin', name: 'LI', mode: 'postiz', externalId: 'int_li' });
    const { project } = await approvedProject('Postiz fails');
    const res = await request(app)
      .post(api('/posts'))
      .set(auth(admin))
      .send({ projectId: String(project._id), channelIds: [String(channel._id)], scheduledAt: new Date(Date.now() + HOUR).toISOString() });
    expect(res.status).toBe(502);
    const pub = await Publication.findOne({ projectId: project._id });
    expect(pub.status).toBe('failed');
    expect(pub.failureReason).toMatch(/API key/);
    expect((await Project.findById(project._id)).status).toBe('APPROVED');
  });
});
