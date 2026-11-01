const dotenv = require('dotenv');
dotenv.config();

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
