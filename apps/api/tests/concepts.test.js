/**
 * Concept -> project conversion creates the project AND pre-fills its brief
 * in one step (Phase 3).
 */
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const Role = require('../src/models/role.model');
const Brief = require('../src/models/brief.model');

let token;
let orgId;
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  await require('../src/db/mongo').connect();
  await Role.create({ name: 'admin', permissions: ['*'] });
  await request(app).post('/api/v1/auth/register').send({ name: 'C Admin', email: 'c@example.com', password: 'P@ssw0rd' });
  const login = await request(app).post('/api/v1/auth/login').send({ email: 'c@example.com', password: 'P@ssw0rd' });
  token = login.body.data.accessToken;
  const org = await request(app).post('/api/v1/organizations').set(auth()).send({ name: 'C Org', slug: 'c-org' });
  orgId = org.body.data._id;
});

afterAll(async () => {
  await mongoose.disconnect();
});

test('approve converts a concept into a project with a pre-filled brief', async () => {
  const c = await request(app)
    .post(`/api/v1/organizations/${orgId}/concepts`)
    .set(auth())
    .send({ title: 'Clay diya reel', description: 'Show a diya from lump to lit in 30s', type: 'Experiment' });
  expect(c.status).toBe(201);
  const res = await request(app)
    .patch(`/api/v1/organizations/${orgId}/concepts/${c.body.data.id}/approve`)
    .set(auth())
    .send({ client: 'Kalpa Crafts', campaign: 'Festive', brief: { targetAudience: 'Hobby potters 25-40', deliverables: ['30s reel', 'cover still'], deadline: '2030-01-10' } });
  expect(res.status).toBe(200);
  const { projectId } = res.body.data;
  const project = await request(app).get(`/api/v1/projects/${projectId}?organizationId=${orgId}`).set(auth());
  expect(project.body.data).toMatchObject({ title: 'Clay diya reel', status: 'APPROVED_CONCEPT', client: 'Kalpa Crafts', campaign: 'Festive' });
  expect(String(project.body.data.conceptId)).toBe(c.body.data.id);
  const brief = await Brief.findOne({ projectId });
  expect(brief.goal).toBe('Show a diya from lump to lit in 30s');
  expect(brief.targetAudience).toBe('Hobby potters 25-40');
  expect(brief.deliverables).toEqual(['30s reel', 'cover still']);
  expect(brief.deadline.toISOString().slice(0, 10)).toBe('2030-01-10');

  const again = await request(app).patch(`/api/v1/organizations/${orgId}/concepts/${c.body.data.id}/approve`).set(auth()).send({});
  expect(again.status).toBe(409);
});
