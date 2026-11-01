const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const config = require('./config');
const healthRouter = require('./routes/health');
const authRouter = require('./routes/auth');
const orgRouter = require('./routes/organizations');
const contractsRouter = require('./routes/contracts');
const invoicesRouter = require('./routes/invoices');
const projectsRouter = require('./routes/projects');
const usersRouter = require('./routes/users');
const notificationsRouter = require('./routes/notifications');
const docsRouter = require('./routes/docs');
const schedulingRouter = require('./routes/scheduling');
const webhooksRouter = require('./routes/webhooks');
const errors = require('./middleware/errors');
const listeners = require('./events/listeners');

// wire domain events -> activity/notifications
listeners.setup();

const app = express();

// Behind a reverse proxy (Caddy/nginx), trust its X-Forwarded-* so rate limits
// key on the real client IP and Secure cookies work (config.trustProxy).
app.set('trust proxy', config.trustProxy);

// Secure headers (helmet defaults: HSTS, nosniff, frameguard, referrer-policy,
// no X-Powered-By, COOP, ...). The API serves JSON plus the Swagger page, so
// the CSP is the strict default with images limited to self/data/blob/https.
// CORP same-site: the web app (same site, any port) may embed API media
// (avatars, version files); other sites may not.
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'same-site' },
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'img-src': ["'self'", 'data:', 'blob:', 'https:'],
      },
    },
  }),
);

// CORS: explicit allowlist with credentials (config.corsOrigin: CORS_ORIGIN,
// required in production; dev default = the Vite dev server). Origins not on
// the list get no CORS headers, so the browser blocks the response. Requests
// without an Origin header (same-origin, curl, server-to-server) are unaffected.
const allowedOrigins = new Set(config.corsOrigin);
app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || allowedOrigins.has(origin)),
    credentials: true,
  }),
);
app.use(cookieParser());
// Keep the raw bytes of webhook bodies for HMAC signature checks.
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      if (req.originalUrl.startsWith(`${config.apiPrefix}/webhooks/`))
        req.rawBody = Buffer.from(buf);
    },
  }),
);
// Uploaded files are NOT publicly served (Phase 1 item 7). Avatars:
// GET /users/:id/photo (authenticated, shares-an-org). Version files:
// GET /projects/:id/versions/:versionId/files/:fileId (authenticated, org-checked).

// NOTE: the private /internal API is NOT mounted here. It runs on its own
// listener (internal-app.js, INTERNAL_PORT on INTERNAL_HOST); /internal on the
// public port is a plain 404.

// global rate limiting (per IP)
app.use(
  rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: { code: 'rate_limited', message: 'Too many requests, please try again later' },
    },
  }),
);

if (config.env !== 'test') {
  // Never log webhook path tokens (POST /webhooks/postiz/<secret>).
  morgan.token('safe-url', (req) =>
    (req.originalUrl || req.url).replace(/(\/webhooks\/postiz\/)[^/?#]+/, '$1[redacted]'),
  );
  app.use(
    morgan(
      config.env === 'production'
        ? ':remote-addr - :method :safe-url :status :res[content-length] - :response-time ms'
        : ':method :safe-url :status :response-time ms - :res[content-length]',
    ),
  );
}

app.use(`${config.apiPrefix}/health`, healthRouter);
app.use(`${config.apiPrefix}/auth`, authRouter);
app.use(`${config.apiPrefix}/organizations`, orgRouter);
app.use(`${config.apiPrefix}/organizations/:organizationId/concepts`, require('./routes/concepts'));
app.use(`${config.apiPrefix}/organizations`, contractsRouter);
app.use(`${config.apiPrefix}/organizations`, invoicesRouter);
app.use(`${config.apiPrefix}/organizations`, schedulingRouter);
app.use(`${config.apiPrefix}/organizations`, require('./routes/analytics'));
app.use(`${config.apiPrefix}/organizations`, require('./routes/agent'));
app.use(`${config.apiPrefix}/webhooks`, webhooksRouter);
// Approved = Paid: signed deals, PayPal holds, the Money Agent (modules/deals)
const deals = require('./modules/deals/http.cts');
app.use(`${config.apiPrefix}/webhooks`, deals.webhookRouter);
app.use(`${config.apiPrefix}/organizations/:organizationId/deals`, deals.router);
app.use(`${config.apiPrefix}/projects`, projectsRouter);
app.use(`${config.apiPrefix}/users`, usersRouter);
app.use(`${config.apiPrefix}/notifications`, notificationsRouter);
// API docs (OpenAPI spec + Swagger UI)
app.use(`${config.apiPrefix}/docs`, docsRouter);

// 404
app.use((req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
});

// error handler
app.use(errors.handleError);

module.exports = app;
