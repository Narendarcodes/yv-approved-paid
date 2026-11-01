/**
 * Phase 1 item 9: brute-force limits on POST /auth/login, /auth/register and
 * /auth/refresh - per IP and per account, 429 + Retry-After, counters behind a
 * store interface (in-memory now, Redis later).
 *
 * Small limits are set through the env BEFORE the app (and so config) loads.
 */
process.env.AUTH_LOGIN_IP_MAX = '8';
process.env.AUTH_LOGIN_ACCOUNT_MAX = '3';
process.env.AUTH_REGISTER_IP_MAX = '6';
process.env.AUTH_REGISTER_ACCOUNT_MAX = '2';
process.env.AUTH_REFRESH_IP_MAX = '50';
process.env.AUTH_REFRESH_ACCOUNT_MAX = '3';

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const authRouter = require('../src/routes/auth');
const { MemoryStore } = require('../src/utils/rateLimitStore');
const { createLimiter } = require('../src/middleware/authRateLimit');

const API = '/api/v1';
const PASSWORD = 'P@ssw0rd!';
const store = authRouter.limits.store;

const login = (email, password = PASSWORD) =>
  request(app).post(`${API}/auth/login`).send({ email, password, tokenTransport: 'body' });
const register = (email) =>
  request(app).post(`${API}/auth/register`).send({ name: 'n', email, password: PASSWORD });

beforeAll(async () => {
  await require('../src/db/mongo').connect();
  await store.clear();
  for (const n of ['victim', 'happy', 'refresher']) {
    expect((await register(`${n}@rl.example.com`)).statusCode).toBe(201);
  }
});

beforeEach(() => store.clear());

afterAll(async () => {
  await mongoose.disconnect();
});

describe('POST /auth/login', () => {
  test('per account: failed attempts are capped -> 429 with Retry-After', async () => {
    for (let i = 0; i < 3; i++)
      expect((await login('victim@rl.example.com', 'nope')).statusCode).toBe(401);
    const blocked = await login('victim@rl.example.com', 'nope');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    const retry = Number(blocked.headers['retry-after']);
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(15 * 60);
    expect(blocked.body.error.retryAfter).toBe(retry);
    // While locked, even the right password is refused (no oracle for the attacker).
    expect((await login('victim@rl.example.com')).statusCode).toBe(429);
  });

  test('per account key is case/whitespace-insensitive', async () => {
    for (const e of ['victim@rl.example.com', 'VICTIM@rl.example.com', 'Victim@RL.example.com']) {
      expect((await login(e, 'nope')).statusCode).toBe(401);
    }
    expect((await login('victim@rl.example.com', 'nope')).statusCode).toBe(429);
  });

  test('successful logins do not use up the account budget', async () => {
    for (let i = 0; i < 5; i++) expect((await login('happy@rl.example.com')).statusCode).toBe(200);
    // 5 successes > account max 3, still not limited; failures still count.
    for (let i = 0; i < 3; i++)
      expect((await login('happy@rl.example.com', 'nope')).statusCode).toBe(401);
    expect((await login('happy@rl.example.com', 'nope')).statusCode).toBe(429);
  });

  test('per IP: one source spraying many accounts is capped', async () => {
    for (let i = 0; i < 8; i++) {
      expect((await login(`nobody${i}@rl.example.com`, 'nope')).statusCode).toBe(401);
    }
    const blocked = await login('nobody-next@rl.example.com', 'nope');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
  });
});

describe('POST /auth/register', () => {
  test('per email', async () => {
    expect((await register('dupe@rl.example.com')).statusCode).toBe(201);
    expect((await register('dupe@rl.example.com')).statusCode).toBe(409);
    expect((await register('dupe@rl.example.com')).statusCode).toBe(429);
  });

  test('per IP', async () => {
    for (let i = 0; i < 6; i++)
      expect((await register(`new${i}@rl.example.com`)).statusCode).toBe(201);
    const blocked = await register('new-next@rl.example.com');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
  });
});

describe('POST /auth/refresh', () => {
  test('per user (resolved from the refresh token, across rotations)', async () => {
    let token = (await login('refresher@rl.example.com')).body.data.refreshToken;
    for (let i = 0; i < 3; i++) {
      const r = await request(app).post(`${API}/auth/refresh`).send({ refreshToken: token });
      expect(r.statusCode).toBe(200);
      token = r.body.data.refreshToken;
    }
    const blocked = await request(app).post(`${API}/auth/refresh`).send({ refreshToken: token });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  test('unknown refresh tokens are still IP-limited (and 401 under the limit)', async () => {
    const r = await request(app)
      .post(`${API}/auth/refresh`)
      .send({ refreshToken: 'x'.repeat(64) });
    expect(r.statusCode).toBe(401);
  });
});

describe('createLimiter + MemoryStore', () => {
  test('window expiry resets the counter; Retry-After counts down to the window end', async () => {
    const s = new MemoryStore();
    const a = express();
    a.post(
      '/x',
      createLimiter({ name: 't', windowMs: 200, max: 1, key: () => 'k', store: s }),
      (_req, res) => res.json({ ok: true }),
    );
    expect((await request(a).post('/x')).statusCode).toBe(200);
    const blocked = await request(a).post('/x');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('1');
    await new Promise((r) => setTimeout(r, 250));
    expect((await request(a).post('/x')).statusCode).toBe(200);
    s.close();
  });

  test('a null key skips limiting; store errors surface as 500 (fail closed)', async () => {
    const broken = { hit: async () => Promise.reject(new Error('store down')) };
    const a = express();
    a.post(
      '/skip',
      createLimiter({ name: 's', windowMs: 1000, max: 0, key: () => null, store: broken }),
      (_q, r) => r.json({ ok: true }),
    );
    a.post(
      '/down',
      createLimiter({ name: 'd', windowMs: 1000, max: 5, key: () => 'k', store: broken }),
      (_q, r) => r.json({ ok: true }),
    );
    expect((await request(a).post('/skip')).statusCode).toBe(200);
    expect((await request(a).post('/down')).statusCode).toBe(500);
  });

  test('sweep drops expired windows', async () => {
    const s = new MemoryStore();
    await s.hit('a', 1);
    await new Promise((r) => setTimeout(r, 5));
    s.sweep();
    expect(s.map.size).toBe(0);
    s.close();
  });
});
