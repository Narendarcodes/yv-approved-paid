/**
 * Project stage gates (services/stageGates.service.js): each move into a later
 * stage is refused with 409 stage_gate and the list of what is missing until
 * the stage it leaves is done; the same checklist is served on GET /:id/gate.
 * One allowed and one blocked case per gate, plus the deal link and the
 * automatic moves (assign, upload, approve) that respect the gates too.
 * Admin gets no bypass.
 */
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const Project = require('../src/models/project.model');
const Brief = require('../src/models/brief.model');
const ProjectVersion = require('../src/models/projectVersion.model');
const { seedDefaultRoles } = require('../src/seed/roles');
const gates = require('../src/services/stageGates.service');
const { meetGates, gateDeal, addPost } = require('./helpers/gates');

const PASSWORD = 'P@ssw0rd-gates';
let orgId;
const U = {};

async function user(key, role) {
  const email = `${key}@gates.example.com`;
  await request(app).post('/api/v1/auth/register').send({ name: key, email, password: PASSWORD });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  const out = { token: login.body.data.accessToken, userId: login.body.data.user._id };
  if (role) {
    const add = await request(app)
      .post(`/api/v1/organizations/${orgId}/members`)
      .set(auth(U.admin))
      .send({ email, role });
    expect(add.statusCode).toBe(201);
  }
  return out;
}
const auth = (u) => ({ Authorization: `Bearer ${u.token}` });
const move = (u, pid, status) =>
  request(app).post(`/api/v1/projects/${pid}/transition`).set(auth(u)).send({ status });
const gateOf = (u, pid) => request(app).get(`/api/v1/projects/${pid}/gate`).set(auth(u));
const missingKeys = (res) => (res.body.error.details || []).map((d) => d.key);

async function project(status, set = {}) {
  const r = await request(app)
    .post('/api/v1/projects')
    .set(auth(U.admin))
    .send({ organizationId: orgId, title: `gates ${status}` });
  expect(r.statusCode).toBe(201);
  await Project.updateOne({ _id: r.body.data._id }, { $set: { status, ...set } });
  return r.body.data._id;
}

beforeAll(async () => {
  await require('../src/db/mongo').connect();
  await seedDefaultRoles();
  U.admin = await user('admin');
  const org = await request(app)
    .post('/api/v1/organizations')
    .set(auth(U.admin))
    .send({ name: 'Gates Org', slug: 'gates-org' });
  orgId = org.body.data._id;
  U.editor = await user('editor', 'editor');
  U.reviewer = await user('reviewer', 'reviewer');
  U.publisher = await user('publisher', 'publisher');
});

afterAll(async () => {
  await mongoose.disconnect();
});

describe('stage table', () => {
  test('only forward moves into a later stage are gated', () => {
    expect(gates.gatedStage('IDEA', 'ASSIGNED')).toBe('brief');
    expect(gates.gatedStage('ASSIGNED', 'IN_PROGRESS')).toBe('production');
    expect(gates.gatedStage('INPUTS_READY', 'IN_PROGRESS')).toBe('production');
    expect(gates.gatedStage('IN_PROGRESS', 'FIRST_DRAFT_SUBMITTED')).toBe('review');
    expect(gates.gatedStage('REVISION_IN_PROGRESS', 'REVISION_SUBMITTED')).toBe('review');
    expect(gates.gatedStage('UNDER_REVIEW', 'APPROVED')).toBe('publish');
    expect(gates.gatedStage('SCHEDULED', 'PUBLISHED')).toBe('live');
    // inside a stage, back to an earlier one, or out of the lifecycle: not gated
    expect(gates.gatedStage('ASSIGNED', 'WAITING_FOR_INPUTS')).toBeNull();
    expect(gates.gatedStage('APPROVED', 'SCHEDULED')).toBeNull();
    expect(gates.gatedStage('UNDER_REVIEW', 'REVISION_REQUESTED')).toBeNull();
    expect(gates.gatedStage('IN_PROGRESS', 'CANCELLED')).toBeNull();
  });
});

