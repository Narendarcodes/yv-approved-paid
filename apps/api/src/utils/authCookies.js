/**
 * Session cookies (ADR-0017). Tokens never touch JS-readable storage:
 *   accessToken  httpOnly, path '/', expires with the access JWT
 *   refreshToken httpOnly, path '<apiPrefix>/auth' (sent only to auth routes)
 *   csrfToken    NOT httpOnly (the client must echo it), path '/'
 * All Secure in production and SameSite=strict by default (COOKIE_SAMESITE).
 */
const config = require('../config');

const names = config.cookies.names;
const refreshPath = () => `${config.apiPrefix}/auth`;

function base() {
  const o = { secure: config.cookies.secure, sameSite: config.cookies.sameSite };
  if (config.cookies.domain) o.domain = config.cookies.domain;
  return o;
}

function setAccessCookie(res, accessToken, expiresAt) {
  res.cookie(names.access, accessToken, {
    ...base(),
    httpOnly: true,
    path: '/',
    expires: expiresAt,
  });
}

function setSessionCookies(
  res,
  { accessToken, accessExpiresAt, refreshToken, refreshExpiresAt, csrfToken },
) {
  setAccessCookie(res, accessToken, accessExpiresAt);
  if (refreshToken) {
    res.cookie(names.refresh, refreshToken, {
      ...base(),
      httpOnly: true,
      path: refreshPath(),
      expires: refreshExpiresAt,
    });
  }
  if (csrfToken) {
    res.cookie(names.csrf, csrfToken, {
      ...base(),
      httpOnly: false,
      path: '/',
      expires: refreshExpiresAt,
    });
  }
}

function clearSessionCookies(res) {
  res.clearCookie(names.access, { ...base(), httpOnly: true, path: '/' });
  res.clearCookie(names.refresh, { ...base(), httpOnly: true, path: refreshPath() });
  res.clearCookie(names.csrf, { ...base(), path: '/' });
}

module.exports = { setSessionCookies, setAccessCookie, clearSessionCookies, refreshPath };
