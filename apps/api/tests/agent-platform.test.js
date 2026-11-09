/**
 * Agent platform (Node side): service JWT, /internal API scoping, job enqueue via Redis
 * Streams (fake redis), job results -> AgentJob, and the SSE chat proxy to a fake agent.
 */
const http = require('http');
const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const { createInternalApp } = require('../src/internal-app');
const config = require('../src/config');
const { mintServiceToken, verifyServiceToken } = require('../src/agent/serviceToken');
const streams = require('../src/agent/streams');
const { seedAgentDemo } = require('../scripts/seed-agent-demo');
const { Insight, AgentJob } = require('../src/models/agent');

// /internal lives on its own private listener (Phase 1 item 6), not on `app`.
const internal = createInternalApp();
const INTERNAL = () => ({ 'X-Internal-Token': config.internal.token });
let seed;
let userToken;
let fakeRedis;
const svc = (scopes, orgId = seed.orgId) => ({
  ...INTERNAL(),
  Authorization: `Bearer ${mintServiceToken({ orgId, userId: seed.userId, scopes })}`,
});

beforeAll(async () => {
  await require('../src/db/mongo').connect();
  seed = await seedAgentDemo();
  const login = await request(app).post('/api/v1/auth/login').send(seed.login);
  userToken = login.body.data.accessToken;
  fakeRedis = {
    added: [],
    xadd: async (...args) => {
      fakeRedis.added.push(args);
      return `${Date.now()}-0`;
    },
    quit: async () => {},
  };
  streams.setRedis(fakeRedis);
});

afterAll(async () => {
  await mongoose.disconnect();
});

describe('service token', () => {
  test('round-trips claims and rejects other audiences / unknown scopes', () => {
    const t = mintServiceToken({ orgId: 'o1', userId: 'u1', scopes: ['posts:read'] });
    expect(verifyServiceToken(t)).toMatchObject({
      orgId: 'o1',
      userId: 'u1',
      scopes: ['posts:read'],
      iss: 'yv-api',
      aud: 'yv-internal',
    });
    const userish = jwt.sign(
      { orgId: 'o1', scopes: ['posts:read'] },
      config.agent.serviceJwtSecret,
      { audience: 'someone-else' },
    );
    expect(verifyServiceToken(userish)).toBeNull();
    expect(() => mintServiceToken({ orgId: 'o1', userId: 'u1', scopes: ['admin:*'] })).toThrow(
      /unknown scopes/,
    );
  });

  test('a normal user access token cannot call /internal', async () => {
    const r = await request(internal)
      .get('/internal/posts')
      .set({ ...INTERNAL(), Authorization: `Bearer ${userToken}` });
    expect(r.status).toBe(401);
  });
});

describe('/internal is private (Phase 1 item 6)', () => {
  test('the public app does not serve /internal at all', async () => {
    const r = await request(app)
      .get('/internal/posts')
      .set(svc(['posts:read']));
    expect(r.status).toBe(404);
  });

  test('a valid service JWT without the shared internal token is refused', async () => {
    const jwtOnly = {
      Authorization: `Bearer ${mintServiceToken({ orgId: seed.orgId, userId: seed.userId, scopes: ['posts:read'] })}`,
    };
    expect((await request(internal).get('/internal/posts').set(jwtOnly)).status).toBe(401);
    expect(
      (
        await request(internal)
          .get('/internal/posts')
          .set({ ...jwtOnly, 'X-Internal-Token': 'wrong' })
      ).status,
    ).toBe(401);
  });

  test('no INTERNAL_API_TOKEN configured -> 503 (fail closed)', async () => {
    const saved = config.internal.token;
    config.internal.token = '';
    try {
      expect(
        (
          await request(internal)
            .get('/internal/posts')
            .set(svc(['posts:read']))
        ).status,
      ).toBe(503);
    } finally {
      config.internal.token = saved;
    }
  });

  test('the internal listener binds to loopback and a port other than the public one by default', () => {
    expect(config.internal.host).toBe('127.0.0.1');
    expect(String(config.internal.port)).not.toBe(String(config.port));
  });
});

