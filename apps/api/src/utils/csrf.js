/**
 * CSRF protection for cookie-authenticated requests (ADR-0017).
 *
 * Signed double-submit: the token is `<nonce>.<HMAC(CSRF_SECRET, sid.nonce)>`.
 * The server sets it in the readable `csrfToken` cookie (and returns it in the
 * login/refresh body); the web client echoes it in `X-CSRF-Token` on every
 * unsafe request. A request passes only when header == cookie AND the HMAC
 * binds it to the caller's session id (`sid`, the refresh-token family), so a
 * token planted by a sibling subdomain or copied from another session fails.
 * Bearer-token (non-browser) requests are not cookie-authenticated and skip it.
 */
const crypto = require('crypto');
const config = require('../config');
const { safeEqual } = require('./safeEqual');

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function mac(sid, nonce) {
  return crypto
    .createHmac('sha256', config.csrf.secret)
    .update(`${sid}.${nonce}`)
    .digest('base64url');
}

function issueCsrfToken(sid) {
  const nonce = crypto.randomBytes(18).toString('base64url');
  return `${nonce}.${mac(String(sid), nonce)}`;
}

function isValidCsrfToken(token, sid) {
  if (typeof token !== 'string' || !sid || !config.csrf.secret) return false;
  const [nonce, sig, extra] = token.split('.');
  if (!nonce || !sig || extra !== undefined) return false;
  return safeEqual(sig, mac(String(sid), nonce));
}

/** Header equals cookie, and both are a valid token for this session id. */
function checkDoubleSubmit(req, sid) {
  const header = req.get('x-csrf-token');
  const cookie = req.cookies && req.cookies[config.cookies.names.csrf];
  return safeEqual(header, cookie) && isValidCsrfToken(header, sid);
}

module.exports = { UNSAFE, issueCsrfToken, isValidCsrfToken, checkDoubleSubmit };
