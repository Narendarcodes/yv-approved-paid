const { MongoMemoryServer } = require('mongodb-memory-server');

module.exports = async () => {
  // Running under Jest. Force NODE_ENV=test so the app behaves as a test
  // environment (e.g. no morgan logging, test config) regardless of the
  // shell's NODE_ENV, which Jest preserves when already defined.
  if (process.env.JEST_WORKER_ID !== undefined) {
    process.env.NODE_ENV = 'test';
    // wiredTiger works on every MongoDB version; ephemeralForTest was removed
    // in MongoDB 7, so a system/newer binary would fail to start without this.
    const mongod = await MongoMemoryServer.create({
      instance: { storageEngine: 'wiredTiger' },
    });
    process.env.MONGO_URI = mongod.getUri();
    // make mongod instance available for teardown if needed
    global.__MONGOD__ = mongod;
  }
};