describe('/internal API', () => {
  test('posts + latest metrics are scoped to the token org', async () => {
    const r = await request(internal)
      .get('/internal/posts')
      .set(svc(['posts:read']));
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(6);
    const m = await request(internal)
      .get(`/internal/metrics?postId=${seed.postIds.breath}`)
      .set(svc(['metrics:read']));
    const views = m.body.data.find((x) => x.metric === 'views');
    expect(views.value).toBe(184000);
    const other = await request(internal)
      .get('/internal/posts')
      .set(svc(['posts:read'], new mongoose.Types.ObjectId().toString()));
    expect(other.body.data).toHaveLength(0);
    const cross = await request(internal)
      .get(`/internal/posts/${seed.postIds.breath}/retention`)
      .set(svc(['metrics:read'], new mongoose.Types.ObjectId().toString()));
    expect(cross.status).toBe(404);
  });

  test('scopes are enforced', async () => {
    const r = await request(internal)
      .get('/internal/brand/rules')
      .set(svc(['posts:read']));
    expect(r.status).toBe(403);
  });

  test('retention, media, brand rules and review comments', async () => {
    const ret = await request(internal)
      .get(`/internal/posts/${seed.postIds.breath}/retention`)
      .set(svc(['metrics:read']));
    const peak = ret.body.data
      .filter((p) => p.second > 5)
      .reduce((a, b) => (b.audienceWatchRatio > a.audienceWatchRatio ? b : a));
    expect(peak.second).toBe(42);
    const media = await request(internal)
      .get(`/internal/posts/${seed.postIds.breath}/media`)
      .set(svc(['posts:read']));
    expect(media.body.data.sceneCuts.length).toBeGreaterThan(3);
    const rules = await request(internal)
      .get('/internal/brand/rules')
      .set(svc(['brand:read']));
    expect(rules.body.data.map((x) => x.title)).toContain('Call to action');
    const cs = await request(internal)
      .get(`/internal/review-comments?postId=${seed.postIds.dads}`)
      .set(svc(['reviews:read']));
    expect(cs.body.data).toHaveLength(7);
  });

  test('insights are validated against the shared contract', async () => {
    const bad = await request(internal)
      .post('/internal/insights')
      .set(svc(['insights:write']))
      .send({ postId: seed.postIds.breath, kind: 'nope', summary: 'x' });
    expect(bad.status).toBe(400);
    const good = await request(internal)
      .post('/internal/insights')
      .set(svc(['insights:write']))
      .send({
        postId: seed.postIds.breath,
        kind: 'retention_spike',
        summary: 'Spike at 0:42',
        atSecond: 42,
        citations: [{ postId: seed.postIds.breath, metric: 'retention@0:42', value: 1.31 }],
        dataLimits: ['x'],
      });
    expect(good.status).toBe(201);
    expect(await Insight.countDocuments({ organizationId: seed.orgId })).toBe(1);
  });

  test('transcript PUT stores segments', async () => {
    const r = await request(internal)
      .put(`/internal/posts/${seed.postIds.dads}/media`)
      .set(svc(['assets:write']))
      .send({
        transcript: [{ start: 0, end: 6, text: 'hello' }],
        transcriptEngine: 'whisper-turbo',
      });
    expect(r.body.data.segments).toBe(1);
  });
});

