/**
 * Brute-force limits on the credential endpoints (Phase 1 item 9).
 *
 *   POST /auth/login     per IP (all attempts) + per account (FAILED attempts
 *                        only: a success refunds its hit, so a correct password
 *                        is never blocked by its own earlier successes and an
 *                        attacker cannot burn a user's budget by logging in)
 *   POST /auth/register  per IP + per email
 *   POST /auth/refresh   per IP + per user (resolved from the refresh token)
 *
 * Over the limit -> 429 { error: { code: 'rate_limited', retryAfter } } with a
 * Retry-After header (seconds). Counters live behind the store interface in
 * utils/rateLimitStore.js (in-memory today, Redis-ready). The app-wide
 * per-IP limiter in app.js still applies on top of these.
 *
 * The per-account limit on login is deliberately on FAILED attempts and keyed
 * by email, so password spraying across many IPs is still capped per account;
 * the per-IP limit caps one source trying many accounts.
 */
const config = require('../config');
const { MemoryStore } = require('../utils/rateLimitStore');

const normEmail = (v) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null);
const clientIp = (req) => req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';

/**
 * One limiter. `key(req)` (sync or async) returns the subject (IP, email, user
 * id) or null to skip. With refundOnSuccess, a response < 400 gives the hit back.
 */
function createLimiter({ name, windowMs, max, key, refundOnSuccess = false, store }) {
  return async function rateLimit(req, res, next) {
    try {
      if (!config.authRateLimit.enabled) return next();
      const subject = await key(req);
      if (!subject) return next();
      const k = `${name}:${subject}`;
      const { count, resetAt } = await store.hit(k, windowMs);
      if (count > max) {
        const retryAfter = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({
          error: {
            code: 'rate_limited',
            message: 'Too many attempts, please try again later',
            retryAfter,
          },
        });
      }
      if (refundOnSuccess) {
        res.on('finish', () => {
          if (res.statusCode < 400) Promise.resolve(store.decrement(k)).catch(() => {});
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** The per-route limiter chains, sharing one store. */
function buildAuthLimits({ store = new MemoryStore(), limits = config.authRateLimit } = {}) {
  const l = limits;
  const ip = (req) => clientIp(req);
  const email = (req) => normEmail(req.body && req.body.email);
  const refreshUser = async (req) => {
    // Lazy require: the auth service pulls in models; keep this module light.
    const authService = require('../services/auth.service');
    const token =
      (req.body && req.body.refreshToken) ||
      (req.cookies && req.cookies[config.cookies.names.refresh]);
    const s = token ? await authService.findSession(token) : null;
    return s ? String(s.userId) : null;
  };
  return {
    store,
    loginIp: createLimiter({ name: 'login:ip', ...l.login.ip, key: ip, store }),
    loginAccount: createLimiter({
      name: 'login:acct',
      ...l.login.account,
      key: email,
      refundOnSuccess: true,
      store,
    }),
    registerIp: createLimiter({ name: 'register:ip', ...l.register.ip, key: ip, store }),
    registerAccount: createLimiter({
      name: 'register:acct',
      ...l.register.account,
      key: email,
      store,
    }),
    refreshIp: createLimiter({ name: 'refresh:ip', ...l.refresh.ip, key: ip, store }),
    refreshAccount: createLimiter({
      name: 'refresh:acct',
      ...l.refresh.account,
      key: refreshUser,
      store,
    }),
  };
}

module.exports = { createLimiter, buildAuthLimits, normEmail };
