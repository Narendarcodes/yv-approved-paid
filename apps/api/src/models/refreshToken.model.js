const mongoose = require('mongoose');

/**
 * One row per issued refresh token (stored hashed). Tokens of one login form a
 * FAMILY (the session id, `sid` in access tokens and CSRF tokens): every
 * refresh revokes the presented token and issues the next one in the family.
 * Presenting an already-rotated token outside the short race window is treated
 * as theft and revokes the whole family (auth.service.rotateRefreshToken).
 */
const RefreshTokenSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User', index: true },
    tokenHash: { type: String, required: true },
    family: { type: String, default: null },
    expiresAt: { type: Date, required: true },
    revoked: { type: Boolean, default: false },
    replacedByToken: { type: String, default: null },
    rotatedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Lookup on every refresh (was a collection scan) and no duplicates.
RefreshTokenSchema.index({ tokenHash: 1 }, { unique: true });
// Expired rows are deleted by MongoDB (TTL monitor) instead of growing forever.
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Revoke a whole session (logout, reuse detection).
RefreshTokenSchema.index({ family: 1 });

const RefreshToken = mongoose.model('RefreshToken', RefreshTokenSchema);
module.exports = RefreshToken;
