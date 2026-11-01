/**
 * Migrations runner + 0001 tenant backfill (Phase 1 item 2).
 * Raw documents are inserted with the native driver (no organizationId, the
 * pre-migration shape), then up / up again / down / up are exercised.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const mongoose = require('mongoose');
const migrations = require('../src/modules/platform/migrations.cts');

let db;
const orgA = new mongoose.Types.ObjectId();
const projectA = new mongoose.Types.ObjectId();
const orphanProject = new mongoose.Types.ObjectId();

beforeAll(async () => {
  await require('../src/db/mongo').connect();
  db = mongoose.connection.db;
  await db
    .collection('projects')
    .insertOne({ _id: projectA, organizationId: orgA, title: 'legacy' });
  const legacy = { projectId: projectA, createdAt: new Date() };
  for (const c of [
    'briefs',
    'comments',
    'tasks',
    'inputs',
    'revisionrequests',
    'projectversions',
    'channels',
    'chatmessages',
    'activityevents',
  ]) {
    await db.collection(c).insertMany([{ ...legacy }, { ...legacy }]);
  }
  await db.collection('comments').insertOne({ projectId: orphanProject, body: 'orphan' });
  await db
    .collection('publications')
    .insertOne({ projectId: projectA, organizationId: null, platform: 'x' });
});

afterAll(async () => {
  await mongoose.disconnect();
});

const unscoped = (c) =>
  db
    .collection(c)
    .countDocuments({ $or: [{ organizationId: { $exists: false } }, { organizationId: null }] });

test('status lists 0001 as pending before the first run', async () => {
  const s = await migrations.status(db);
  expect(s.find((m) => m.id === '0001-tenant-organization-id')).toMatchObject({ applied: false });
});

test('up backfills organizationId from the parent project and creates org-first indexes', async () => {
  const logs = [];
  const ran = await migrations.up(db, { log: (m) => logs.push(m) });
  expect(ran).toContain('0001-tenant-organization-id');
  for (const c of [
    'briefs',
    'tasks',
    'inputs',
    'revisionrequests',
    'projectversions',
    'channels',
    'chatmessages',
    'activityevents',
    'publications',
  ]) {
    expect([c, await unscoped(c)]).toEqual([c, 0]);
    const doc = await db.collection(c).findOne({ projectId: projectA });
    expect(String(doc.organizationId)).toBe(String(orgA));
  }
  // the orphan comment (its project is gone) is reported and left alone
  expect(await unscoped('comments')).toBe(1);
  expect(logs.join('\n')).toMatch(/comments: 1 row/);
  const idx = await db.collection('activityevents').indexes();
  expect(idx.map((i) => i.name)).toEqual(
    expect.arrayContaining([
      'organizationId_1_createdAt_-1',
      'organizationId_1_projectId_1_createdAt_-1',
    ]),
  );
});

test('up again is a no-op (recorded in _migrations)', async () => {
  expect(await migrations.up(db)).toEqual([]);
  const s = await migrations.status(db);
  expect(s.find((m) => m.id === '0001-tenant-organization-id')).toMatchObject({ applied: true });
});

test('down reverts (indexes dropped, field unset) and up re-applies cleanly', async () => {
  // newest first: 0003, 0002, then 0001
  const reverted = await migrations.down(db, { steps: 99 });
  expect(reverted[reverted.length - 1]).toBe('0001-tenant-organization-id');
  expect(await unscoped('tasks')).toBe(2);
  const idx = await db.collection('tasks').indexes();
  expect(idx.map((i) => i.name)).not.toContain('organizationId_1_projectId_1_status_1_createdAt_1');
  await migrations.up(db);
  expect(await unscoped('tasks')).toBe(0);
});

test('a held lock blocks a concurrent run; a stale lock is taken over', async () => {
  await db
    .collection('_migrations_lock')
    .insertOne({ _id: 'lock', owner: 'other', lockedAt: new Date() });
  await expect(migrations.up(db)).rejects.toThrow(/locked/);
  await db
    .collection('_migrations_lock')
    .updateOne({ _id: 'lock' }, { $set: { lockedAt: new Date(Date.now() - 60 * 60 * 1000) } });
  await expect(migrations.up(db)).resolves.toEqual([]);
  expect(await db.collection('_migrations_lock').countDocuments()).toBe(0);
});

test('0003: legacy refresh tokens get a family; tokenHash unique + expiresAt TTL indexes', async () => {
  const id = new mongoose.Types.ObjectId();
  await db
    .collection('refreshtokens')
    .insertOne({ _id: id, tokenHash: 'h-legacy', expiresAt: new Date(Date.now() + 1e6) });
  await migrations.down(db, { steps: 1 }); // newest = 0003; re-run it against the legacy row
  await migrations.up(db);
  expect((await db.collection('refreshtokens').findOne({ _id: id })).family).toBe(String(id));
  const idx = await db.collection('refreshtokens').indexes();
  expect(idx.find((i) => i.name === 'tokenHash_1')).toMatchObject({ unique: true });
  expect(idx.find((i) => i.name === 'expiresAt_1')).toMatchObject({ expireAfterSeconds: 0 });
  await expect(
    db.collection('refreshtokens').insertOne({ tokenHash: 'h-legacy', expiresAt: new Date() }),
  ).rejects.toThrow(/duplicate key/);
});

test('a migration file without up/down is rejected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  fs.writeFileSync(path.join(dir, '0001-bad.js'), 'module.exports = { up() {} };');
  await expect(migrations.status(db, dir)).rejects.toThrow(/must export up\(\) and down\(\)/);
});
