const { verifyServiceToken } = require('../agent/serviceToken');

/** Authenticate a service JWT and require every listed scope. Sets req.svc = { orgId, userId, scopes }. */
function requireService(...scopes) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    const claims = token && verifyServiceToken(token);
    if (!claims) return res.status(401).json({ error: { code: 'invalid_service_token', message: 'Missing or invalid service token' } });
    const missing = scopes.filter((s) => !(claims.scopes || []).includes(s));
    if (missing.length) return res.status(403).json({ error: { code: 'insufficient_scope', message: `Missing scope(s): ${missing.join(',')}` } });
    req.svc = { orgId: claims.orgId, userId: claims.userId, scopes: claims.scopes, jti: claims.jti };
    next();
  };
}

module.exports = { requireService };
