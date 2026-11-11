const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const env = process.env.NODE_ENV || 'development';

const { validateEnv, parseOrigins } = require('./validate');

// Fail fast: every missing/weak production setting in one error (validate.js).
const problems = validateEnv({ ...process.env, NODE_ENV: env });
if (problems.length) {
  throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
}

const accessSecret = process.env.JWT_ACCESS_SECRET || 'dev_access_secret';

// CORS allowlist (credentials: true). Production: CORS_ORIGIN is required
// (validate.js). Dev/test default: the Vite dev server only; never "any origin".
const corsOrigins = parseOrigins(process.env.CORS_ORIGIN);
const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

/** { max, windowMs } from <PREFIX>_MAX / <PREFIX>_WINDOW_MS, with defaults. */
function limit(prefix, max, windowMs) {
  const n = (v, d) =>
    Number.isFinite(parseInt(v, 10)) && parseInt(v, 10) > 0 ? parseInt(v, 10) : d;
  return {
    max: n(process.env[`${prefix}_MAX`], max),
    windowMs: n(process.env[`${prefix}_WINDOW_MS`], windowMs),
  };
}

function parseTrustProxy(v) {
  if (v === undefined || v === '' || v === 'false') return false;
  if (v === 'true') return true;
  return /^\d+$/.test(v) ? parseInt(v, 10) : v;
}

