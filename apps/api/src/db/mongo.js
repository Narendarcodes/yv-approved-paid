const mongoose = require('mongoose');
const config = require('../config');
const logger = require('../utils/logger');

let conn = null;

async function connect() {
  if (conn) return conn;
  const uri = config.mongoUri;
  logger.info({ uri: uri.replace(/:[^:@]+@/, ':****@') }, 'Connecting to MongoDB');
  const opts = { useNewUrlParser: true, useUnifiedTopology: true };
  // Optional: credentials kept out of the URI (e.g. a hosted secret store fills
  // MONGO_PASSWORD alone). When set, they override any user:pass in MONGO_URI.
  if (process.env.MONGO_PASSWORD) {
    opts.auth = { username: process.env.MONGO_USER || '', password: process.env.MONGO_PASSWORD };
  }
  conn = await mongoose.connect(uri, opts);
  logger.info('MongoDB connected');
  return conn;
}

async function disconnect() {
  if (!conn) return;
  await mongoose.disconnect();
  conn = null;
  logger.info('MongoDB disconnected');
}

module.exports = { connect, disconnect };
