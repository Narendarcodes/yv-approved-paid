const bcrypt = require('bcryptjs');
const User = require('../models/user.model');
const RefreshToken = require('../models/refreshToken.model');
const config = require('../config');
const {
  generateAccessToken,
  generateRefreshToken,
  hashToken,
  newSessionId,
  accessTokenExpiry,
} = require('../utils/tokens');

// Two tabs refreshing at the same moment both present the same token; the one
// that loses the race gets a fresh token in the same family if it arrives
// within this window. Later presentations of a rotated token = reuse = theft.
const ROTATION_GRACE_MS = 30 * 1000;

const refreshExpiry = () =>
  new Date(Date.now() + config.jwt.refreshExpiresDays * 24 * 60 * 60 * 1000);
const familyOf = (rt) => rt.family || String(rt._id); // rows from before families existed

async function register({ name, email, password }) {
  const existing = await User.findOne({ email });
  if (existing) throw { status: 409, code: 'user_exists', message: 'User already exists' };
  const salt = bcrypt.genSaltSync(10);
  const passwordHash = bcrypt.hashSync(password, salt);
  const user = new User({ name, email, passwordHash });
  await user.save();
  return user;
}

async function issue(userId, sessionId, extraClaims = {}) {
  const raw = generateRefreshToken();
  const expiresAt = refreshExpiry();
  await RefreshToken.create({ userId, tokenHash: hashToken(raw), family: sessionId, expiresAt });
  const accessToken = generateAccessToken({ sub: userId, sid: sessionId, ...extraClaims });
  return {
    accessToken,
    accessExpiresAt: accessTokenExpiry(accessToken),
    refreshToken: raw,
    refreshExpiresAt: expiresAt,
    sessionId,
  };
}

/** Password login: a new session (refresh family). */
async function authenticate({ email, password }) {
  const user = await User.findOne({ email });
  if (!user) throw { status: 401, code: 'invalid_credentials', message: 'Invalid credentials' };
  if (user.disabled) throw { status: 403, code: 'user_disabled', message: 'User disabled' };
  const ok = bcrypt.compareSync(password, user.passwordHash);
  if (!ok) throw { status: 401, code: 'invalid_credentials', message: 'Invalid credentials' };
  return { user, ...(await issue(user._id, newSessionId(), { email: user.email })) };
}

/** The live session a refresh token belongs to (for CSRF binding), or null. */
async function findSession(rawToken) {
  if (!rawToken) return null;
  const rt = await RefreshToken.findOne({ tokenHash: hashToken(rawToken) }).lean();
  return rt ? { sessionId: familyOf(rt), userId: rt.userId } : null;
}

/** Revoke the whole session the token belongs to (logout). */
async function revokeRefreshToken(rawToken) {
  const rt = await RefreshToken.findOne({ tokenHash: hashToken(rawToken) });
  if (!rt) return false;
  await RefreshToken.updateMany(
    { $or: [{ family: familyOf(rt) }, { _id: rt._id }] },
    { $set: { revoked: true } },
  );
  return true;
}

/**
 * Rotate: revoke the presented token, issue the next one in its family.
 * Reuse of a rotated token (outside the race window) revokes the family.
 */
async function rotateRefreshToken(oldToken) {
  const rt = await RefreshToken.findOne({ tokenHash: hashToken(oldToken) });
  if (!rt) throw { status: 401, code: 'invalid_refresh', message: 'Invalid refresh token' };
  if (rt.expiresAt < new Date())
    throw { status: 401, code: 'expired_refresh', message: 'Refresh token expired' };
  const family = familyOf(rt);
  if (rt.revoked) {
    const racing =
      rt.replacedByToken && rt.rotatedAt && Date.now() - rt.rotatedAt.getTime() < ROTATION_GRACE_MS;
    const familyAlive =
      racing &&
      (await RefreshToken.exists({ family, revoked: false, expiresAt: { $gt: new Date() } }));
    if (!familyAlive) {
      await RefreshToken.updateMany(
        { $or: [{ family }, { _id: rt._id }] },
        { $set: { revoked: true } },
      );
      throw {
        status: 401,
        code: 'refresh_reused',
        message: 'Refresh token already used; session revoked',
      };
    }
    const next = await issue(rt.userId, family);
    return { ...next, newRefresh: next.refreshToken, userId: rt.userId };
  }
  const next = await issue(rt.userId, family);
  rt.revoked = true;
  rt.rotatedAt = new Date();
  rt.replacedByToken = hashToken(next.refreshToken);
  if (!rt.family) rt.family = family;
  await rt.save();
  return { ...next, newRefresh: next.refreshToken, userId: rt.userId };
}

module.exports = {
  register,
  authenticate,
  findSession,
  revokeRefreshToken,
  rotateRefreshToken,
  ROTATION_GRACE_MS,
};
