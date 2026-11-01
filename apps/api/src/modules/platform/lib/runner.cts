/**
 * Minimal, dependency-free MongoDB migration runner (up/down/status).
 *
 * - Migrations are files in apps/api/migrations named NNNN-description.js
 *   exporting { up({ db, log }), down({ db, log }) }. They are applied in
 *   filename order and recorded in the `_migrations` collection, so running
 *   `up` twice is a no-op; each migration must ALSO be idempotent on its own
 *   (a crash halfway through is re-run from the start).
 * - A lock document in `_migrations_lock` keeps two deploys from migrating at
 *   once; a lock older than LOCK_TTL_MS is considered stale and taken over.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

type Db = any;
type Log = (msg: string) => void;
export type Migration = {
  id: string;
  up: (ctx: { db: Db; log: Log }) => Promise<void>;
  down: (ctx: { db: Db; log: Log }) => Promise<void>;
};
export type Status = { id: string; applied: boolean; appliedAt: Date | null };

const LOCK_TTL_MS = 10 * 60 * 1000;
const DEFAULT_DIR = path.resolve(__dirname, '../../../../migrations');

function load(dir: string): Migration[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f: string) => /^\d{4}-[\w-]+\.(c?js|cts)$/.test(f))
    .sort()
    .map((f: string) => {
      const mod = require(path.join(dir, f));
      if (typeof mod.up !== 'function' || typeof mod.down !== 'function') {
        throw new Error(`migration ${f} must export up() and down()`);
      }
      return { id: f.replace(/\.(c?js|cts)$/, ''), up: mod.up, down: mod.down };
    });
}

async function withLock<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  const locks = db.collection('_migrations_lock');
  const owner = `${os.hostname()}:${process.pid}:${Date.now()}`;
  await locks.deleteOne({ _id: 'lock', lockedAt: { $lt: new Date(Date.now() - LOCK_TTL_MS) } });
  try {
    await locks.insertOne({ _id: 'lock', owner, lockedAt: new Date() });
  } catch (err: any) {
    if (err && err.code === 11000)
      throw new Error('migrations are locked by another process (stale after 10 min)');
    throw err;
  }
  try {
    return await fn();
  } finally {
    await locks.deleteOne({ _id: 'lock', owner });
  }
}

async function status(db: Db, dir = DEFAULT_DIR): Promise<Status[]> {
  const applied = await db.collection('_migrations').find({}).toArray();
  const byId = new Map(applied.map((a: any) => [a._id, a.appliedAt]));
  return load(dir).map((m) => ({
    id: m.id,
    applied: byId.has(m.id),
    appliedAt: (byId.get(m.id) as Date) || null,
  }));
}

/** Apply every pending migration in order. Returns the ids applied. */
async function up(db: Db, { dir = DEFAULT_DIR, log = (() => {}) as Log } = {}): Promise<string[]> {
  return withLock(db, async () => {
    const done = new Set(
      (await db.collection('_migrations').find({}).toArray()).map((a: any) => a._id),
    );
    const ran: string[] = [];
    for (const m of load(dir)) {
      if (done.has(m.id)) continue;
      const t0 = Date.now();
      log(`up   ${m.id}`);
      await m.up({ db, log });
      await db
        .collection('_migrations')
        .insertOne({ _id: m.id, appliedAt: new Date(), durationMs: Date.now() - t0 });
      ran.push(m.id);
    }
    return ran;
  });
}

/** Revert the last `steps` applied migrations (newest first). Returns the ids reverted. */
async function down(
  db: Db,
  { dir = DEFAULT_DIR, steps = 1, log = (() => {}) as Log } = {},
): Promise<string[]> {
  return withLock(db, async () => {
    const all = load(dir);
    const applied = (await db.collection('_migrations').find({}).toArray())
      .map((a: any) => a._id)
      .sort()
      .reverse();
    const ran: string[] = [];
    for (const id of applied.slice(0, steps)) {
      const m = all.find((x) => x.id === id);
      if (!m) throw new Error(`applied migration ${id} has no file; cannot revert`);
      log(`down ${m.id}`);
      await m.down({ db, log });
      await db.collection('_migrations').deleteOne({ _id: m.id });
      ran.push(m.id);
    }
    return ran;
  });
}

module.exports = { up, down, status, load, DEFAULT_DIR };
