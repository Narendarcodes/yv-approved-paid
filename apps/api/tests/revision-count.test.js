const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const Project = require('../src/models/project.model');
const revisionService = require('../src/services/revision.service');

// Regression: requestRevision used to save the project only when it changed
// status, so revisionCount was lost for projects outside a reviewable state.
describe('revision.service requestRevision keeps revisionCount', () => {
  let token;
  let orgId;
  let userId;

  beforeAll(async () => {
    await require('../src/db/mongo').connect();
    const email = 'revcount@example.com';
    await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'RevCount', email, password: 'P@ssw0rd' });
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'P@ssw0rd' });
    token = login.body.data.accessToken;
    userId = login.body.data.user && (login.body.data.user._id || login.body.data.user.id);
    const org = await request(app)
      .post('/api/v1/organizations')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'RevCountOrg', slug: 'rev-count-org' });
    orgId = org.body.data._id;
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (global.__MONGOD__) await global.__MONGOD__.stop();
  });

  async function newProject(status) {
    const res = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ organizationId: orgId, title: `Rev ${status}` });
    const id = res.body.data._id;
    if (status !== 'IDEA') await Project.updateOne({ _id: id }, { status });
    return id;
  }

  test('counts the revision when the status does not change (IN_PROGRESS)', async () => {
    const projectId = await newProject('IN_PROGRESS');
    await revisionService.requestRevision({
      projectId,
      organizationId: orgId,
      reason: 'Tighten the intro',
      requester: userId,
    });
    await revisionService.requestRevision({
      projectId,
      organizationId: orgId,
      reason: 'Fix captions',
      requester: userId,
    });
    const p = await Project.findById(projectId);
    expect(p.status).toBe('IN_PROGRESS');
    expect(p.revisionCount).toBe(2);
  });

  test('counts the revision and moves status from a reviewable state', async () => {
    const projectId = await newProject('UNDER_REVIEW');
    await revisionService.requestRevision({
      projectId,
      organizationId: orgId,
      reason: 'Recolor',
      requester: userId,
    });
    const p = await Project.findById(projectId);
    expect(p.status).toBe('REVISION_REQUESTED');
    expect(p.revisionCount).toBe(1);
  });

  test('POST /projects/:id/revisions persists the count via HTTP', async () => {
    const projectId = await newProject('APPROVED');
    const res = await request(app)
      .post(`/api/v1/projects/${projectId}/revisions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Late change request from client' });
    expect(res.statusCode).toBe(201);
    const p = await Project.findById(projectId);
    expect(p.status).toBe('APPROVED');
    expect(p.revisionCount).toBe(1);
  });
});
