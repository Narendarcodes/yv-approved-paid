const dotenv = require('dotenv');
dotenv.config();
// PAYPAL_CREDENTIALS=id:secret -> PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (before any gateway is built)
require('./config/paypal-credentials').applyPaypalCredentials(process.env);

const { connect } = require('./db/mongo');
const app = require('./app');
const logger = require('./utils/logger');
const config = require('./config');
const { createInternalApp } = require('./internal-app');

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await connect();
    const server = app.listen(PORT, process.env.HOST || undefined, () => {
      logger.info({ port: PORT }, 'Server started');
    });

    // Private /internal API for the agent + worker: separate listener, private
    // address (INTERNAL_HOST, loopback by default), never the public port.
    const internalServer = createInternalApp().listen(
      config.internal.port,
      config.internal.host,
      () => {
        logger.info(
          { port: config.internal.port, host: config.internal.host },
          'Internal API started',
        );
      },
    );
    const closeAll = (cb) => internalServer.close(() => server.close(cb));

    // Real-time layer (team chat) rides on the same HTTP server.
    const { initSocketServer } = require('./realtime/socket');
    initSocketServer(server);

    // Social publishing scheduler (local fallback + Postiz polling).
    require('./services/scheduler').start();

    // Money Agent: keeps holds alive, auto-approves lapsed reviews, captures, pays out.
    require('./modules/deals/service.cts').startMoneyAgent(logger);

    // Agent tick (every 4 min): counts Render hours, keeps the Render agent warm while
    // under RENDER_HOURS_SWITCH, then routes agent calls to AGENT_FALLBACK_URL.
    require('./agent/routing').startAgentTick(logger);

    // Judge demo: DEMO_MODE=1 rebuilds Lumen Coffee's "Autumn launch reels" in this process, so the
    // gateway holding its authorizations is the one the Money Agent uses. Works on
    // PAYPAL_MODE=mock and on PAYPAL_MODE=sandbox (real sandbox orders and invoices;
    // the buyer's approval is simulated and labelled so).
    if (process.env.DEMO_MODE === '1') {
      if (!['mock', 'sandbox'].includes(process.env.PAYPAL_MODE || 'mock')) {
        logger.warn(
          'DEMO_MODE=1 ignored for seeding: the deal demo needs PAYPAL_MODE=mock or sandbox',
        );
      } else {
        require('./modules/deals/demo.cts')
          .seedDealDemo({ judgePassword: process.env.DEMO_JUDGE_PASSWORD })
          .then((r) =>
            logger.info(
              { dealId: r.dealId, orgId: r.orgId, paypal: process.env.PAYPAL_MODE || 'mock' },
              'deal demo seeded (POST /auth/demo-login is open)',
            ),
          )
          .catch((err) => logger.error({ err: err && err.message }, 'deal demo seed failed'));
      }
    }

    process.on('SIGINT', async () => {
      logger.info('SIGINT received, shutting down');
      require('./services/scheduler').stop();
      closeAll(async () => {
        await require('./db/mongo').disconnect();
        process.exit(0);
      });
    });

    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received, shutting down');
      require('./services/scheduler').stop();
      closeAll(async () => {
        await require('./db/mongo').disconnect();
        process.exit(0);
      });
    });
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
}

if (require.main === module) {
  start();
}

module.exports = { start };
