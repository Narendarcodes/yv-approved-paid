#!/usr/bin/env node
/**
 * Mongo migrations CLI (apps/api/migrations, runner in src/modules/platform).
 *   node scripts/migrate.js up            apply all pending migrations
 *   node scripts/migrate.js down [steps]  revert the newest N (default 1)
 *   node scripts/migrate.js status
 * Uses MONGO_URI like the API. Safe to run on every deploy: applied
 * migrations are recorded in `_migrations` and a lock prevents concurrent runs.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { connect, disconnect } = require('../src/db/mongo');
const migrations = require('../src/modules/platform/migrations.cts');

async function main() {
  const [cmd = 'status', arg] = process.argv.slice(2);
  await connect();
  const db = mongoose.connection.db;
  const log = (m) => process.stdout.write(`${m}\n`);
  try {
    if (cmd === 'up') {
      const ran = await migrations.up(db, { log });
      log(ran.length ? `applied ${ran.length} migration(s)` : 'nothing to apply');
    } else if (cmd === 'down') {
      const ran = await migrations.down(db, { steps: Math.max(1, parseInt(arg || '1', 10)), log });
      log(ran.length ? `reverted ${ran.join(', ')}` : 'nothing to revert');
    } else if (cmd === 'status') {
      for (const s of await migrations.status(db))
        log(
          `${s.applied ? 'applied ' : 'pending '} ${s.id}${s.appliedAt ? `  (${s.appliedAt.toISOString()})` : ''}`,
        );
    } else {
      throw new Error(`unknown command "${cmd}" (use up | down [steps] | status)`);
    }
  } finally {
    await disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`migrate failed: ${err.message}\n`);
  process.exit(1);
});
