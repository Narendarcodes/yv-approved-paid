/**
 * Batch A authorization fixes (Strix + manual pentest, 2026-10-28; ADR-0019).
 *
 *   M1  POST /projects/:id/transition checks the permission of each lifecycle
 *       edge (TRANSITIONS table), not just project.transition. Regression for
 *       the editor-bypass PoC (probe4.py), where every step returned 200.
 *   M2  Concept approve/decline need concept.review; approving your own
 *       concept also needs concept.approve_own (admins).
 *   L1  Member update is schema-validated and can't leave an org without an
 *       active admin.
 *
 * Uses the real role seeds (seed/roles.js), so the tests break if a role
 * quietly gains a permission that reopens one of these holes.
 */
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const Project = require('../src/models/project.model');
const Membership = require('../src/models/membership.model');
const { seedDefaultRoles, DEFAULT_ROLES } = require('../src/seed/roles');
const {
  TRANSITIONS,
  ALLOWED_TRANSITIONS,
  transitionRule,
  transitionProject,
} = require('../src/services/project.service');

const PASSWORD = 'P@ssw0rd-batch-a';
let orgId;
const U = {}; // role -> { token, userId }

async function user(key, role) {
  const email = `${key}@batch-a.example.com`;
  await request(app).post('/api/v1/auth/register').send({ name: key, email, password: PASSWORD });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  const out = { token: login.body.data.accessToken, userId: login.body.data.user._id, email };
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
const transition = (u, pid, status) =>
  request(app).post(`/api/v1/projects/${pid}/transition`).set(auth(u)).send({ status });

async function newProject(by = U.editor, title = 'batch-a') {
  const r = await request(app)
    .post('/api/v1/projects')
    .set(auth(by))
    .send({ organizationId: orgId, title });
  expect(r.statusCode).toBe(201);
  return r.body.data._id;
}

async function walk(u, pid, states) {
  for (const s of states) {
    const r = await transition(u, pid, s);
    expect({ to: s, status: r.statusCode }).toEqual({ to: s, status: 200 });
  }
}

beforeAll(async () => {
  await require('../src/db/mongo').connect();
  await seedDefaultRoles();
  U.admin = await user('admin');
  const org = await request(app)
    .post('/api/v1/organizations')
    .set(auth(U.admin))
    .send({ name: 'Batch A', slug: 'batch-a' });
  orgId = org.body.data._id;
  U.editor = await user('editor', 'editor');
  U.reviewer = await user('reviewer', 'reviewer');
  U.publisher = await user('publisher', 'publisher');
});

afterAll(async () => {
  await mongoose.disconnect();
});

// ---------------------------------------------------------------------------
describe('M1 lifecycle table (unit)', () => {
  const edges = Object.entries(TRANSITIONS).flatMap(([from, to]) =>
    Object.entries(to).map(([target, rule]) => ({ from, to: target, rule })),
  );

  test('every edge names a permission', () => {
    for (const e of edges) expect(typeof e.rule.permission).toBe('string');
  });

  test('approval, scheduling and publishing edges need their own permissions', () => {
    const need = { APPROVED: 'project.approve', SCHEDULED: 'project.schedule', PUBLISHED: 'project.publish' };
    const gated = edges.filter((e) => need[e.to]);
    expect(gated.length).toBe(4); // UNDER_REVIEW/REVISION_SUBMITTED->APPROVED, ->SCHEDULED, ->PUBLISHED
    for (const e of gated) expect(e.rule.permission).toBe(need[e.to]);
    expect(transitionRule('UNDER_REVIEW', 'APPROVED').approvesLatestVersion).toBe(true);
    expect(transitionRule('APPROVED', 'SCHEDULED').requiresApprovedVersion).toBe(true);
    expect(transitionRule('SCHEDULED', 'PUBLISHED').requiresApprovedVersion).toBe(true);
  });

  test('editor holds none of the gated permissions; reviewer reviews concepts but not their own', () => {
    const perms = Object.fromEntries(DEFAULT_ROLES.map((r) => [r.name, r.permissions]));
    expect(perms.editor).not.toContain('project.approve');
    expect(perms.editor).not.toContain('project.schedule');
    expect(perms.editor).not.toContain('project.publish');
    expect(perms.editor).not.toContain('concept.review');
    expect(perms.reviewer).toContain('concept.review');
    expect(perms.reviewer).not.toContain('concept.approve_own');
  });

  test('ALLOWED_TRANSITIONS is derived from the table', () => {
    for (const [from, to] of Object.entries(TRANSITIONS)) {
      expect(ALLOWED_TRANSITIONS[from]).toEqual(Object.keys(to));
    }
    expect(transitionRule('IDEA', 'PUBLISHED')).toBeNull();
    expect(transitionRule('NOPE', 'IDEA')).toBeNull();
    expect(transitionRule('IDEA', 'constructor')).toBeNull();
  });

  test('transitionProject refuses to run without caller permissions', async () => {
    const pid = await newProject();
    await expect(
      transitionProject({ projectId: pid, organizationId: orgId, newStatus: 'ASSIGNED', actorId: U.editor.userId }),
    ).rejects.toMatchObject({ status: 500, code: 'access_unresolved' });
  });
});

// ---------------------------------------------------------------------------
describe('M1 /transition route', () => {
  const TO_REVIEW = ['ASSIGNED', 'IN_PROGRESS', 'FIRST_DRAFT_SUBMITTED', 'UNDER_REVIEW'];

  test('editor-bypass PoC (probe4.py): editor is stopped at APPROVED, SCHEDULED and PUBLISHED', async () => {
    const pid = await newProject(U.editor, 'editor-bypass');
    const direct = await request(app)
      .post(`/api/v1/projects/${pid}/approve`)
      .set(auth(U.editor))
      .send({ versionId: '0'.repeat(24) });
    expect(direct.statusCode).toBe(403);

    await walk(U.editor, pid, TO_REVIEW); // work-in-progress edges still work for editors
    const toApproved = await transition(U.editor, pid, 'APPROVED');
    expect(toApproved.statusCode).toBe(403);
    expect(toApproved.body.error.message).toMatch(/project\.approve/);

    // Even with the project already approved, the editor can't schedule or publish.
    await Project.updateOne({ _id: pid }, { status: 'APPROVED' });
    expect((await transition(U.editor, pid, 'SCHEDULED')).statusCode).toBe(403);
    await Project.updateOne({ _id: pid }, { status: 'SCHEDULED' });
    expect((await transition(U.editor, pid, 'PUBLISHED')).statusCode).toBe(403);

    const final = await Project.findById(pid).lean();
    expect(final.status).toBe('SCHEDULED'); // only the DB writes above moved it
    expect(final.approvedVersionId == null).toBe(true);
  });

  test('reviewer approves through /transition: needs a version, then locks the latest one', async () => {
    const pid = await newProject(U.editor, 'reviewer-approve');
    await walk(U.editor, pid, TO_REVIEW);

    const noVersion = await transition(U.reviewer, pid, 'APPROVED');
    expect(noVersion.statusCode).toBe(400);
    expect(noVersion.body.error.code).toBe('no_version');

    const v1 = await request(app).post(`/api/v1/projects/${pid}/versions`).set(auth(U.editor)).send({ changeSummary: 'v1' });
    const v2 = await request(app).post(`/api/v1/projects/${pid}/versions`).set(auth(U.editor)).send({ changeSummary: 'v2' });
    expect(v1.statusCode).toBe(201);
    expect(v2.statusCode).toBe(201);

    const ok = await transition(U.reviewer, pid, 'APPROVED');
    expect(ok.statusCode).toBe(200);
    expect(ok.body.data.status).toBe('APPROVED');
    expect(String(ok.body.data.approvedVersionId)).toBe(v2.body.data._id);
    expect(String(ok.body.data.approvedBy)).toBe(U.reviewer.userId);

    // reviewer can't take the publisher's edges
    expect((await transition(U.reviewer, pid, 'SCHEDULED')).statusCode).toBe(403);

    // publisher schedules and publishes once there is an approved version
    expect((await transition(U.publisher, pid, 'SCHEDULED')).statusCode).toBe(200);
    const pub = await transition(U.publisher, pid, 'PUBLISHED');
    expect(pub.statusCode).toBe(200);
    expect(pub.body.data.status).toBe('PUBLISHED');
  });

  test('SCHEDULED and PUBLISHED need an approved version, even for a publisher', async () => {
    const pid = await newProject(U.editor, 'legacy-approved');
    await Project.updateOne({ _id: pid }, { status: 'APPROVED', approvedVersionId: null });
    const s = await transition(U.publisher, pid, 'SCHEDULED');
    expect(s.statusCode).toBe(400);
    expect(s.body.error.code).toBe('not_approved');

    // a dangling approvedVersionId (version gone / other project) doesn't count
    await Project.updateOne(
      { _id: pid },
      { status: 'SCHEDULED', approvedVersionId: new mongoose.Types.ObjectId() },
    );
    const p = await transition(U.publisher, pid, 'PUBLISHED');
    expect(p.statusCode).toBe(400);
    expect(p.body.error.code).toBe('not_approved');
  });

  test('admin keeps every edge; a member without the edge permission gets 403', async () => {
    const pid = await newProject(U.editor, 'admin-path');
    // publisher has no project.transition
    expect((await transition(U.publisher, pid, 'ASSIGNED')).statusCode).toBe(403);
    await walk(U.admin, pid, TO_REVIEW);
    await request(app).post(`/api/v1/projects/${pid}/versions`).set(auth(U.admin)).send({ changeSummary: 'v1' });
    await walk(U.admin, pid, ['APPROVED', 'SCHEDULED', 'PUBLISHED', 'CLOSED']);
  });

  test('reviewer can request a revision through /transition (project.revision)', async () => {
    const pid = await newProject(U.editor, 'revision-edge');
    await walk(U.editor, pid, TO_REVIEW);
    expect((await transition(U.reviewer, pid, 'REVISION_REQUESTED')).statusCode).toBe(200);
    // ...but not the editor's work edges
    expect((await transition(U.reviewer, pid, 'REVISION_IN_PROGRESS')).statusCode).toBe(403);
  });

  test('IDEA -> APPROVED_CONCEPT is a concept decision (concept.review)', async () => {
    const pid = await newProject(U.editor, 'concept-edge');
    expect((await transition(U.editor, pid, 'APPROVED_CONCEPT')).statusCode).toBe(403);
    expect((await transition(U.reviewer, pid, 'APPROVED_CONCEPT')).statusCode).toBe(200);
  });

  test('moves outside the lifecycle are still 400, outsiders still 404', async () => {
    const pid = await newProject(U.editor, 'invalid');
    const bad = await transition(U.admin, pid, 'PUBLISHED');
    expect(bad.statusCode).toBe(400);
    expect(bad.body.error.code).toBe('invalid_transition');
    const outsider = await user('outsider');
    expect((await transition(outsider, pid, 'ASSIGNED')).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('M2 concept approve / decline', () => {
  async function propose(u, title = 'An idea') {
    const r = await request(app)
      .post(`/api/v1/organizations/${orgId}/concepts`)
      .set(auth(u))
      .send({ title, description: 'desc' });
    expect(r.statusCode).toBe(201);
    return r.body.data.id;
  }
  const decide = (u, id, action) =>
    request(app).patch(`/api/v1/organizations/${orgId}/concepts/${id}/${action}`).set(auth(u)).send({});

  test('editor and publisher cannot approve or decline', async () => {
    const id = await propose(U.editor);
    for (const u of [U.editor, U.publisher]) {
      expect((await decide(u, id, 'approve')).statusCode).toBe(403);
      expect((await decide(u, id, 'decline')).statusCode).toBe(403);
    }
  });

  test("reviewer approves someone else's concept", async () => {
    const id = await propose(U.editor, 'Editor idea');
    const r = await decide(U.reviewer, id, 'approve');
    expect(r.statusCode).toBe(200);
    expect(r.body.data.projectId).toBeTruthy();
  });

  test('reviewer cannot approve their own concept (PoC), but can withdraw it', async () => {
    const id = await propose(U.reviewer, 'Reviewer idea');
    const r = await decide(U.reviewer, id, 'approve');
    expect(r.statusCode).toBe(403);
    expect(r.body.error.code).toBe('self_approval_forbidden');
    expect((await decide(U.reviewer, id, 'decline')).statusCode).toBe(200);
  });

  test('admin may approve their own concept (one-admin orgs are not blocked)', async () => {
    const id = await propose(U.admin, 'Admin idea');
    expect((await decide(U.admin, id, 'approve')).statusCode).toBe(200);
  });

  test('a decided concept cannot be declined; unknown concept is 404', async () => {
    const id = await propose(U.editor, 'Decided');
    expect((await decide(U.reviewer, id, 'approve')).statusCode).toBe(200);
    expect((await decide(U.reviewer, id, 'decline')).statusCode).toBe(409);
    expect((await decide(U.reviewer, new mongoose.Types.ObjectId(), 'decline')).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('L1 member update: validation + last-admin guard', () => {
  let org2;
  let a1;
  let a2;
  let m;
  const patch = (u, target, body, alias = false) =>
    request(app)
      .patch(
        alias
          ? `/api/v1/users/organizations/${org2}/members/${target.userId}`
          : `/api/v1/organizations/${org2}/members/${target.userId}`,
      )
      .set(auth(u))
      .send(body);

  beforeAll(async () => {
    a1 = await user('l1-admin1');
    const o = await request(app)
      .post('/api/v1/organizations')
      .set(auth(a1))
      .send({ name: 'L1 Org', slug: 'l1-org' });
    org2 = o.body.data._id;
    a2 = await user('l1-admin2');
    m = await user('l1-member');
    for (const [who, role] of [
      [a2, 'admin'],
      [m, 'editor'],
    ]) {
      const r = await request(app)
        .post(`/api/v1/organizations/${org2}/members`)
        .set(auth(a1))
        .send({ email: who.email, role });
      expect(r.statusCode).toBe(201);
    }
  });

  test.each([
    [{}],
    [{ role: 123 }],
    [{ role: 'Not A Role!' }],
    [{ disabled: 'yes' }],
    [{ disabled: 'true' }],
  ])('rejects %j with 400', async (body) => {
    const r = await patch(a1, m, body);
    expect(r.statusCode).toBe(400);
    expect(r.body.error.code).toBe('validation_error');
    const r2 = await patch(a1, m, body, true);
    expect(r2.statusCode).toBe(400);
  });

  test('unknown role name is 400 invalid_role', async () => {
    const r = await patch(a1, m, { role: 'overlord' });
    expect(r.statusCode).toBe(400);
    expect(r.body.error.code).toBe('invalid_role');
  });

  test('valid role change and disable still work', async () => {
    expect((await patch(a1, m, { role: 'reviewer' })).statusCode).toBe(200);
    expect((await patch(a1, m, { disabled: true }, true)).statusCode).toBe(200);
    expect((await patch(a1, m, { disabled: false, role: 'editor' })).statusCode).toBe(200);
    const doc = await Membership.findOne({ organizationId: org2, userId: m.userId }).lean();
    expect(doc).toMatchObject({ role: 'editor', disabled: false });
  });

  test('the last active admin cannot be demoted or disabled', async () => {
    // demote a2 -> a1 is the only admin left
    expect((await patch(a1, a2, { role: 'editor' })).statusCode).toBe(200);
    const demote = await patch(a1, a1, { role: 'editor' });
    expect(demote.statusCode).toBe(409);
    expect(demote.body.error.code).toBe('last_admin');
    const disable = await patch(a1, a1, { disabled: true }, true);
    expect(disable.statusCode).toBe(409);
    const doc = await Membership.findOne({ organizationId: org2, userId: a1.userId }).lean();
    expect(doc).toMatchObject({ role: 'admin', disabled: false }); // rolled back
    // a disabled admin doesn't count as the backup
    expect((await patch(a1, a2, { role: 'admin', disabled: true })).statusCode).toBe(200);
    expect((await patch(a1, a1, { role: 'editor' })).statusCode).toBe(409);
  });

  test('concurrent demotion of the last two admins leaves at least one admin', async () => {
    expect((await patch(a1, a2, { disabled: false })).statusCode).toBe(200); // two active admins
    const [r1, r2] = await Promise.all([
      patch(a1, a2, { role: 'editor' }),
      patch(a1, a1, { role: 'editor' }),
    ]);
    // Depending on interleaving the loser gets 409 (guard) or 403 (already demoted).
    expect(r1.statusCode === 200 && r2.statusCode === 200).toBe(false);
    const admins = await Membership.countDocuments({ organizationId: org2, role: 'admin', disabled: { $ne: true } });
    expect(admins).toBeGreaterThanOrEqual(1);
  });

  test('a non-admin cannot update members at all', async () => {
    expect((await patch(m, a1, { role: 'editor' })).statusCode).toBe(403);
  });
});
