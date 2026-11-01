/**
 * 0003: refresh tokens as rotating session families (ADR-0017, Phase 1 item 8).
 *
 * up:   every row gets a `family` (legacy rows: their own _id, i.e. a session
 *       of one), then the indexes the auth flow needs:
 *         tokenHash unique   (lookup on every refresh was a collection scan)
 *         expiresAt TTL      (expired rows are deleted instead of piling up)
 *         family             (revoke a whole session on logout / reuse)
 * down: drop those indexes (family values are harmless and kept).
 * Idempotent: createIndex on an identical index is a no-op; only rows without
 * a family are updated.
 */
const INDEXES = [
  [{ tokenHash: 1 }, { name: 'tokenHash_1', unique: true }],
  [{ expiresAt: 1 }, { name: 'expiresAt_1', expireAfterSeconds: 0 }],
  [{ family: 1 }, { name: 'family_1' }],
];

module.exports = {
  async up({ db }) {
    const rt = db.collection('refreshtokens');
    await rt.updateMany({ $or: [{ family: { $exists: false } }, { family: null }] }, [
      { $set: { family: { $toString: '$_id' } } },
    ]);
    for (const [keys, opts] of INDEXES) await rt.createIndex(keys, opts);
  },

  async down({ db }) {
    const rt = db.collection('refreshtokens');
    for (const [, { name }] of INDEXES) {
      await rt.dropIndex(name).catch((err) => {
        if (err.codeName !== 'IndexNotFound' && err.codeName !== 'NamespaceNotFound') throw err;
      });
    }
  },
};
