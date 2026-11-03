/**
 * Team assignment: projects and tasks only go to active members of the same
 * org, and the Members "Invite" is real but safe in DEMO_MODE (example.com
 * only, added as pending, never emailed).
 */
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const { seedDefaultRoles } = require('../src/seed/roles');
const Membership = require('../src/models/membership.model');
const User = require('../src/models/user.model');

async function registerAndLogin(name, email) {
  await request(app).post('/api/v1/auth/register').send({ name, email, password: 'P@ssw0rd-team' });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: 'P@ssw0rd-team' });
  return { token: login.body.data.accessToken, userId: login.body.data.user._id };
}
const auth = (u) => ({ Authorization: `Bearer ${u.token}` });

let admin;
let editor;
let reviewer;
let outsider;
let orgId;
let projectId;

beforeAll(async () => {
  await require('../src/db/mongo').connect();
  await seedDefaultRoles();
  admin = await registerAndLogin('Team Admin', 'team-admin@example.com');
  editor = await registerAndLogin('Ravi Team', 'team-editor@example.com');
  reviewer = await registerAndLogin('Rhea Team', 'team-reviewer@example.com');
  outsider = await registerAndLogin('Olly Outsider', 'team-outsider@example.com');
  const org = await request(app).post('/api/v1/organizations').set(auth(admin)).send({ name: 'Team Org', slug: 'team-org' });
  orgId = org.body.data._id;
  for (const [email, role] of [['team-editor@example.com', 'editor'], ['team-reviewer@example.com', 'reviewer']]) {
    const r = await request(app).post(`/api/v1/organizations/${orgId}/members`).set(auth(admin)).send({ email, role });
    expect(r.statusCode).toBe(201);
    expect(r.body.data.emailSent).toBe(false);
  }
  const p = await request(app).post('/api/v1/projects').set(auth(admin)).send({ organizationId: orgId, title: 'Team reel' });
  projectId = p.body.data._id;
});

afterAll(async () => {
  delete process.env.DEMO_MODE;
  await mongoose.disconnect();
});

describe('project assignment', () => {
  test('an admin assigns a member; the answer carries the assignee name', async () => {
    const r = await request(app).post(`/api/v1/projects/${projectId}/assign`).set(auth(admin)).send({ assigneeId: editor.userId });
    expect(r.statusCode).toBe(200);
    expect(r.body.data.assignee).toMatchObject({ _id: editor.userId, name: 'Ravi Team' });
    expect(r.body.data.status).toBe('ASSIGNED');
  });

  test('someone outside the org cannot be assigned (422 assignee_not_member)', async () => {
    const r = await request(app).post(`/api/v1/projects/${projectId}/assign`).set(auth(admin)).send({ assigneeId: outsider.userId });
    expect(r.statusCode).toBe(422);
    expect(r.body.error.code).toBe('assignee_not_member');
  });

  test('a disabled member cannot be assigned', async () => {
    await Membership.updateOne({ userId: reviewer.userId, organizationId: orgId }, { $set: { disabled: true } });
    const r = await request(app).post(`/api/v1/projects/${projectId}/assign`).set(auth(admin)).send({ assigneeId: reviewer.userId });
    expect(r.statusCode).toBe(422);
    await Membership.updateOne({ userId: reviewer.userId, organizationId: orgId }, { $set: { disabled: false } });
  });

  test('a reviewer (no project.assign) is refused with 403', async () => {
    const r = await request(app).post(`/api/v1/projects/${projectId}/assign`).set(auth(reviewer)).send({ assigneeId: editor.userId });
    expect(r.statusCode).toBe(403);
  });
});

describe('task assignment', () => {
  test('tasks go to members only, on create and on update', async () => {
    const bad = await request(app).post(`/api/v1/projects/${projectId}/tasks`).set(auth(admin)).send({ title: 'Cut', assignee: outsider.userId });
    expect(bad.statusCode).toBe(422);
    expect(bad.body.error.code).toBe('assignee_not_member');
    const ok = await request(app).post(`/api/v1/projects/${projectId}/tasks`).set(auth(admin)).send({ title: 'Cut', assignee: editor.userId });
    expect(ok.statusCode).toBe(201);
    const taskId = ok.body.data._id;
    const moved = await request(app).patch(`/api/v1/projects/${projectId}/tasks/${taskId}`).set(auth(admin)).send({ assignee: reviewer.userId });
    expect(moved.statusCode).toBe(200);
    const away = await request(app).patch(`/api/v1/projects/${projectId}/tasks/${taskId}`).set(auth(admin)).send({ assignee: outsider.userId });
    expect(away.statusCode).toBe(422);
  });
});

describe('invite (members API)', () => {
  test('outside demo mode an unknown email is a 404 and no placeholder user is made', async () => {
    delete process.env.DEMO_MODE;
    const r = await request(app).post(`/api/v1/organizations/${orgId}/members`).set(auth(admin)).send({ email: 'nobody-yet@example.com', role: 'editor' });
    expect(r.statusCode).toBe(404);
    expect(await User.exists({ email: 'nobody-yet@example.com' })).toBeNull();
  });

  test('demo mode refuses any address outside example.com, even an existing account', async () => {
    process.env.DEMO_MODE = '1';
    await registerAndLogin('Real Person', 'real.person@gmail-demo-test.com');
    const r = await request(app).post(`/api/v1/organizations/${orgId}/members`).set(auth(admin)).send({ email: 'real.person@gmail-demo-test.com', role: 'editor' });
    expect(r.statusCode).toBe(422);
    expect(r.body.error.code).toBe('demo_invite_domain');
    const m = await Membership.countDocuments({ organizationId: orgId });
    expect(m).toBe(3);
  });

  test('demo mode adds an unknown example.com address as a pending member, no email sent', async () => {
    process.env.DEMO_MODE = '1';
    const r = await request(app).post(`/api/v1/organizations/${orgId}/members`).set(auth(admin)).send({ email: 'Sana.Motion@studio.example.com', role: 'editor' });
    expect(r.statusCode).toBe(201);
    expect(r.body.data).toMatchObject({ pending: true, emailSent: false, role: 'editor' });
    expect(r.body.data.user.email).toBe('sana.motion@studio.example.com');
    const list = await request(app).get(`/api/v1/organizations/${orgId}/members`).set(auth(admin));
    expect(list.body.data.find((x) => x.userId.email === 'sana.motion@studio.example.com').pending).toBe(true);
    const again = await request(app).post(`/api/v1/organizations/${orgId}/members`).set(auth(admin)).send({ email: 'sana.motion@studio.example.com', role: 'editor' });
    expect(again.statusCode).toBe(409);
  });

  test('only manage_members may invite', async () => {
    process.env.DEMO_MODE = '1';
    const r = await request(app).post(`/api/v1/organizations/${orgId}/members`).set(auth(editor)).send({ email: 'x@example.com', role: 'editor' });
    expect(r.statusCode).toBe(403);
  });
});
