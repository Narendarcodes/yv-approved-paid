// Loaded via `setupFilesAfterEnv`, which only *requires* this module — an
// exported function is never invoked. Register the cleanup with Jest's
// afterAll so each test file stops the MongoMemoryServer that setup.js
// started for it (otherwise every suite leaks a mongod and Jest never exits).
afterAll(async () => {
  if (global.__MONGOD__) {
    try {
      await global.__MONGOD__.stop();
    } catch (e) {
      // ignore
    }
    global.__MONGOD__ = undefined;
  }
});
