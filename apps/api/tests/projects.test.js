const request = require('supertest');
const app = require('../src/app');
const mongoose = require('mongoose');
const Role = require('../src/models/role.model');
const { meetGates } = require('./helpers/gates');

beforeAll(async () => {
  await require('../src/db/mongo').connect();
  await Role.create({ name: 'admin', permissions: ['*'] });
  await Role.create({ name: 'approver', permissions: ['project.approve', 'project.view'] });
});

afterAll(async () => {
  await mongoose.disconnect();
  if (global.__MONGOD__) await global.__MONGOD__.stop();
});

describe('Project lifecycle', () => {
  test('create project, add version, approve exact version', async () => {
    const adminEmail = 'projadmin@example.com';
    await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'ProjAdmin', email: adminEmail, password: 'P@ssw0rd' });
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: adminEmail, password: 'P@ssw0rd' });
    const token = login.body.data.accessToken;

    // create org
    const createOrg = await request(app)
      .post('/api/v1/organizations')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'OrgX', slug: 'orgx' });
    const orgId = createOrg.body.data._id;

    // create project
    const create = await request(app)
      .post('/api/v1/projects')
      .set('Authorization', `Bearer ${token}`)
      .send({ organizationId: orgId, title: 'New Project', description: 'desc' });
    expect(create.statusCode).toBe(201);
    const projectId = create.body.data._id;
    // stage gates: approved concept, brief items, an editor, signed + held deal with checks
    await meetGates(projectId, { assigneeId: login.body.data.user._id });

    // transition to ASSIGNED then IN_PROGRESS
    await request(app)
      .post(`/api/v1/projects/${projectId}/transition`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'ASSIGNED' });
    await request(app)
      .post(`/api/v1/projects/${projectId}/transition`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'IN_PROGRESS' });

    // add version
    const v = await request(app)
      .post(`/api/v1/projects/${projectId}/versions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ metadata: { filename: 'draft.mp4' }, changeSummary: 'first draft' });
    expect(v.statusCode).toBe(201);
    const versionId = v.body.data._id;

    // seed approver user and membership
    const approverEmail = 'approver@example.com';
    await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Approver', email: approverEmail, password: 'P@ssw0rd' });
    const alog = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: approverEmail, password: 'P@ssw0rd' });
    const atoken = alog.body.data.accessToken;
    // make approver member of org and role approver
    // admin adds member
    await request(app)
      .post(`/api/v1/organizations/${orgId}/members`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: approverEmail, role: 'approver' });

    // approver approves exact version
    const appRes = await request(app)
      .post(`/api/v1/projects/${projectId}/approve`)
      .set('Authorization', `Bearer ${atoken}`)
      .send({ versionId });
    expect(appRes.statusCode).toBe(200);
    expect(appRes.body.data).toHaveProperty('approvedVersionId');
    expect(appRes.body.data.status).toBe('APPROVED');
  });
});

describe('Team Chat container', () => {
  test('creating "Team Chat" twice returns the one that exists (no duplicate); search finds it past the newest 50', async () => {
    const email = 'teamchat@example.com';
    await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'Chat Admin', email, password: 'P@ssw0rd' });
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'P@ssw0rd' });
    const auth = { Authorization: `Bearer ${login.body.data.accessToken}` };
    const org = await request(app)
      .post('/api/v1/organizations')
      .set(auth)
      .send({ name: 'Chat Org', slug: 'chat-org' });
    const organizationId = org.body.data._id;
    const make = (title) =>
      request(app).post('/api/v1/projects').set(auth).send({ organizationId, title });

    const first = await make('Team Chat');
    expect(first.statusCode).toBe(201);
    for (let i = 0; i < 52; i++) await make(`Reel ${i}`);
    const again = await make('Team Chat');
    expect(again.statusCode).toBe(201);
    expect(String(again.body.data._id)).toBe(String(first.body.data._id));

    const plain = await request(app)
      .get(`/api/v1/projects?organizationId=${organizationId}`)
      .set(auth);
    const items = Array.isArray(plain.body.data) ? plain.body.data : plain.body.data.items;
    expect(items.some((p) => p.title === 'Team Chat')).toBe(false); // fell off the newest 50

    const found = await request(app)
      .get(`/api/v1/projects?organizationId=${organizationId}&search=Team%20Chat`)
      .set(auth);
    const hits = (Array.isArray(found.body.data) ? found.body.data : found.body.data.items).filter(
      (p) => p.title === 'Team Chat',
    );
    expect(hits).toHaveLength(1);
  });
});
