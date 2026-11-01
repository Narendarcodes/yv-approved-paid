/**
 * Phase 1 item 8 / ADR-0017: browser sessions live in httpOnly cookies with a
 * rotating refresh token and signed double-submit CSRF protection.
 */
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const Role = require('../src/models/role.model');
const RefreshToken = require('../src/models/refreshToken.model');
const User = require('../src/models/user.model');
const authService = require('../src/services/auth.service');
const { hashToken } = require('../src/utils/tokens');
const { issueCsrfToken } = require('../src/utils/csrf');

const API = '/api/v1';
const PASSWORD = 'P@ssw0rd!';

/** Parse Set-Cookie into { name: { value, attrs } }. */
function cookiesOf(res) {
  const out = {};
  for (const line of res.headers['set-cookie'] || []) {
    const [pair, ...attrs] = line.split(';').map((s) => s.trim());
    const i = pair.indexOf('=');
    out[pair.slice(0, i)] = {
      value: decodeURIComponent(pair.slice(i + 1)),
      attrs: attrs.map((a) => a.toLowerCase()),
    };
  }
  return out;
}

/** A browser-like session: a cookie jar + the CSRF token the client keeps. */
async function browserLogin(email) {
  const res = await request(app).post(`${API}/auth/login`).send({ email, password: PASSWORD });
  const c = cookiesOf(res);
  return {
    res,
    access: c.accessToken.value,
    refresh: c.refreshToken.value,
    csrf: c.csrfToken.value,
    jar() {
      return [`accessToken=${this.access}`, `csrfToken=${this.csrf}`];
    },
    refreshJar() {
      return [`refreshToken=${this.refresh}`, `csrfToken=${this.csrf}`];
    },
  };
}

let orgId;

beforeAll(async () => {
  await require('../src/db/mongo').connect();
  await Role.create({ name: 'admin', permissions: ['*'] });
  for (const n of ['cookie', 'other', 'disabled']) {
    await request(app)
      .post(`${API}/auth/register`)
      .send({ name: n, email: `${n}@session.example.com`, password: PASSWORD });
  }
  const s = await browserLogin('cookie@session.example.com');
  const org = await request(app)
    .post(`${API}/organizations`)
    .set('Cookie', s.jar())
    .set('X-CSRF-Token', s.csrf)
    .send({ name: 'Cookie Org', slug: 'cookie-org' });
  expect(org.status).toBe(201);
  orgId = org.body.data._id;
});

afterAll(async () => {
  await mongoose.disconnect();
});

describe('login', () => {
  test('sets httpOnly access + refresh cookies, a readable CSRF cookie, and no refresh token in the body', async () => {
    const { res } = await browserLogin('cookie@session.example.com');
    const c = cookiesOf(res);
    expect(c.accessToken.attrs).toEqual(
      expect.arrayContaining(['httponly', 'samesite=strict', 'path=/']),
    );
    expect(c.refreshToken.attrs).toEqual(
      expect.arrayContaining(['httponly', 'samesite=strict', 'path=/api/v1/auth']),
    );
    expect(c.csrfToken.attrs).not.toContain('httponly');
    expect(c.csrfToken.attrs).toContain('samesite=strict');
    expect(res.body.data.csrfToken).toBe(c.csrfToken.value);
    expect(res.body.data).not.toHaveProperty('refreshToken');
    expect(JSON.stringify(res.body)).not.toContain(c.refreshToken.value);
  });
});

describe('CSRF on cookie-authenticated requests', () => {
  let s;
  beforeAll(async () => {
    s = await browserLogin('cookie@session.example.com');
  });
  const create = (cookies, csrf) => {
    const r = request(app).post(`${API}/projects`).set('Cookie', cookies);
    if (csrf) r.set('X-CSRF-Token', csrf);
    return r.send({ organizationId: orgId, title: 'via cookie' });
  };

  test('safe methods need no CSRF token', async () => {
    expect((await request(app).get(`${API}/auth/me`).set('Cookie', s.jar())).status).toBe(200);
  });

  test('unsafe method without X-CSRF-Token -> 403 csrf_failed', async () => {
    const r = await create(s.jar());
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('csrf_failed');
  });

  test('header must equal the cookie', async () => {
    expect((await create(s.jar(), issueCsrfToken('x'))).status).toBe(403);
  });

  test('a token from another session (or forged into the cookie too) fails the HMAC binding', async () => {
    const other = await browserLogin('other@session.example.com');
    const planted = [`accessToken=${s.access}`, `csrfToken=${other.csrf}`];
    expect((await create(planted, other.csrf)).status).toBe(403);
  });

  test('valid header + cookie -> allowed', async () => {
    expect((await create(s.jar(), s.csrf)).status).toBe(201);
  });

  test('Bearer (non-browser) requests are not cookie-authenticated and skip CSRF', async () => {
    const r = await request(app)
      .post(`${API}/projects`)
      .set('Authorization', `Bearer ${s.access}`)
      .send({ organizationId: orgId, title: 'via bearer' });
    expect(r.status).toBe(201);
  });

  test('GET /auth/csrf returns the session token after a reload', async () => {
    const r = await request(app).get(`${API}/auth/csrf`).set('Cookie', s.jar());
    expect(r.status).toBe(200);
    expect(r.body.data.csrfToken).toBe(s.csrf);
  });
});