describe('jobs over Redis Streams', () => {
  test('enqueue XADDs a versioned envelope with a scoped job token, result updates the job', async () => {
    const r = await request(app)
      .post(`/api/v1/organizations/${seed.orgId}/agent/posts/${seed.postIds.breath}/analyze`)
      .set({ Authorization: `Bearer ${userToken}` });
    expect(r.status).toBe(202);
    const [stream, , , type, , env] = fakeRedis.added.at(-1);
    expect(stream).toBe('yv:jobs');
    expect(type).toBe('insights.analyze_post.v1');
    const envelope = JSON.parse(env);
    expect(envelope).toMatchObject({
      jobId: r.body.data.jobId,
      orgId: seed.orgId,
      attempt: 0,
      payload: { postId: seed.postIds.breath },
    });
    const claims = verifyServiceToken(envelope.serviceToken);
    expect(claims.scopes).toEqual(expect.arrayContaining(['insights:write', 'jobs:write']));
    expect(claims.scopes).not.toContain('assets:write');

    const done = await request(internal)
      .post(`/internal/jobs/${envelope.jobId}/result`)
      .set({ ...INTERNAL(), Authorization: `Bearer ${envelope.serviceToken}` })
      .send({ type: envelope.type, status: 'succeeded', result: { insightId: 'x' }, attempts: 1 });
    expect(done.status).toBe(200);
    const job = await request(app)
      .get(`/api/v1/organizations/${seed.orgId}/agent/jobs/${envelope.jobId}`)
      .set({ Authorization: `Bearer ${userToken}` });
    expect(job.body.data.status).toBe('succeeded');
    expect((await AgentJob.findOne({ jobId: envelope.jobId })).attempts).toBe(1);
  });

  test('non-members cannot enqueue', async () => {
    const r = await request(app)
      .post(`/api/v1/organizations/${new mongoose.Types.ObjectId()}/agent/brand/reindex`)
      .set({ Authorization: `Bearer ${userToken}` });
    expect(r.status).toBe(404); // non-members: 404, not 403 (ADR-0015)
  });
});