module.exports = {
  env,
  port: process.env.PORT || 3000,
  apiPrefix: process.env.API_PREFIX || '/api/v1',
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/cop',
  logLevel: process.env.LOG_LEVEL || 'info',
  corsOrigin: corsOrigins.length ? corsOrigins : DEV_ORIGINS,
  // Express 'trust proxy' (rate limits + Secure cookies behind a reverse proxy).
  // e.g. TRUST_PROXY=1 (one hop: Caddy/nginx) or 'loopback'. Unset = not trusted.
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  jwt: {
    accessSecret,
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshExpiresDays: parseInt(process.env.JWT_REFRESH_EXPIRES_DAYS || '7', 10),
  },
  // Cookie auth (ADR-0017). Browsers hold the session ONLY in cookies:
  //   accessToken  httpOnly, path /, lifetime = the access JWT (15 min)
  //   refreshToken httpOnly, path <apiPrefix>/auth, rotated on every use
  //   csrfToken    readable by JS, sent back in X-CSRF-Token (double submit,
  //                HMAC-bound to the session id)
  cookies: {
    secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : env === 'production',
    sameSite: (process.env.COOKIE_SAMESITE || 'strict').toLowerCase(),
    domain: process.env.COOKIE_DOMAIN || undefined,
    names: { access: 'accessToken', refresh: 'refreshToken', csrf: 'csrfToken' },
  },
  csrf: {
    secret:
      process.env.CSRF_SECRET || (env === 'production' ? '' : 'dev_csrf_secret_dev_csrf_secret_00'),
  },
  storage: {
    driver: process.env.STORAGE_DRIVER || 'local',
    localDir: process.env.STORAGE_LOCAL_DIR || path.resolve(process.cwd(), 'uploads'),
  },
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 min
    max: parseInt(process.env.RATE_LIMIT_MAX || '1000', 10),
  },
  // Credential-endpoint limits (Phase 1 item 9, middleware/authRateLimit.js).
  // Fixed windows; per IP + per account. 429 + Retry-After when exceeded.
  authRateLimit: {
    enabled: process.env.AUTH_RATE_LIMIT_ENABLED !== 'false',
    login: {
      ip: limit('AUTH_LOGIN_IP', 30, 15 * 60 * 1000),
      // failed attempts only (a successful login refunds its hit)
      account: limit('AUTH_LOGIN_ACCOUNT', 10, 15 * 60 * 1000),
    },
    register: {
      ip: limit('AUTH_REGISTER_IP', 10, 60 * 60 * 1000),
      account: limit('AUTH_REGISTER_ACCOUNT', 5, 60 * 60 * 1000),
    },
    refresh: {
      ip: limit('AUTH_REFRESH_IP', 120, 15 * 60 * 1000),
      account: limit('AUTH_REFRESH_ACCOUNT', 60, 15 * 60 * 1000),
    },
    // POST /auth/demo-login (only live with DEMO_MODE=1): per IP
    demo: {
      ip: limit('AUTH_DEMO_IP', 20, 15 * 60 * 1000),
    },
  },
  // Social publishing (PRD §17). Postiz is an external capability behind the
  // scheduling adapter; with no POSTIZ_API_URL/POSTIZ_API_KEY the built-in
  // local scheduler runs instead (demo channels, simulated publish).
  postiz: {
    apiUrl: process.env.POSTIZ_API_URL || '',
    apiKey: process.env.POSTIZ_API_KEY || '',
    webhookSecret: process.env.POSTIZ_WEBHOOK_SECRET || '',
    // full reconcile against GET /posts + channel health, at most this often (ms)
    reconcileMs: parseInt(process.env.POSTIZ_RECONCILE_MS || '300000', 10),
    // a Postiz post still queued this long after its time is marked failed (min)
    confirmTimeoutMin: parseInt(process.env.POSTIZ_CONFIRM_TIMEOUT_MIN || '30', 10),
  },
  // Team timezone for "best time" suggestions and the posting-time heatmap.
  timezone: process.env.TEAM_TIMEZONE || 'Asia/Kolkata',
  analytics: {
    // performance ingestion cadence: hourly for the first 48h after publish, then daily
    intervalMs: parseInt(process.env.ANALYTICS_INTERVAL_MS || '300000', 10),
  },
  // Python agent platform (see /ARCHITECTURE.md). Node is the system of record:
  // the agent + worker only read/write through /internal/* with a service JWT.
  agent: {
    // In production the agent platform stays OFF (routes answer 503) until SERVICE_JWT_SECRET is set.
    enabled:
      process.env.AGENT_ENABLED !== 'false' &&
      (env !== 'production' || !!process.env.SERVICE_JWT_SECRET),
    url: process.env.AGENT_URL || 'http://127.0.0.1:8100',
    // Fallback agent (Azure VM). Unset -> no failover (src/agent/routing.js).
    fallbackUrl: process.env.AGENT_FALLBACK_URL || '',
    // HS256 secret Node signs service tokens with. The agent never holds it:
    // it only forwards the tokens Node minted (per chat call / per job).
    serviceJwtSecret:
      process.env.SERVICE_JWT_SECRET || (env === 'production' ? '' : 'dev_service_secret'),
    chatTokenTtlSec: parseInt(process.env.SERVICE_JWT_CHAT_TTL_SEC || '120', 10),
    jobTokenTtlSec: parseInt(process.env.SERVICE_JWT_JOB_TTL_SEC || '900', 10),
    redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    jobsStream: process.env.JOBS_STREAM || 'yv:jobs',
    deadLetterStream: process.env.JOBS_DLQ_STREAM || 'yv:jobs:dead',
    chatTimeoutMs: parseInt(process.env.AGENT_CHAT_TIMEOUT_MS || '120000', 10),
    // No SSE headers from the agent within this -> 504 "waking up" (the agent sends meta at once).
    chatFirstByteMs: parseInt(process.env.AGENT_CHAT_FIRST_BYTE_MS || '30000', 10),
    // Live deal copilot (modules/deals/copilot.cts): Node -> lean deal agent, server to
    // server, with this shared secret in X-Agent-Secret (same value on the agent).
    // Unset -> the copilot answers { source: 'offline' } and the web replays offline.
    sharedSecret: process.env.AGENT_SHARED_SECRET || '',
    // Render free instances cold-start slowly; past this the web falls back to the replay.
    copilotTimeoutMs: parseInt(process.env.AGENT_COPILOT_TIMEOUT_MS || '15000', 10),
  },
  // Private listener for /internal (agent + worker only). Bound to loopback by
  // default; in docker-compose it binds to the api's address on the private
  // 'backend' network and the port is never published.
  internal: {
    port: parseInt(process.env.INTERNAL_PORT || '3001', 10),
    host: process.env.INTERNAL_HOST || '127.0.0.1',
    // Shared token the agent/worker send in X-Internal-Token (on top of the
    // per-call service JWT). Required in production when the agent is enabled.
    token: process.env.INTERNAL_API_TOKEN || (env === 'production' ? '' : 'dev_internal_token'),
  },
  scheduler: {
    // how often due posts are published / Postiz state is polled (ms); 0 disables the loop
    intervalMs: parseInt(process.env.SCHEDULER_INTERVAL_MS || '15000', 10),
  },
};