describe('Idea -> Brief: the concept is picked or converted', () => {
  test('blocked: no picked concept (admin too), with the missing item', async () => {
    const pid = await project('IDEA');
    const r = await move(U.admin, pid, 'ASSIGNED');
    expect(r.statusCode).toBe(409);
    expect(r.body.error.code).toBe('stage_gate');
    expect(missingKeys(r)).toEqual(['concept_picked']);
    expect(r.body.error.details[0]).toMatchObject({ href: '/concepts', action: 'Open concepts' });
    expect((await Project.findById(pid).lean()).status).toBe('IDEA');
  });

  test('allowed: picked in the project (APPROVED_CONCEPT) or converted from an approved concept', async () => {
    const picked = await project('APPROVED_CONCEPT');
    expect((await move(U.editor, picked, 'ASSIGNED')).statusCode).toBe(200);
    const converted = await project('IDEA');
    await meetGates(converted, { deal: null, brief: false });
    expect((await move(U.editor, converted, 'ASSIGNED')).statusCode).toBe(200);
  });

  test('assigning an idea sets the owner but keeps it in Idea until the concept is picked', async () => {
    const pid = await project('IDEA');
    const r = await request(app)
      .post(`/api/v1/projects/${pid}/assign`)
      .set(auth(U.admin))
      .send({ assigneeId: U.editor.userId });
    expect(r.statusCode).toBe(200);
    expect(r.body.data.status).toBe('IDEA');
    expect(String(r.body.data.assignee._id)).toBe(U.editor.userId);
  });
});

describe('Brief -> Production: brief items, an editor, a deal signed by both sides with money held', () => {
  test('blocked: nothing done lists every missing item', async () => {
    const pid = await project('ASSIGNED');
    const r = await move(U.admin, pid, 'IN_PROGRESS');
    expect(r.statusCode).toBe(409);
    expect(missingKeys(r)).toEqual([
      'brief_items',
      'editor_assigned',
      'deal_linked',
      'deal_signed',
      'money_held',
    ]);
  });

  test('blocked: unsigned deal, and a signed deal with no money held', async () => {
    const unsigned = await project('ASSIGNED');
    await meetGates(unsigned, {
      assigneeId: U.editor.userId,
      deal: { signed: false, state: 'DRAFT' },
    });
    const a = await move(U.editor, unsigned, 'IN_PROGRESS');
    expect(a.statusCode).toBe(409);
    expect(missingKeys(a)).toEqual(['deal_signed', 'money_held']);
    const p = await Project.findById(unsigned).lean();
    expect(a.body.error.details[0].href).toBe(`/deals/${p.dealId}?reel=reel1&open=terms`);

    const unfunded = await project('ASSIGNED');
    await meetGates(unfunded, { assigneeId: U.editor.userId, deal: { state: 'SIGNED' } });
    const b = await move(U.editor, unfunded, 'INPUTS_READY'); // not a stage move: allowed edge check only
    expect(b.statusCode).toBe(400);
    const c = await move(U.editor, unfunded, 'IN_PROGRESS');
    expect(c.statusCode).toBe(409);
    expect(missingKeys(c)).toEqual(['money_held']);
  });

  test('blocked: the assignee must be an editor (a reviewer does not count)', async () => {
    const pid = await project('ASSIGNED', { assignee: U.reviewer.userId });
    await meetGates(pid, {});
    const r = await move(U.editor, pid, 'IN_PROGRESS');
    expect(missingKeys(r)).toEqual(['editor_assigned']);
  });

  test('blocked: an empty brief does not count', async () => {
    const pid = await project('ASSIGNED');
    await meetGates(pid, { assigneeId: U.editor.userId, brief: false });
    await Brief.create({ projectId: pid, organizationId: orgId, goal: 'x', deliverables: ['  '] });
    expect(missingKeys(await move(U.editor, pid, 'IN_PROGRESS'))).toEqual(['brief_items']);
  });

  test('allowed: everything in place', async () => {
    const pid = await project('ASSIGNED');
    await meetGates(pid, { assigneeId: U.editor.userId });
    const r = await move(U.editor, pid, 'IN_PROGRESS');
    expect(r.statusCode).toBe(200);
    expect(r.body.data.status).toBe('IN_PROGRESS');
  });
});

