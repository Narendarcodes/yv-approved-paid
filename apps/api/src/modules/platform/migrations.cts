/**
 * platform/migrations: run apps/api/migrations against a live db (native
 * driver handle, e.g. mongoose.connection.db).
 *   up(db, { log })         apply pending, in order (idempotent)
 *   down(db, { steps })     revert the newest N
 *   status(db)              [{ id, applied, appliedAt }]
 * CLI: npm run migrate:up | migrate:down | migrate:status (scripts/migrate.js).
 */
const runner = require('./lib/runner.cts');

module.exports = { up: runner.up, down: runner.down, status: runner.status };
