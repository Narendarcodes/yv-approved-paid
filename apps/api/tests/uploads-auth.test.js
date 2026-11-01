/**
 * Phase 1 item 7: uploads are no longer publicly served. Avatars go through
 * GET /users/:userId/photo (self or a shared org, else 404); version files
 * through the org-checked stream route (also in tests/cross-org.test.js).
 */
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const config = require('../src/config');
const Role = require('../src/models/role.model');
const User = require('../src/models/user.model');
const storage = require('../src/storage');
const migrations = require('../src/modules/platform/migrations.cts');

const API = '/api/v1';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const U = {};

async function user(name) {
  const email = `${name}@uploads.example.com`;
  await request(app).post(`${API}/auth/register`).send({ name, email, password: 'P@ssw0rd!' });
  const login = await request(app).post(`${API}/auth/login`).send({ email, password: 'P@ssw0rd!' });
  return { token: login.body.data.accessToken, id: String(login.body.data.user._id) };
}
const auth = (u) => ({ Authorization: `Bearer ${u.token}` });

beforeAll(async () => {
  await require('../src/db/mongo').connect();
  await Role.create({ name: 'admin', permissions: ['*'] });
  await Role.create({ name: 'editor', permissions: ['project.view'] });
  U.alice = await user('alice');
  U.carol = await user('carol'); // same org as alice
  U.bob = await user('bob'); // other org
  const org = await request(app)
    .post(`${API}/organizations`)
    .set(auth(U.alice))
    .send({ name: 'Uploads A', slug: 'uploads-a' });
  await request(app)
    .post(`${API}/organizations/${org.body.data._id}/members`)
    .set(auth(U.alice))
    .send({ email: 'carol@uploads.example.com', role: 'editor' });
  await request(app)
    .post(`${API}/organizations`)
    .set(auth(U.bob))
    .send({ name: 'Uploads B', slug: 'uploads-b' });
});

afterAll(async () => {
  await mongoose.disconnect();
});

describe('avatars', () => {
  let photoUrl;

  test('upload returns an API URL, not a public /uploads path', async () => {
    const r = await request(app)
      .patch(`${API}/users/me/photo`)
      .set(auth(U.alice))
      .attach('file', PNG, 'me.png');
    expect(r.status).toBe(200);
    photoUrl = r.body.data.photoUrl;
    expect(photoUrl).toMatch(new RegExp(`^${API}/users/${U.alice.id}/photo\\?v=[a-f0-9]{8}$`));
    expect(r.body.data).not.toHaveProperty('photoStorageRef');
    expect(r.body.data).not.toHaveProperty('passwordHash'); // getMe used to return the bcrypt hash
  });

  test('the old public static mount is gone', async () => {
    const u = await User.findById(U.alice.id).lean();
    const r = await request(app).get(`/uploads/${u.photoStorageRef}`);
    expect(r.status).toBe(404);
    expect(fs.existsSync(storage.resolvePath(u.photoStorageRef))).toBe(true); // file is still stored
  });

  test('self and same-org users can load it; other orgs get 404; anonymous 401', async () => {
    const self = await request(app).get(photoUrl).set(auth(U.alice));
    expect(self.status).toBe(200);
    expect(self.headers['content-type']).toBe('image/png');
    expect(self.headers['cache-control']).toBe('private, max-age=300');
    expect(Buffer.compare(self.body, PNG)).toBe(0);
    expect((await request(app).get(photoUrl).set(auth(U.carol))).status).toBe(200);
    expect((await request(app).get(photoUrl).set(auth(U.bob))).status).toBe(404);
    expect((await request(app).get(photoUrl)).status).toBe(401);
  });

  test('SVG (scriptable) avatars are refused', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const r = await request(app)
      .patch(`${API}/users/me/photo`)
      .set(auth(U.carol))
      .attach('file', svg, { filename: 'x.svg', contentType: 'image/svg+xml' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('unsupported_image');
  });

  test('legacy /uploads/<ref> photoUrl: rewritten on output, served by the route, migrated by 0002', async () => {
    const { storageRef } = await storage.saveFile(PNG, { filename: 'old.png' });
    await User.updateOne(
      { _id: U.carol.id },
      {
        $set: {
          photoUrl: `/uploads/${storageRef}`,
          profileImage: `/uploads/${storageRef}`,
          photoStorageRef: null,
        },
      },
    );
    const me = await request(app).get(`${API}/users/me`).set(auth(U.carol));
    expect(me.body.data.photoUrl).toBe(
      `${API}/users/${U.carol.id}/photo?v=${storageRef.slice(0, 8)}`,
    );
    expect((await request(app).get(me.body.data.photoUrl).set(auth(U.alice))).status).toBe(200);

    await migrations.up(mongoose.connection.db);
    const raw = await User.findById(U.carol.id).lean();
    expect(raw.photoStorageRef).toBe(storageRef);
    expect(raw.photoUrl).toBe(`${API}/users/${U.carol.id}/photo?v=${storageRef.slice(0, 8)}`);
  });
});

describe('storage refs cannot escape the upload dir', () => {
  test.each(['../package.json', '/etc/passwd', 'a/b', '', 'ABCDEF', `${'a'.repeat(32)}/../x`])(
    '%p -> null',
    (ref) => {
      expect(storage.resolvePath(ref)).toBeNull();
    },
  );
  test('a generated ref resolves inside STORAGE_LOCAL_DIR', () => {
    expect(storage.resolvePath(`${'a'.repeat(32)}.mp4`)).toBe(
      path.join(config.storage.localDir, `${'a'.repeat(32)}.mp4`),
    );
  });
});
