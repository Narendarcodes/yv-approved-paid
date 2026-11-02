/**
 * Fail-fast configuration checks (Phase 1 item 10). Pure function of an env
 * object so it can be unit-tested; config/index.js calls it at load time and
 * throws ONE error listing every problem, so a bad deploy fails on boot with
 * the whole list instead of one variable per restart.
 *
 * Production requirements:
 *   JWT_ACCESS_SECRET     >= 32 chars, not a known default
 *   CSRF_SECRET           >= 32 chars (cookie-auth CSRF tokens, ADR-0017)
 *   CORS_ORIGIN           explicit comma-separated https origins, no '*'
 *   MONGO_URI             set
 *   SERVICE_JWT_SECRET +  >= 32 chars each, only when the agent platform is
 *   INTERNAL_API_TOKEN    enabled (AGENT_ENABLED != 'false')
 *   AGENT_SHARED_SECRET   >= 32 chars when set (live deal copilot, Node -> agent)
 *   POSTIZ_WEBHOOK_SECRET >= 32 chars when POSTIZ_API_URL is set
 */
const DEFAULT_SECRETS = [
  'dev_access_secret',
  'change-me',
  'changeme',
  'secret',
  'dev_service_secret',
];
const MIN_SECRET = 32;

function parseOrigins(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function isOrigin(o) {
  try {
    const u = new URL(o);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === o;
  } catch {
    return false;
  }
}

function strongSecret(errors, env, name) {
  const v = env[name];
  if (!v) errors.push(`${name} is required in production`);
  else if (DEFAULT_SECRETS.includes(v) || v.length < MIN_SECRET) {
    errors.push(`${name} must be a strong, unique value (>= ${MIN_SECRET} chars, not a default)`);
  }
}

/** @returns {string[]} problems; empty = OK */
function validateEnv(env) {
  const errors = [];
  const nodeEnv = env.NODE_ENV || 'development';
  const origins = parseOrigins(env.CORS_ORIGIN);
  for (const o of origins) {
    if (o === '*')
      errors.push("CORS_ORIGIN must list explicit origins; '*' is not allowed with credentials");
    else if (!isOrigin(o))
      errors.push(`CORS_ORIGIN entry "${o}" is not an origin (scheme://host[:port], no path)`);
  }
  const sameSite = String(env.COOKIE_SAMESITE || 'strict').toLowerCase();
  if (!['strict', 'lax', 'none'].includes(sameSite))
    errors.push('COOKIE_SAMESITE must be strict, lax or none');
  if (sameSite === 'none' && env.COOKIE_SECURE === 'false')
    errors.push('COOKIE_SAMESITE=none requires Secure cookies');
  if (nodeEnv !== 'production') return errors;
  if (env.COOKIE_SECURE === 'false')
    errors.push('COOKIE_SECURE=false is not allowed in production');

  strongSecret(errors, env, 'JWT_ACCESS_SECRET');
  strongSecret(errors, env, 'CSRF_SECRET');
  if (!origins.length)
    errors.push('CORS_ORIGIN is required in production (comma-separated allowed origins)');
  if (!env.MONGO_URI) errors.push('MONGO_URI is required in production');
  if (env.AGENT_ENABLED !== 'false') {
    strongSecret(errors, env, 'SERVICE_JWT_SECRET');
    strongSecret(errors, env, 'INTERNAL_API_TOKEN');
  }
  if (env.AGENT_SHARED_SECRET) strongSecret(errors, env, 'AGENT_SHARED_SECRET');
  if (env.POSTIZ_API_URL) strongSecret(errors, env, 'POSTIZ_WEBHOOK_SECRET');
  for (const [name, v] of [
    ['PORT', env.PORT],
    ['INTERNAL_PORT', env.INTERNAL_PORT],
  ]) {
    if (v !== undefined && v !== '' && !/^\d+$/.test(String(v)))
      errors.push(`${name} must be a port number`);
  }
  if (String(env.PORT || '3000') === String(env.INTERNAL_PORT || '3001')) {
    errors.push(
      'INTERNAL_PORT must differ from PORT (the internal API is never on the public listener)',
    );
  }
  return errors;
}

module.exports = { validateEnv, parseOrigins, DEFAULT_SECRETS, MIN_SECRET };
