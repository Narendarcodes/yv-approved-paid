/**
 * Unit tests for the Socket.IO handshake middleware in src/realtime/socket.js.
 *
 * Rather than spinning up a real HTTP server, we invoke the middleware
 * function directly and assert its accept/reject behavior for various
 * token states (valid, invalid, expired-with-refresh).
 */
const jwt = require('jsonwebtoken');
const config = require('../src/config');

describe('Socket.IO handshake middleware', () => {
  const _middleware = null;
  void _middleware;

  beforeAll(() => {
    // Re-require socket.js to get the middleware via io.use inspection
    // We test by extracting the use() middleware
    const _socketModule = require('../src/realtime/socket');
    void _socketModule;
    // The module doesn't export the middleware directly; we test via behavior
  });

  test('verifyAccessToken accepts a valid token', () => {
    const { verifyAccessToken, generateAccessToken } = require('../src/utils/tokens');
    const token = generateAccessToken({ sub: '507f1f779c2a5b1f8c8e4d2a' });
    const payload = verifyAccessToken(token);
    expect(payload).toBeTruthy();
    expect(payload.sub).toBe('507f1f779c2a5b1f8c8e4d2a');
  });

  test('verifyAccessToken rejects an expired token', () => {
    const { verifyAccessToken } = require('../src/utils/tokens');
    const expiredToken = jwt.sign({ sub: '507f1f779c2a5b1f8c8e4d2a' }, config.jwt.accessSecret, {
      expiresIn: '-1s',
    });
    const payload = verifyAccessToken(expiredToken);
    expect(payload).toBeNull();
  });

  describe('handshakeAuth (ADR-0017)', () => {
    const { handshakeAuth } = require('../src/realtime/socket');
    const { generateAccessToken } = require('../src/utils/tokens');
    const run = (handshake) =>
      new Promise((resolve) => {
        const socket = { handshake: { auth: {}, headers: {}, ...handshake }, data: {} };
        handshakeAuth(socket, (err) => resolve({ err, socket }));
      });
    const uid = '507f1f779c2a5b1f8c8e4d2a';

    test('accepts the httpOnly access cookie from an allowlisted origin', async () => {
      const token = generateAccessToken({ sub: uid });
      const { err, socket } = await run({
        headers: { cookie: `a=1; accessToken=${token}`, origin: config.corsOrigin[0] },
      });
      expect(err).toBeUndefined();
      expect(socket.data.userId).toBe(uid);
    });

    test('refuses a cookie handshake from a foreign origin (cross-site WebSocket hijacking)', async () => {
      const token = generateAccessToken({ sub: uid });
      const { err } = await run({
        headers: { cookie: `accessToken=${token}`, origin: 'https://evil.example.com' },
      });
      expect(err && err.message).toBe('forbidden_origin');
    });

    test('accepts an explicit auth.token (non-browser clients)', async () => {
      const { err } = await run({ auth: { token: generateAccessToken({ sub: uid }) } });
      expect(err).toBeUndefined();
    });

    test('never accepts a refresh token: expired access -> unauthorized, client refreshes over REST', async () => {
      const expired = jwt.sign({ sub: uid }, config.jwt.accessSecret, { expiresIn: '-1s' });
      const { err } = await run({ auth: { token: expired, refreshToken: 'a'.repeat(128) } });
      expect(err && err.message).toBe('unauthorized');
    });
  });
});