describe('Production -> Review: a version is uploaded and the checks ran', () => {
  test('blocked: no version and no checks', async () => {
    const pid = await project('IN_PROGRESS');
    await meetGates(pid, { assigneeId: U.editor.userId, deal: { versions: [] } });
    const r = await move(U.editor, pid, 'FIRST_DRAFT_SUBMITTED');
    expect(r.statusCode).toBe(409);
    expect(missingKeys(r)).toEqual(['version_uploaded', 'checks_ran']);
  });

  test('upload without checks stays in Production; the checklist names the checks', async () => {
    const pid = await project('IN_PROGRESS');
    await meetGates(pid, { assigneeId: U.editor.userId, deal: { checked: false } });
    const v = await request(app)
      .post(`/api/v1/projects/${pid}/versions`)
      .set(auth(U.editor))
      .send({ changeSummary: 'v1' });
    expect(v.statusCode).toBe(201);
    expect((await Project.findById(pid).lean()).status).toBe('IN_PROGRESS');
    const g = await gateOf(U.editor, pid);
    expect(g.statusCode).toBe(200);
    expect(g.body.data).toMatchObject({
      from: 'production',
      to: 'review',
      gated: true,
      ready: false,
      next: 'FIRST_DRAFT_SUBMITTED',
    });
    expect(g.body.data.missing.map((m) => m.key)).toEqual(['checks_ran']);
    expect(g.body.data.missing[0].href).toMatch(/open=checks$/);
  });

  test('a version cannot be approved before the project is in Review', async () => {
    const pid = await project('IN_PROGRESS');
    await meetGates(pid, { assigneeId: U.editor.userId, deal: { checked: false } });
    const v = await request(app)
      .post(`/api/v1/projects/${pid}/versions`)
      .set(auth(U.editor))
      .send({ changeSummary: 'v1' });
    const r = await request(app)
      .post(`/api/v1/projects/${pid}/approve`)
      .set(auth(U.reviewer))
      .send({ versionId: v.body.data._id });
    expect(r.statusCode).toBe(409);
    expect(r.body.error.code).toBe('stage_gate');
    expect(missingKeys(r)).toEqual(['checks_ran']);
  });

  test('allowed: upload with checks moves it into Review on its own', async () => {
    const pid = await project('IN_PROGRESS');
    await meetGates(pid, { assigneeId: U.editor.userId });
    await request(app)
      .post(`/api/v1/projects/${pid}/versions`)
      .set(auth(U.editor))
      .send({ changeSummary: 'v1' });
    expect((await Project.findById(pid).lean()).status).toBe('FIRST_DRAFT_SUBMITTED');
  });
});

describe('Review -> Publish: approved by the client or a reviewer', () => {
  test('blocked for an editor: approval is missing (and the edge needs project.approve)', async () => {
    const pid = await project('UNDER_REVIEW');
    await meetGates(pid, { assigneeId: U.editor.userId });
    const g = await gateOf(U.editor, pid);
    expect(g.body.data).toMatchObject({ to: 'publish', ready: false });
    expect(g.body.data.missing.map((m) => m.key)).toEqual(['approved']);
    expect((await move(U.editor, pid, 'APPROVED')).statusCode).toBe(403);
  });

  test('allowed: a reviewer approves with the move; the client approval on the deal also counts', async () => {
    const pid = await project('UNDER_REVIEW');
    await meetGates(pid, { assigneeId: U.editor.userId });
    await ProjectVersion.create({ projectId: pid, organizationId: orgId, versionNumber: 1 });
    expect((await gateOf(U.reviewer, pid)).body.data.ready).toBe(true);
    const r = await move(U.reviewer, pid, 'APPROVED');
    expect(r.statusCode).toBe(200);
    expect(r.body.data.status).toBe('APPROVED');

    const byClient = await project('UNDER_REVIEW');
    await meetGates(byClient, { assigneeId: U.editor.userId, deal: { state: 'APPROVED' } });
    const g = await gateOf(U.editor, byClient);
    expect(g.body.data.items.find((i) => i.key === 'approved').done).toBe(true);
  });
});

