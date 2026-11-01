const request = require('supertest');
const app = require('../src/app');
const mongoose = require('mongoose');

beforeAll(async () => {
  // tests/setup.js sets process.env.MONGO_URI for in-memory server
  await require('../src/db/mongo').connect();
});

afterAll(async () => {
  await mongoose.disconnect();
  if (global.__MONGOD__) await global.__MONGOD__.stop();
});

describe('Auth routes', () => {
  const email = `testuser@example.com`;
  test('register -> login flow', async () => {
    const reg = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Test User', email, password: 'P@ssw0rd' });
    expect(reg.statusCode).toBe(201);
    expect(reg.body.data).toHaveProperty('email', email);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'P@ssw0rd' });
    expect(login.statusCode).toBe(200);
    expect(login.body.data).toHaveProperty('accessToken');
    // ADR-0017: the refresh token lives in an httpOnly cookie, not in JS...
    expect(login.body.data).not.toHaveProperty('refreshToken');
    expect(login.headers['set-cookie'].join(';')).toMatch(/refreshToken=[a-f0-9]{128};.*HttpOnly/);
    // ...unless a non-browser client asks for it in the body.
    const api = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'P@ssw0rd', tokenTransport: 'body' });
    expect(api.body.data).toHaveProperty('refreshToken');
  });
});
