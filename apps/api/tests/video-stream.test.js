/**
 * TDD for video playback auth.
 *
 * Bug: <video> elements cannot send an Authorization header; they rely on
 * the httpOnly accessToken cookie set at login — which expires after 15
 * minutes (the /auth/refresh endpoint does NOT re-set it). So the player
 * 401s while the rest of the app keeps working (authFetch auto-refreshes
 * the localStorage token).
 *
 * Contract under test (Phase 1, ADR-0017): the version-file stream endpoint
 * authenticates with the httpOnly access cookie; ?token= URLs are refused.
 */
const request = require('supertest');
const app = require('../src/app');
const mongoose = require('mongoose');
const ProjectVersion = require('../src/models/projectVersion.model');
const storage = require('../src/storage');

describe('Video stream auth (cookie, no tokens in URLs)', () => {
  let token, projectId, versionId, fileId;

  beforeAll(async () => {
    await require('../src/db/mongo').connect();
    const Role = require('../src/models/role.model');
    await Role.create({ name: 'admin', permissions: ['*'] });

    const email = `streamtest${Date.now()}@example.com`;
    await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'StreamTest', email, password: 'P@ssw0rd' });
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'P@ssw0rd' });
    token = login.body.data.accessToken;

    const org = await request(app)
      .post('/api/v1/organizations')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'StreamOrg', slug: `streamorg${Date.now()}` });
    const orgId = org.body.data._id;

    const proj = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Stream Project', organizationId: orgId });
    projectId = proj.body.data._id;

    const ver = await request(app)
      .post(`/api/v1/projects/${projectId}/versions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ changeSummary: 'stream test' });
    versionId = ver.body.data._id;

    // save a real small file through the storage adapter
    const payload = Buffer.from('fake-mp4-data-for-range-test'); // 28 bytes
    const { storageRef } = await storage.saveFile(payload, {
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
    });
    const version = await ProjectVersion.findById(versionId);
    version.files.push({
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      size: payload.length,
      storageRef,
      uploadedBy: null,
    });
    await version.save();
    fileId = String(version.files[0]._id);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (global.__MONGOD__) await global.__MONGOD__.stop();
  });

  // ADR-0017: <video> elements authenticate with the httpOnly accessToken
  // cookie (sent automatically, same-site). Tokens in URLs (?token=) leaked
  // into logs/history/Referer and are no longer accepted anywhere; the
  // original bug (cookie expiring after 15 min because /auth/refresh did not
  // re-set it) is fixed: refresh now re-sets the access cookie
  // (tests/cookie-session.test.js).
  const fileUrl = () => `/api/v1/projects/${projectId}/versions/${versionId}/files/${fileId}`;

  test('file stream authenticates with the access cookie (what <video> sends)', async () => {
    const res = await request(app)
      .get(fileUrl())
      .set('Cookie', [`accessToken=${token}`]);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
  });

  test('Range request with the cookie returns 206 Partial Content (enables seeking)', async () => {
    const res = await request(app)
      .get(fileUrl())
      .set('Cookie', [`accessToken=${token}`])
      .set('Range', 'bytes=0-9');
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-9/28`); // payload.length
    expect(res.headers['accept-ranges']).toBe('bytes');
  });

  test('?token= in the URL is not accepted (even a valid one)', async () => {
    expect((await request(app).get(`${fileUrl()}?token=${token}`)).statusCode).toBe(401);
    expect((await request(app).get(`${fileUrl()}?token=not-a-real-token`)).statusCode).toBe(401);
  });

  describe('seeded demo reels (storageRef demo:<name>, no copy in the uploads dir)', () => {
    const demo = require('../src/modules/deals/demo-content.cts');
    const config = require('../src/config');
    let demoFileId;
    const demoUrl = (id) => `/api/v1/projects/${projectId}/versions/${versionId}/files/${id}`;

    beforeAll(async () => {
      const version = await ProjectVersion.findById(versionId);
      version.files.push(
        { filename: 'lumen-reel4.mp4', mimeType: 'video/mp4', storageRef: 'demo:lumen-reel4.mp4' },
        { filename: 'x.mp4', mimeType: 'video/mp4', storageRef: 'demo:../../etc/passwd' },
      );
      await version.save();
      demoFileId = String(version.files[1]._id);
    });
    afterEach(() => jest.restoreAllMocks());

    test('served from the bundled web copy when the API has it', async () => {
      const res = await request(app)
        .get(demoUrl(demoFileId))
        .set('Cookie', [`accessToken=${token}`])
        .set('Range', 'bytes=0-9');
      expect(res.statusCode).toBe(206);
      expect(res.headers['content-type']).toBe('video/mp4');
    });

    test("redirected to the web's static /demo/reels when the bundle is not deployed", async () => {
      jest.spyOn(demo, 'demoReelPath').mockReturnValue(null);
      const res = await request(app)
        .get(demoUrl(demoFileId))
        .set('Cookie', [`accessToken=${token}`]);
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(`${config.corsOrigin[0]}/demo/reels/lumen-reel4.mp4`);
    });

    test('any other demo: ref is refused', async () => {
      const version = await ProjectVersion.findById(versionId);
      const res = await request(app)
        .get(demoUrl(String(version.files[2]._id)))
        .set('Cookie', [`accessToken=${token}`]);
      expect(res.statusCode).toBe(404);
    });
  });
});