describe('Publish -> Live: a post is scheduled or published', () => {
  async function scheduledProject() {
    const pid = await project('SCHEDULED');
    await meetGates(pid, { assigneeId: U.editor.userId });
    const v = await ProjectVersion.create({
      projectId: pid,
      organizationId: orgId,
      versionNumber: 1,
    });
    await Project.updateOne({ _id: pid }, { $set: { approvedVersionId: v._id } });
    return pid;
  }

  test('blocked: no post, even for an admin', async () => {
    const pid = await scheduledProject();
    const r = await move(U.admin, pid, 'PUBLISHED');
    expect(r.statusCode).toBe(409);
    expect(missingKeys(r)).toEqual(['post_scheduled']);
    expect(r.body.error.details[0].href).toBe(`/publishing/compose?project=${pid}`);
  });

  test('blocked: a cancelled or failed post does not count', async () => {
    const pid = await scheduledProject();
    await addPost(pid, 'cancelled');
    await addPost(pid, 'failed');
    expect((await move(U.publisher, pid, 'PUBLISHED')).statusCode).toBe(409);
  });

  test('allowed: a scheduled post, or a published one', async () => {
    const a = await scheduledProject();
    await addPost(a, 'scheduled');
    expect((await move(U.publisher, a, 'PUBLISHED')).statusCode).toBe(200);
    const b = await scheduledProject();
    await addPost(b, 'published');
    expect((await move(U.publisher, b, 'PUBLISHED')).statusCode).toBe(200);
  });
});

describe('deal link and the gate endpoint', () => {
  test("PUT /:id/deal links a deal of the same org; another org's deal or a bad milestone is refused", async () => {
    const pid = await project('ASSIGNED');
    const d = await gateDeal(orgId, {});
    const bad = await request(app)
      .put(`/api/v1/projects/${pid}/deal`)
      .set(auth(U.editor))
      .send({ dealId: d.id, milestoneKey: 'nope' });
    expect(bad.statusCode).toBe(422);
    const other = await gateDeal(new mongoose.Types.ObjectId(), {});
    const cross = await request(app)
      .put(`/api/v1/projects/${pid}/deal`)
      .set(auth(U.editor))
      .send({ dealId: other.id });
    expect(cross.statusCode).toBe(404);
    const ok = await request(app)
      .put(`/api/v1/projects/${pid}/deal`)
      .set(auth(U.editor))
      .send({ dealId: d.id });
    expect(ok.statusCode).toBe(200);
    expect(ok.body.data).toMatchObject({ dealId: d.id, milestoneKey: 'reel1' });
    // a publisher (no project.transition) cannot link
    expect(
      (
        await request(app)
          .put(`/api/v1/projects/${pid}/deal`)
          .set(auth(U.publisher))
          .send({ dealId: null })
      ).statusCode,
    ).toBe(403);
    const off = await request(app)
      .put(`/api/v1/projects/${pid}/deal`)
      .set(auth(U.editor))
      .send({ dealId: null });
    expect(off.body.data.dealId).toBeNull();
  });

  test('GET /:id/gate: a move inside a stage is ready with no checklist; outsiders get 404', async () => {
    const pid = await project('FIRST_DRAFT_SUBMITTED');
    const g = await gateOf(U.editor, pid);
    expect(g.body.data).toMatchObject({
      next: 'UNDER_REVIEW',
      gated: false,
      ready: true,
      items: [],
    });
    const outsider = await user('outsider');
    expect((await gateOf(outsider, pid)).statusCode).toBe(404);
  });
});
