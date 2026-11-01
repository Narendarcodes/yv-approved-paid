/**
 * Phase 1 item 5: the Postiz webhook fails closed and verifies its caller
 * with constant-time comparisons.
 */
const crypto = require('crypto');
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const config = require('../src/config');
const { safeEqual } = require('../src/routes/webhooks');

const URL = '/api/v1/webhooks/postiz';
const SECRET = 'whsec-0123456789abcdef0123456789abcdef';
const body = { id: 'pz_unknown', state: 'PUBLISHED' };

beforeAll(async () => {
  await require('../src/db/mongo').connect();
});
afterAll(async () => {
  config.postiz.webhookSecret = '';
  await mongoose.disconnect();
});

describe('POSTIZ_WEBHOOK_SECRET empty -> reject everything', () => {
  beforeAll(() => {
    config.postiz.webhookSecret = '';
  });
  test.each([
    ['no auth', {}],
    ['any header value', { 'X-Postiz-Signature': '' }],
    ['webhook secret header', { 'X-Webhook-Secret': 'anything' }],
  ])('%s -> 503', async (_n, headers) => {
    const r = await request(app).post(URL).set(headers).send(body);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('webhook_not_configured');
  });
  test('path token -> 503', async () => {
    expect((await request(app).post(`${URL}/x`).send(body)).status).toBe(503);
  });
});

describe('POSTIZ_WEBHOOK_SECRET set', () => {
  beforeAll(() => {
    config.postiz.webhookSecret = SECRET;
  });

  test('missing or wrong proof -> 401', async () => {
    expect((await request(app).post(URL).send(body)).status).toBe(401);
    expect((await request(app).post(URL).set('X-Postiz-Signature', 'nope').send(body)).status).toBe(
      401,
    );
    expect(
      (await request(app).post(URL).set('X-Webhook-Secret', `${SECRET}x`).send(body)).status,
    ).toBe(401);
    expect((await request(app).post(`${URL}/wrong-token`).send(body)).status).toBe(401);
  });

  test('shared secret header -> 200', async () => {
    const r = await request(app).post(URL).set('X-Webhook-Secret', SECRET).send(body);
    expect(r.status).toBe(200);
    expect(r.body.data.ok).toBe(true);
  });

  test('secret as path token (stock Postiz, no headers) -> 200', async () => {
    expect((await request(app).post(`${URL}/${SECRET}`).send(body)).status).toBe(200);
  });

  test('HMAC-SHA256 over the raw body -> 200; same signature on a tampered body -> 401', async () => {
    const raw = JSON.stringify(body);
    const sig = `sha256=${crypto.createHmac('sha256', SECRET).update(raw).digest('hex')}`;
    const ok = await request(app)
      .post(URL)
      .set('Content-Type', 'application/json')
      .set('X-Postiz-Signature', sig)
      .send(raw);
    expect(ok.status).toBe(200);
    const tampered = await request(app)
      .post(URL)
      .set('Content-Type', 'application/json')
      .set('X-Postiz-Signature', sig)
      .send(JSON.stringify({ ...body, state: 'ERROR' }));
    expect(tampered.status).toBe(401);
  });
});

describe('safeEqual', () => {
  test('constant-time compare via timingSafeEqual on fixed-length digests', () => {
    const spy = jest.spyOn(crypto, 'timingSafeEqual');
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false); // different lengths still compared in constant time
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [a, b] of spy.mock.calls) expect([a.length, b.length]).toEqual([32, 32]);
    spy.mockRestore();
  });
  test('empty / non-string never matches', () => {
    expect(safeEqual('', '')).toBe(false);
    expect(safeEqual(undefined, 'x')).toBe(false);
  });
});
