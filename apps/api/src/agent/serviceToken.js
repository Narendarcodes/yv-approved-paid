/**
 * Short-lived service JWTs for Node -> Python agent -> Node internal API.
 * Claims: orgId, userId, scopes (contracts/schemas/ServiceTokenClaims.json).
 * Node mints them after its own permission checks; the agent forwards them
 * unchanged. orgId on every /internal read comes from the token only.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');

const ISS = 'yv-api';
const AUD = 'yv-internal';
const ALL_SCOPES = ['posts:read', 'metrics:read', 'brand:read', 'reviews:read', 'insights:write', 'jobs:write', 'assets:write', 'digests:write'];
const READ_SCOPES = ['posts:read', 'metrics:read', 'brand:read', 'reviews:read'];

function mintServiceToken({ orgId, userId, scopes, ttlSec }) {
  if (!orgId || !userId) throw new Error('orgId and userId are required for a service token');
  if (!config.agent.serviceJwtSecret) throw new Error('SERVICE_JWT_SECRET is not configured');
  const bad = (scopes || []).filter((s) => !ALL_SCOPES.includes(s));
  if (bad.length) throw new Error(`unknown scopes: ${bad.join(',')}`);
  return jwt.sign({ orgId: String(orgId), userId: String(userId), scopes }, config.agent.serviceJwtSecret, {
    algorithm: 'HS256',
    issuer: ISS,
    audience: AUD,
    expiresIn: ttlSec || config.agent.chatTokenTtlSec,
    jwtid: crypto.randomUUID(),
  });
}

function verifyServiceToken(token) {
  if (!config.agent.serviceJwtSecret) return null;
  try {
    return jwt.verify(token, config.agent.serviceJwtSecret, { algorithms: ['HS256'], issuer: ISS, audience: AUD });
  } catch (e) {
    return null;
  }
}

module.exports = { mintServiceToken, verifyServiceToken, ALL_SCOPES, READ_SCOPES, ISS, AUD };
