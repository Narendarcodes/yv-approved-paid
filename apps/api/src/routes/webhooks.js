const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const config = require('../config');
const scheduling = require('../services/scheduling.service');
const logger = require('../utils/logger');

const { safeEqual } = require('../utils/safeEqual');

/**
 * Is this request really from our Postiz? Accepted proofs, any one of:
 *  1. X-Postiz-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>
 *  2. X-Postiz-Signature or X-Webhook-Secret: <secret> (shared secret header,
 *     e.g. added by a relay / reverse proxy)
 *  3. the secret as the last path segment: POST /webhooks/postiz/<secret>.
 *     Postiz itself sends NO auth header (its webhook sender posts plain JSON),
 *     so this is how a stock Postiz webhook authenticates: register the URL
 *     https://<api>/api/v1/webhooks/postiz/<POSTIZ_WEBHOOK_SECRET>. The token
 *     is redacted from request logs (app.js).
 */
function verified(req, secret) {
  const sig = req.get('x-postiz-signature');
  if (sig && sig.startsWith('sha256=')) {
    const raw = req.rawBody || Buffer.from('');
    const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    return safeEqual(sig.slice('sha256='.length).toLowerCase(), expected);
  }
  return (
    safeEqual(sig, secret) ||
    safeEqual(req.get('x-webhook-secret'), secret) ||
    safeEqual(req.params.token, secret)
  );
}

let warnedUnconfigured = false;

/**
 * POST /api/v1/webhooks/postiz[/:token] - Postiz calls this when a post
 * publishes (or fails). Idempotent. FAILS CLOSED: with no
 * POSTIZ_WEBHOOK_SECRET configured every call is rejected (503), so an
 * unconfigured deploy cannot be used to mark posts published or failed.
 * The scheduler's reconcile loop still picks up Postiz state by polling.
 */
router.post(['/postiz', '/postiz/:token'], async (req, res, next) => {
  try {
    const secret = config.postiz.webhookSecret;
    if (!secret) {
      if (!warnedUnconfigured) {
        logger.warn(
          'postiz webhook called but POSTIZ_WEBHOOK_SECRET is empty: rejecting (fail closed)',
        );
        warnedUnconfigured = true;
      }
      return res
        .status(503)
        .json({ error: { code: 'webhook_not_configured', message: 'Webhook is not configured' } });
    }
    if (!verified(req, secret)) {
      return res
        .status(401)
        .json({ error: { code: 'invalid_signature', message: 'Invalid webhook signature' } });
    }
    const result = await scheduling.handlePostizWebhook(req.body || {});
    res.json({ data: { ok: true, ...result } });
  } catch (err) {
    logger.error({ err }, 'postiz webhook failed');
    next(err);
  }
});

module.exports = router;
module.exports.safeEqual = safeEqual;
