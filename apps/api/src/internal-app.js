/**
 * Private service API for the Python agent + worker (/internal/*), on its OWN
 * Express app and listener (server.js: INTERNAL_PORT, bound to INTERNAL_HOST,
 * 127.0.0.1 by default). It is never mounted on the public app.
 *
 * Two independent gates, both required:
 *   1. X-Internal-Token: the shared INTERNAL_API_TOKEN (constant-time compare)
 *      - proves the caller is one of our services on the private network;
 *   2. Authorization: Bearer <service JWT> minted by Node per chat call / job,
 *      scoped to one org + scopes (routes/internal.js, middleware/serviceAuth).
 */
const express = require('express');
const helmet = require('helmet');
const config = require('./config');
const errors = require('./middleware/errors');
const { safeEqual } = require('./utils/safeEqual');

function requireInternalToken(req, res, next) {
  const expected = config.internal.token;
  if (!expected) {
    return res
      .status(503)
      .json({
        error: { code: 'internal_not_configured', message: 'INTERNAL_API_TOKEN is not set' },
      });
  }
  if (!safeEqual(req.get('x-internal-token'), expected)) {
    return res
      .status(401)
      .json({
        error: { code: 'invalid_internal_token', message: 'Missing or invalid internal token' },
      });
  }
  next();
}

function createInternalApp() {
  const app = express();
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '5mb' }));
  app.use('/internal', requireInternalToken, require('./routes/internal'));
  app.use((req, res) =>
    res.status(404).json({ error: { code: 'not_found', message: 'Not found' } }),
  );
  app.use(errors.handleError);
  return app;
}

module.exports = { createInternalApp, requireInternalToken };
