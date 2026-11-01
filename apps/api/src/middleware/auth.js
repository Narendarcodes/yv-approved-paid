const { verifyAccessToken } = require('../utils/tokens');
const User = require('../models/user.model');
const config = require('../config');
const { UNSAFE, checkDoubleSubmit } = require('../utils/csrf');

/**
 * Who is calling? (ADR-0017)
 *  - Authorization: Bearer <access JWT>   non-browser clients; no CSRF check
 *  - accessToken httpOnly cookie          browsers; unsafe methods must carry a
 *                                         valid X-CSRF-Token (signed double submit)
 * Tokens in the URL (?token=) are NOT accepted anywhere: they leak into logs,
 * history and Referer headers. <video>/<img> send the cookie instead.
 * Sets req.user and req.auth = { via: 'bearer' | 'cookie', sid }.
 */
async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization;
    let token = null;
    let via = null;
    if (header && header.startsWith('Bearer ')) {
      token = header.slice('Bearer '.length);
      via = 'bearer';
    } else if (req.cookies && req.cookies[config.cookies.names.access]) {
      token = req.cookies[config.cookies.names.access];
      via = 'cookie';
    }
    if (!token)
      return res.status(401).json({ error: { code: 'unauthenticated', message: 'Missing token' } });
    const payload = verifyAccessToken(token);
    if (!payload)
      return res.status(401).json({ error: { code: 'invalid_token', message: 'Invalid token' } });
    if (via === 'cookie' && UNSAFE.has(req.method) && !checkDoubleSubmit(req, payload.sid)) {
      return res
        .status(403)
        .json({ error: { code: 'csrf_failed', message: 'Missing or invalid CSRF token' } });
    }
    const user = await User.findById(payload.sub);
    if (!user)
      return res.status(401).json({ error: { code: 'user_not_found', message: 'User not found' } });
    if (user.disabled)
      return res.status(403).json({ error: { code: 'user_disabled', message: 'User disabled' } });
    req.user = user;
    req.auth = { via, sid: payload.sid || null };
    next();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Organization access. All three helpers below are thin shims over the access
// module (modules/access, ADR-0015): the org is derived from the addressed
// record or path and the user's memberships, NEVER from client input.
// Non-members get 404; members lacking the permission get 403.
// New routes should call access.can(permission, { from }) directly.
// ---------------------------------------------------------------------------
const access = require('../modules/access/index.cts');

/** Org from the path param (default :organizationId); membership required. */
function requireOrg(orgParam = 'organizationId') {
  return access.can(null, { from: 'org', param: orgParam });
}

/**
 * Permission check. Reuses req.ctx when an earlier middleware resolved it
 * (requireOrg / can). Otherwise resolves it from the route:
 *   :organizationId in the path  -> that org
 *   :id in the path              -> the project's own org
 *   neither                      -> body/query organizationId, as a selector
 *                                   among the user's own memberships
 */
function requirePermission(permission) {
  return function (req, res, next) {
    if (req.ctx) return access.also(permission)(req, res, next);
    let from = 'select';
    if (req.params.organizationId) from = 'org';
    else if (req.params.id) from = 'project';
    return access.can(permission, { from })(req, res, next);
  };
}

/** Membership in the organization that owns the project at req.params[idParam]. */
function requireProjectMember(idParam = 'id') {
  return access.can(null, { from: 'project', param: idParam });
}

module.exports = { authenticate, requireOrg, requirePermission, requireProjectMember };
