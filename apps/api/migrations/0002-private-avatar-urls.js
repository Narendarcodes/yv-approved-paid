/**
 * 0002: avatars stop being public static files (Phase 1 item 7).
 *
 * up:   users whose photoUrl/profileImage still point at the retired public
 *       /uploads/<ref> mount get photoStorageRef = <ref> and the authenticated
 *       URL /api/v1/users/<id>/photo?v=<ref prefix>.
 * down: restore /uploads/<ref> from photoStorageRef for those users.
 * Idempotent: only rows still on /uploads/ (up) or on the API URL (down) match.
 * (User.toJSON also rewrites legacy URLs on output, so the API is correct even
 * before this runs.)
 */
const PREFIX = process.env.API_PREFIX || '/api/v1';

module.exports = {
  async up({ db }) {
    const users = db.collection('users');
    const cursor = users.find(
      { photoUrl: { $regex: '^/uploads/' } },
      { projection: { photoUrl: 1 } },
    );
    for await (const u of cursor) {
      const ref = u.photoUrl.slice('/uploads/'.length);
      const url = `${PREFIX}/users/${u._id}/photo?v=${ref.slice(0, 8)}`;
      await users.updateOne(
        { _id: u._id },
        { $set: { photoStorageRef: ref, photoUrl: url, profileImage: url } },
      );
    }
  },

  async down({ db }) {
    const users = db.collection('users');
    const cursor = users.find(
      { photoStorageRef: { $type: 'string' }, photoUrl: { $regex: `^${PREFIX}/users/` } },
      { projection: { photoStorageRef: 1 } },
    );
    for await (const u of cursor) {
      const url = `/uploads/${u.photoStorageRef}`;
      await users.updateOne({ _id: u._id }, { $set: { photoUrl: url, profileImage: url } });
    }
  },
};
