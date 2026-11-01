/**
 * Phase 1 items 4 + 10: fail-fast production config, CORS allowlist with
 * credentials, secure headers.
 */
const request = require('supertest');
const mongoose = require('mongoose');
const { validateEnv } = require('../src/config/validate');
const app = require('../src/app');

const STRONG = 'x'.repeat(40);
const goodProd = () => ({
  NODE_ENV: 'production',
  JWT_ACCESS_SECRET: `jwt-${STRONG}`,
  CSRF_SECRET: `csrf-${STRONG}`,
  CORS_ORIGIN: 'https://app.example.com,https://admin.example.com',
  MONGO_URI: 'mongodb://db/yv',
  SERVICE_JWT_SECRET: `svc-${STRONG}`,
  INTERNAL_API_TOKEN: `int-${STRONG}`,
});

describe('validateEnv (fail-fast production config)', () => {
  test('a complete production env passes', () => {
    expect(validateEnv(goodProd())).toEqual([]);
  });

  test('production refuses to start without CORS_ORIGIN', () => {
    const env = goodProd();
    delete env.CORS_ORIGIN;
    expect(validateEnv(env).join('\n')).toMatch(/CORS_ORIGIN is required in production/);
  });

  test("'*' and non-origin entries are rejected (credentials need an explicit list)", () => {
    expect(validateEnv({ ...goodProd(), CORS_ORIGIN: '*' }).join('\n')).toMatch(
      /'\*' is not allowed/,
    );
    expect(
      validateEnv({ ...goodProd(), CORS_ORIGIN: 'https://app.example.com/path' }).join('\n'),
    ).toMatch(/is not an origin/);
  });

  test('weak or default secrets and missing MONGO_URI are all reported at once', () => {
    const env = { ...goodProd(), JWT_ACCESS_SECRET: 'change-me', SERVICE_JWT_SECRET: 'short' };
    delete env.MONGO_URI;
    const errs = validateEnv(env);
    expect(errs.join('\n')).toMatch(/JWT_ACCESS_SECRET/);
    expect(errs.join('\n')).toMatch(/SERVICE_JWT_SECRET/);
    expect(errs.join('\n')).toMatch(/MONGO_URI/);
  });

  test('agent secrets are only required when the agent platform is enabled', () => {
    const env = { ...goodProd(), AGENT_ENABLED: 'false' };
    delete env.SERVICE_JWT_SECRET;
    expect(validateEnv(env)).toEqual([]);
  });

  test('the Postiz webhook secret is required once Postiz is configured', () => {
    expect(
      validateEnv({
        ...goodProd(),
        POSTIZ_API_URL: 'https://postiz.example.com/api/public/v1',
      }).join('\n'),
    ).toMatch(/POSTIZ_WEBHOOK_SECRET/);
  });

  test('development needs none of it', () => {
    expect(validateEnv({ NODE_ENV: 'development' })).toEqual([]);
  });

  test('loading config in production with a bad env throws one aggregated error', () => {
    const saved = { ...process.env };
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.CORS_ORIGIN;
      process.env.JWT_ACCESS_SECRET = 'change-me';
      let load;
      jest.isolateModules(() => {
        load = () => require('../src/config');
        expect(load).toThrow(/Invalid configuration:[\s\S]*JWT_ACCESS_SECRET[\s\S]*CORS_ORIGIN/);
      });
    } finally {
      process.env = saved;
    }
  });
});

describe('CORS allowlist + secure headers', () => {
  afterAll(async () => {
    await mongoose.disconnect();
  });

  test('an allowed origin gets ACAO echoed with credentials', async () => {
    const r = await request(app).get('/api/v1/health').set('Origin', 'http://localhost:5173');
    expect(r.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(r.headers['access-control-allow-credentials']).toBe('true');
  });

  test('any other origin gets no CORS headers (browser blocks the response)', async () => {
    const r = await request(app).get('/api/v1/health').set('Origin', 'https://evil.example.com');
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    const pre = await request(app)
      .options('/api/v1/projects')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('helmet headers are set and X-Powered-By is gone', async () => {
    const r = await request(app).get('/api/v1/health');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['strict-transport-security']).toMatch(/max-age=/);
    expect(r.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(r.headers['cross-origin-resource-policy']).toBe('same-site');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });
});
