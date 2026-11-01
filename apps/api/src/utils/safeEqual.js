const crypto = require('crypto');

/**
 * Constant-time string comparison for secrets. Both sides are SHA-256 hashed
 * first, so neither the content nor the LENGTH of the secret leaks through
 * timing (timingSafeEqual itself needs equal-length inputs).
 * Empty or non-string values never match.
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = { safeEqual };