describe('refresh rotation (cookie mode)', () => {
  test('needs the CSRF token, re-sets the access cookie, rotates the refresh cookie, returns no tokens', async () => {
    const s = await browserLogin('cookie@session.example.com');
    const noCsrf = await request(app)
      .post(`${API}/auth/refresh`)
      .set('Cookie', s.refreshJar())
      .send({});
    expect(noCsrf.status).toBe(403);

    const r = await request(app)
      .post(`${API}/auth/refresh`)
      .set('Cookie', s.refreshJar())
      .set('X-CSRF-Token', s.csrf)
      .send({});
    expect(r.status).toBe(200);
    const c = cookiesOf(r);
    expect(c.accessToken.value).toBeTruthy(); // the <video> cookie is renewed too
    expect(c.refreshToken.value).not.toBe(s.refresh);
    expect(r.body.data).not.toHaveProperty('accessToken');
    expect(r.body.data).not.toHaveProperty('refreshToken');
    expect(r.body.data.csrfToken).toBe(s.csrf); // stable across refresh: in-flight requests keep working
    const me = await request(app)
      .get(`${API}/auth/me`)
      .set('Cookie', [`accessToken=${c.accessToken.value}`]);
    expect(me.status).toBe(200);
  });

  test('replaying a rotated refresh token after the race window revokes the whole session', async () => {
    const s = await browserLogin('cookie@session.example.com');
    const r1 = await request(app)
      .post(`${API}/auth/refresh`)
      .set('Cookie', s.refreshJar())
      .set('X-CSRF-Token', s.csrf)
      .send({});
    const newRefresh = cookiesOf(r1).refreshToken.value;
    // age the rotation past the grace window
    await RefreshToken.updateOne(
      { tokenHash: hashToken(s.refresh) },
      { $set: { rotatedAt: new Date(Date.now() - 5 * 60 * 1000) } },
    );

    const replay = await request(app)
      .post(`${API}/auth/refresh`)
      .set('Cookie', s.refreshJar())
      .set('X-CSRF-Token', s.csrf)
      .send({});
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('refresh_reused');
    // the legitimate holder of the NEW token is logged out too (family revoked)
    const legit = await request(app)
      .post(`${API}/auth/refresh`)
      .set('Cookie', [`refreshToken=${newRefresh}`, `csrfToken=${s.csrf}`])
      .set('X-CSRF-Token', s.csrf)
      .send({});
    expect(legit.status).toBe(401);
  });

  test('two tabs racing on the same token within the window both succeed', async () => {
    const s = await browserLogin('cookie@session.example.com');
    const a = await authService.rotateRefreshToken(s.refresh);
    const b = await authService.rotateRefreshToken(s.refresh);
    expect(a.sessionId).toBe(b.sessionId);
    expect(a.newRefresh).not.toBe(b.newRefresh);
  });

  test('body mode (API clients) keeps the old contract', async () => {
    const login = await request(app)
      .post(`${API}/auth/login`)
      .send({ email: 'other@session.example.com', password: PASSWORD, tokenTransport: 'body' });
    const r = await request(app)
      .post(`${API}/auth/refresh`)
      .send({ refreshToken: login.body.data.refreshToken });
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveProperty('accessToken');
    expect(r.body.data).toHaveProperty('refreshToken');
  });
});

describe('logout', () => {
  test('requires CSRF, revokes the session server-side and clears the cookies', async () => {
    const s = await browserLogin('cookie@session.example.com');
    expect(
      (await request(app).post(`${API}/auth/logout`).set('Cookie', s.refreshJar()).send({})).status,
    ).toBe(403);
    const r = await request(app)
      .post(`${API}/auth/logout`)
      .set('Cookie', s.refreshJar())
      .set('X-CSRF-Token', s.csrf)
      .send({});
    expect(r.status).toBe(200);
    const c = cookiesOf(r);
    for (const n of ['accessToken', 'refreshToken', 'csrfToken'])
      expect(c[n].attrs.join(';')).toMatch(/expires=thu, 01 jan 1970/);
    const again = await request(app)
      .post(`${API}/auth/refresh`)
      .set('Cookie', s.refreshJar())
      .set('X-CSRF-Token', s.csrf)
      .send({});
    expect(again.status).toBe(401);
  });
});

describe('access token hygiene', () => {
  test('?token= is not accepted on any route', async () => {
    const s = await browserLogin('cookie@session.example.com');
    expect((await request(app).get(`${API}/auth/me?token=${s.access}`)).status).toBe(401);
  });

  test('a disabled user is refused even with a still-valid access token', async () => {
    const s = await browserLogin('disabled@session.example.com');
    await User.updateOne({ email: 'disabled@session.example.com' }, { $set: { disabled: true } });
    expect((await request(app).get(`${API}/auth/me`).set('Cookie', s.jar())).status).toBe(403);
  });
});