describe('chat SSE proxy', () => {
  test('streams the agent SSE through and forwards a read-only service token', async () => {
    let seenAuth;
    const fakeAgent = http.createServer((req, res) => {
      seenAuth = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: meta\ndata: {"flow":"insight"}\n\n');
      res.write('event: token\ndata: {"text":"Spike at 0:42"}\n\n');
      res.end('event: done\ndata: {}\n\n');
    });
    await new Promise((r) => fakeAgent.listen(0, '127.0.0.1', r));
    const prev = config.agent.url;
    config.agent.url = `http://127.0.0.1:${fakeAgent.address().port}`;
    try {
      const r = await request(app)
        .post(`/api/v1/organizations/${seed.orgId}/agent/chat`)
        .set({ Authorization: `Bearer ${userToken}` })
        .send({ message: 'why viral?' });
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/text\/event-stream/);
      expect(r.text).toContain('Spike at 0:42');
      const claims = verifyServiceToken(seenAuth.slice(7));
      expect(claims.orgId).toBe(seed.orgId);
      expect(claims.scopes).not.toContain('insights:write');
    } finally {
      config.agent.url = prev;
      fakeAgent.close();
    }
  });

  test('pushes the org brand context and the shared secret (lean agent: no /internal callback)', async () => {
    let seen;
    const fakeAgent = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seen = { headers: req.headers, body: JSON.parse(raw) };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('event: meta\ndata: {"flow":"brand_qa"}\n\nevent: done\ndata: {}\n\n');
      });
    });
    await new Promise((r) => fakeAgent.listen(0, '127.0.0.1', r));
    const prev = { url: config.agent.url, secret: config.agent.sharedSecret };
    config.agent.url = `http://127.0.0.1:${fakeAgent.address().port}`;
    config.agent.sharedSecret = 'k'.repeat(40);
    try {
      const r = await request(app)
        .post(`/api/v1/organizations/${seed.orgId}/agent/chat`)
        .set({ Authorization: `Bearer ${userToken}` })
        .send({ message: 'Where does the logo go?' });
      expect(r.status).toBe(200);
      expect(seen.headers['x-agent-secret']).toBe('k'.repeat(40));
      const ctx = seen.body.context;
      expect(ctx.brandRules.length).toBeGreaterThan(0);
      expect(ctx.brandRules[0]).toEqual(expect.objectContaining({ id: expect.any(String), title: expect.any(String), body: expect.any(String) }));
      expect(ctx.posts.every((p) => p.orgId === String(seed.orgId))).toBe(true);
      const postIds = new Set(ctx.posts.map((p) => p.id));
      expect(ctx.metrics.every((m) => postIds.has(m.postId))).toBe(true);
      expect(ctx.reviewComments.every((c) => postIds.has(c.postId))).toBe(true);
    } finally {
      config.agent.url = prev.url;
      config.agent.sharedSecret = prev.secret;
      fakeAgent.close();
    }
  });

  test('an agent that sends nothing within chatFirstByteMs gets a readable 504, not a hang', async () => {
    const fakeAgent = http.createServer(() => {
      /* never answers */
    });
    await new Promise((r) => fakeAgent.listen(0, '127.0.0.1', r));
    const prev = { url: config.agent.url, fb: config.agent.chatFirstByteMs };
    config.agent.url = `http://127.0.0.1:${fakeAgent.address().port}`;
    config.agent.chatFirstByteMs = 300;
    try {
      const t0 = Date.now();
      const r = await request(app)
        .post(`/api/v1/organizations/${seed.orgId}/agent/chat`)
        .set({ Authorization: `Bearer ${userToken}` })
        .send({ message: 'hi' });
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(r.status).toBe(504);
      expect(r.body.error.code).toBe('agent_timeout');
      expect(r.body.error.message).toMatch(/waking up/);
    } finally {
      config.agent.url = prev.url;
      config.agent.chatFirstByteMs = prev.fb;
      fakeAgent.closeAllConnections?.();
      fakeAgent.close();
    }
  });

  test('returns 502 when the agent is down', async () => {
    const prev = config.agent.url;
    config.agent.url = 'http://127.0.0.1:9';
    const r = await request(app)
      .post(`/api/v1/organizations/${seed.orgId}/agent/chat`)
      .set({ Authorization: `Bearer ${userToken}` })
      .send({ message: 'hi' });
    config.agent.url = prev;
    expect(r.status).toBe(502);
  });
  test('an upstream HTML error page (Render 502 while waking) becomes a short readable message', async () => {
    const fakeAgent = http.createServer((req, res) => {
      res.writeHead(502, { 'content-type': 'text/html' });
      res.end('<!DOCTYPE html><html><head><title>502</title><style>body{}</style></head><body>Bad Gateway</body></html>');
    });
    await new Promise((r) => fakeAgent.listen(0, '127.0.0.1', r));
    const prev = config.agent.url;
    config.agent.url = `http://127.0.0.1:${fakeAgent.address().port}`;
    try {
      const r = await request(app)
        .post(`/api/v1/organizations/${seed.orgId}/agent/chat`)
        .set({ Authorization: `Bearer ${userToken}` })
        .send({ message: 'hi' });
      expect(r.status).toBe(502);
      expect(r.body.error.code).toBe('agent_error');
      expect(r.body.error.message).toBe('The agent service is waking up or unavailable (HTTP 502). Try again in a minute.');
      expect(r.body.error.message).not.toMatch(/</);
    } finally {
      config.agent.url = prev;
      fakeAgent.close();
    }
  });

  test('agentErrorMessage: JSON detail, plain text, empty', () => {
    const { agentErrorMessage } = require('../src/routes/agent');
    expect(agentErrorMessage(500, '{"detail":"model quota exceeded"}')).toBe('model quota exceeded');
    expect(agentErrorMessage(500, '{"error":{"message":"bad input"}}')).toBe('bad input');
    expect(agentErrorMessage(503, '  upstream\n  timeout ')).toBe('upstream timeout');
    expect(agentErrorMessage(502, '')).toBe('The agent service returned an error (HTTP 502).');
    expect(agentErrorMessage(429, '<html>busy</html>')).toMatch(/busy right now \(HTTP 429\)/);
    expect(agentErrorMessage(502, 'x'.repeat(1000))).toHaveLength(300);
  });
});
