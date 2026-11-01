/**
 * 0001: tenant key on project-owned collections (ADR-0015, Phase 1).
 *
 * up:   backfill organizationId from the parent Project on the nine
 *       collections that lacked it, plus Publication / PerformanceMetric rows
 *       whose organizationId was left null; then create the org-first compound
 *       indexes the services query by. Orphans (project deleted) are counted
 *       and left as-is; they fail validation on next save and can be removed.
 * down: drop those indexes and $unset organizationId from the nine
 *       collections (Publication / PerformanceMetric keep theirs: the field
 *       existed before this migration).
 * Idempotent: only rows missing organizationId are touched; createIndex on an
 * existing identical index is a no-op.
 */
const COLLECTIONS = {
  briefs: [{ organizationId: 1, projectId: 1 }],
  comments: [{ organizationId: 1, projectId: 1, versionId: 1, createdAt: 1 }],
  tasks: [{ organizationId: 1, projectId: 1, status: 1, createdAt: 1 }],
  inputs: [{ organizationId: 1, projectId: 1, state: 1 }],
  revisionrequests: [{ organizationId: 1, projectId: 1, revisionNumber: -1 }],
  projectversions: [{ organizationId: 1, projectId: 1, versionNumber: -1 }],
  channels: [{ organizationId: 1, projectId: 1 }],
  chatmessages: [{ organizationId: 1, channelId: 1, createdAt: 1 }],
  activityevents: [
    { organizationId: 1, createdAt: -1 },
    { organizationId: 1, projectId: 1, createdAt: -1 },
  ],
};
// Already had a nullable organizationId: backfill only.
const NULLABLE = ['publications', 'performancemetrics'];

const missingOrg = { $or: [{ organizationId: { $exists: false } }, { organizationId: null }] };

async function backfill(db, name) {
  await db
    .collection(name)
    .aggregate([
      { $match: { ...missingOrg, projectId: { $ne: null } } },
      { $lookup: { from: 'projects', localField: 'projectId', foreignField: '_id', as: 'p' } },
      { $unwind: '$p' },
      { $project: { _id: 1, organizationId: '$p.organizationId' } },
      { $merge: { into: name, on: '_id', whenMatched: 'merge', whenNotMatched: 'discard' } },
    ])
    .toArray();
  return db.collection(name).countDocuments(missingOrg);
}

const indexName = (spec) =>
  Object.entries(spec)
    .map(([k, v]) => `${k}_${v}`)
    .join('_');

module.exports = {
  async up({ db, log }) {
    for (const name of [...Object.keys(COLLECTIONS), ...NULLABLE]) {
      const orphans = await backfill(db, name);
      if (orphans) log(`  ${name}: ${orphans} row(s) without a resolvable project left unscoped`);
    }
    for (const [name, specs] of Object.entries(COLLECTIONS)) {
      for (const spec of specs)
        await db.collection(name).createIndex(spec, { name: indexName(spec) });
    }
  },

  async down({ db }) {
    for (const [name, specs] of Object.entries(COLLECTIONS)) {
      for (const spec of specs) {
        await db
          .collection(name)
          .dropIndex(indexName(spec))
          .catch((err) => {
            if (err.codeName !== 'IndexNotFound' && err.codeName !== 'NamespaceNotFound') throw err;
          });
      }
      await db.collection(name).updateMany({}, { $unset: { organizationId: '' } });
    }
  },
};
