const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('../config');

function generateAccessToken(payload) {
  return jwt.sign(payload, config.jwt.accessSecret, { expiresIn: config.jwt.accessExpiresIn });
}

function generateRefreshToken() {
  return crypto.randomBytes(64).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** When an access JWT expires (Date), for the cookie lifetime. */
function accessTokenExpiry(token) {
  const p = jwt.decode(token);
  return new Date(p && p.exp ? p.exp * 1000 : Date.now() + 15 * 60 * 1000);
}

function newSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

function verifyAccessToken(token) {
  try {
    return jwt.verify(token, config.jwt.accessSecret);
  } catch (e) {
    return null;
  }
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  hashToken,
  verifyAccessToken,
  accessTokenExpiry,
  newSessionId,
};
