const authService = require('../services/auth.service');
const config = require('../config');
const { issueCsrfToken, isValidCsrfToken, checkDoubleSubmit } = require('../utils/csrf');
const { setSessionCookies, clearSessionCookies } = require('../utils/authCookies');

/*
 * Browser sessions are cookie-only (ADR-0017): login/refresh set httpOnly
 * accessToken + refreshToken cookies and a readable csrfToken cookie.
 * Non-browser clients (scripts, e2e, tests) may still use Bearer access tokens;
 * they get the refresh token in the body only when they ask for it
 * (tokenTransport: 'body') and then refresh/logout with it in the body.
 */

/** Keep a still-valid CSRF token across refreshes so in-flight requests don't fail. */
function csrfFor(req, sessionId) {
  const current = req.cookies && req.cookies[config.cookies.names.csrf];
  return isValidCsrfToken(current, sessionId) ? current : issueCsrfToken(sessionId);
}

function csrfFailed(res) {
  return res
    .status(403)
    .json({ error: { code: 'csrf_failed', message: 'Missing or invalid CSRF token' } });
}

async function register(req, res, next) {
  try {
    const { name, email, password } = req.body;
    const user = await authService.register({ name, email, password });
    res.status(201).json({ data: user });
  } catch (err) {
    next(err);
  }
}

/** Set the session cookies and answer like /auth/login does (shared with demo-login). */
async function sendSession(res, session, tokenTransport, extra = {}) {
  // Include the primary org role so the client can render role-based UX
  // straight from the login response.
  const Membership = require('../models/membership.model');
  const membership = await Membership.findOne({
    userId: session.user._id,
    disabled: { $ne: true },
  }).sort({
    createdAt: 1,
  });
  const u = session.user.toJSON();
  u.role = membership ? membership.role : 'member';
  const csrfToken = issueCsrfToken(session.sessionId);
  setSessionCookies(res, { ...session, csrfToken });
  const data = {
    user: u,
    accessToken: session.accessToken,
    accessTokenExpiresAt: session.accessExpiresAt,
    csrfToken,
    ...extra,
  };
  // The long-lived refresh token stays out of JS unless a non-browser client asks.
  if (tokenTransport === 'body') data.refreshToken = session.refreshToken;
  res.json({ data });
}

async function login(req, res, next) {
  try {
    const { email, password, tokenTransport } = req.body;
    const session = await authService.authenticate({ email, password });
    await sendSession(res, session, tokenTransport);
  } catch (err) {
    next(err);
  }
}

/** DEMO_MODE=1 only (the route 404s otherwise): one tap signs in as the seeded demo judge. */
function demoEnabled() {
  return process.env.DEMO_MODE === '1';
}
function demoGate(req, res, next) {
  if (!demoEnabled())
    return res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
  next();
}
async function demoLogin(req, res, next) {
  try {
    const { DEMO, demoJudge } = require('../modules/deals/demo.cts');
    const judge = await demoJudge();
    if (!judge)
      return res.status(503).json({
        error: {
          code: 'demo_not_seeded',
          message:
            'The demo is not seeded yet (npm run seed:deals, or restart the API with DEMO_MODE=1)',
        },
      });
    const session = await authService.startSession(judge);
    const Membership = require('../models/membership.model');
    const m = await Membership.findOne({ userId: judge._id, disabled: { $ne: true } })
      .sort({ createdAt: 1 })
      .lean();
    await sendSession(res, session, undefined, {
      demo: { dealId: DEMO.dealId, organizationId: m ? String(m.organizationId) : null },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /auth/refresh. Cookie mode (browser): refresh token from the httpOnly
 * cookie, X-CSRF-Token required, new cookies set, no tokens in the body.
 * Body mode (API clients): { refreshToken } in, { accessToken, refreshToken } out.
 */
async function refresh(req, res, next) {
  try {
    const fromBody = req.body && req.body.refreshToken;
    const token = fromBody || (req.cookies && req.cookies[config.cookies.names.refresh]);
    if (!token)
      return res
        .status(401)
        .json({ error: { code: 'invalid_refresh', message: 'No refresh token' } });
    if (!fromBody) {
      const s = await authService.findSession(token);
      if (!s) {
        clearSessionCookies(res);
        return res
          .status(401)
          .json({ error: { code: 'invalid_refresh', message: 'Invalid refresh token' } });
      }
      if (!checkDoubleSubmit(req, s.sessionId)) return csrfFailed(res);
    }
    let next_;
    try {
      next_ = await authService.rotateRefreshToken(token);
    } catch (err) {
      if (!fromBody && err && err.status === 401) clearSessionCookies(res);
      throw err;
    }
    if (fromBody) {
      setSessionCookies(res, { ...next_, refreshToken: null });
      return res.json({ data: { accessToken: next_.accessToken, refreshToken: next_.newRefresh } });
    }
    const csrfToken = csrfFor(req, next_.sessionId);
    setSessionCookies(res, { ...next_, csrfToken });
    res.json({ data: { csrfToken, accessTokenExpiresAt: next_.accessExpiresAt } });
  } catch (err) {
    next(err);
  }
}

/** POST /auth/logout: revoke the whole session; clear cookies. */
async function logout(req, res, next) {
  try {
    const fromBody = req.body && req.body.refreshToken;
    const token = fromBody || (req.cookies && req.cookies[config.cookies.names.refresh]);
    if (token && !fromBody) {
      const s = await authService.findSession(token);
      if (s && !checkDoubleSubmit(req, s.sessionId)) return csrfFailed(res);
    }
    if (token) await authService.revokeRefreshToken(token);
    clearSessionCookies(res);
    res.json({ data: { loggedOut: true } });
  } catch (err) {
    next(err);
  }
}

/** GET /auth/csrf: the CSRF token for the current cookie session (after a reload). */
async function csrf(req, res) {
  const sid = req.auth && req.auth.sid;
  if (!sid)
    return res.status(400).json({ error: { code: 'no_session', message: 'Not a cookie session' } });
  const token = csrfFor(req, sid);
  res.cookie(config.cookies.names.csrf, token, {
    secure: config.cookies.secure,
    sameSite: config.cookies.sameSite,
    path: '/',
    ...(config.cookies.domain ? { domain: config.cookies.domain } : {}),
  });
  res.json({ data: { csrfToken: token } });
}

async function me(req, res, next) {
  try {
    const userService = require('../services/user.service');
    const user = await userService.getMe(req.user._id);
    res.json({ data: user });
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, demoGate, demoLogin, refresh, logout, csrf, me };
