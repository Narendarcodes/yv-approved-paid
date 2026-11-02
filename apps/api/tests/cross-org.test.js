/**
 * Cross-org isolation matrix (ADR-0015, Phase 1 item 3).
 *
 * Every route that addresses an org-owned resource is enumerated FROM THE
 * ROUTERS THEMSELVES (Express route table), so a route added later is covered
 * automatically. For each one, a user of org B (an admin there, '*'
 * permissions) calls it with org A's ids and must get 404 - not 200, and not
 * 403, which would confirm the record exists. Each route is called twice:
 * plainly, and with org B's id smuggled in as ?organizationId= and in the body
 * (the original IDOR vector).
 */
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const Role = require('../src/models/role.model');
const ProjectVersion = require('../src/models/projectVersion.model');
const Comment = require('../src/models/comment.model');
const Task = require('../src/models/task.model');
const Input = require('../src/models/input.model');
const RevisionRequest = require('../src/models/revisionRequest.model');
const Channel = require('../src/models/channel.model');
const ChatMessage = require('../src/models/chatMessage.model');
const Brief = require('../src/models/brief.model');
const ActivityEvent = require('../src/models/activityEvent.model');
const Contract = require('../src/models/contract.model');
const Invoice = require('../src/models/invoice.model');
const Concept = require('../src/models/concept.model');
const SocialChannel = require('../src/models/socialChannel.model');
const Publication = require('../src/models/publication.model');
const Notification = require('../src/models/notification.model');
const { Post, AgentJob } = require('../src/models/agent');

const API = '/api/v1';

// Routers mounted under an org- or project-addressed prefix (see src/app.js).
const MOUNTS = [
  { prefix: `${API}/projects`, file: 'projects' },
  { prefix: `${API}/organizations`, file: 'organizations' },
  { prefix: `${API}/organizations/:organizationId/concepts`, file: 'concepts' },
  { prefix: `${API}/organizations`, file: 'contracts' },
  { prefix: `${API}/organizations`, file: 'invoices' },
  { prefix: `${API}/organizations`, file: 'scheduling' },
  { prefix: `${API}/organizations`, file: 'analytics' },
  { prefix: `${API}/organizations`, file: 'agent' },
  { prefix: `${API}/users`, file: 'users' },
  { prefix: `${API}/organizations/:organizationId/deals`, file: 'deals' },
];

// Routes that are not about one org's records.
const NOT_ORG_OWNED = new Set([
  `GET ${API}/organizations/availability`, // public slug check
  `POST ${API}/organizations`, // create your own org
  `GET ${API}/organizations`, // list your own orgs
  `GET ${API}/users/me`,
  `GET ${API}/users/me/organizations`,
  `PATCH ${API}/users/me`,
  `PATCH ${API}/users/me/photo`,
  `DELETE ${API}/users/me/photo`,
  `GET ${API}/users/:userId/photo`,
  // org chosen by a body/query selector: covered by 'list/create by org selector' below
  `POST ${API}/projects`,
  `GET ${API}/projects`, // own check: shares-an-org (tests/uploads-auth.test.js)
]);

function routesOf({ prefix, file }) {
  const router =
    file === 'deals'
      ? require('../src/modules/deals/http.cts').router
      : require(`../src/routes/${file}`);
  const out = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const p = layer.route.path === '/' ? prefix : `${prefix}${layer.route.path}`;
    for (const m of Object.keys(layer.route.methods))
      out.push({ method: m.toUpperCase(), path: p });
  }
  return out;
}

const A = {};
const B = {};

async function registerAndLogin(name, email) {
  await request(app).post(`${API}/auth/register`).send({ name, email, password: 'P@ssw0rd!' });
  const login = await request(app).post(`${API}/auth/login`).send({ email, password: 'P@ssw0rd!' });
  return {
    token: login.body.data.accessToken,
    userId: String(login.body.data.user._id || login.body.data.user.id),
  };
}

beforeAll(async () => {
  await require('../src/db/mongo').connect();
  await Role.create({ name: 'admin', permissions: ['*'] });

  Object.assign(A, await registerAndLogin('Alice', 'alice@orga.example.com'));
  Object.assign(B, await registerAndLogin('Bob', 'bob@orgb.example.com'));
  const orgA = await request(app)
    .post(`${API}/organizations`)
    .set('Authorization', `Bearer ${A.token}`)
    .send({ name: 'Org A', slug: 'org-a' });
  const orgB = await request(app)
    .post(`${API}/organizations`)
    .set('Authorization', `Bearer ${B.token}`)
    .send({ name: 'Org B', slug: 'org-b' });
  A.orgId = String(orgA.body.data._id);
  B.orgId = String(orgB.body.data._id);

  const proj = await request(app)
    .post(`${API}/projects`)
    .set('Authorization', `Bearer ${A.token}`)
    .send({ organizationId: A.orgId, title: 'A secret project' });
  expect(proj.status).toBe(201);
  A.projectId = String(proj.body.data._id);

  const org = A.orgId;
  const projectId = A.projectId;
  const version = await ProjectVersion.create({
    organizationId: org,
    projectId,
    versionNumber: 1,
    uploader: A.userId,
    files: [
      {
        filename: 'cut.mp4',
        mimeType: 'video/mp4',
        size: 3,
        storageRef: 'nope.mp4',
        uploadedBy: A.userId,
      },
    ],
  });
  A.versionId = String(version._id);
  A.fileId = String(version.files[0]._id);
  A.commentId = String(
    (await Comment.create({ organizationId: org, projectId, author: A.userId, body: 'A only' }))
      ._id,
  );
  A.taskId = String(
    (await Task.create({ organizationId: org, projectId, title: 'A task', createdBy: A.userId }))
      ._id,
  );
  A.inputId = String(
    (
      await Input.create({
        organizationId: org,
        projectId,
        title: 'A input',
        requestedBy: A.userId,
      })
    )._id,
  );
  A.revisionId = String(
    (
      await RevisionRequest.create({
        organizationId: org,
        projectId,
        revisionNumber: 1,
        reason: 'x',
        requester: A.userId,
      })
    )._id,
  );
  const channel = await Channel.create({
    organizationId: org,
    projectId,
    name: 'a-chat',
    createdBy: A.userId,
  });
  A.channelId = String(channel._id);
  await ChatMessage.create({
    organizationId: org,
    projectId,
    channelId: channel._id,
    author: A.userId,
    body: 'A message',
  });
  await Brief.create({ organizationId: org, projectId, goal: 'A goal', submittedBy: A.userId });
  await ActivityEvent.create({
    organizationId: org,
    projectId,
    actor: A.userId,
    action: 'created',
  });
  A.contractId = String(
    (await Contract.create({ organizationId: org, title: 'A contract', amount: 1 }))._id,
  );
  A.invoiceId = String(
    (await Invoice.create({ organizationId: org, number: 'A-1', amount: 1 }))._id,
  );
  A.conceptId = String(
    (
      await Concept.create({
        organizationId: org,
        title: 'A concept',
        description: 'd',
        proposer: A.userId,
      })
    )._id,
  );
  A.socialChannelId = String(
    (
      await SocialChannel.create({
        organizationId: org,
        platform: 'x',
        name: 'A',
        handle: 'a',
        mode: 'demo',
      })
    )._id,
  );
  A.publicationId = String(
    (
      await Publication.create({
        organizationId: org,
        projectId,
        platform: 'x',
        status: 'scheduled',
        provider: 'local',
      })
    )._id,
  );
  A.postId = String(
    (await Post.create({ organizationId: org, platform: 'youtube', title: 'A post' }))._id,
  );
  A.jobId = 'job-a-1';
  await AgentJob.create({
    jobId: A.jobId,
    organizationId: org,
    type: 'brand.index.v1',
    status: 'queued',
  });
  A.dealId = 'deal_orgA';
  await mongoose.model('Deal').create({
    _id: A.dealId,
    orgId: A.orgId,
    clientUserId: A.userId,
    workerUserId: 'someone',
    title: 'A deal',
    doc: { id: A.dealId, orgId: A.orgId, terms: { title: 'A deal' }, milestones: [] },
  });
  A.notificationId = String(
    (await Notification.create({ userId: A.userId, type: 'comment_added', title: 'for A' }))._id,
  );
});

afterAll(async () => {
  await mongoose.disconnect();
});

const PARAMS = () => ({
  organizationId: A.orgId,
  id: A.projectId,
  projectId: A.projectId,
  versionId: A.versionId,
  fileId: A.fileId,
  commentId: A.commentId,
  taskId: A.taskId,
  inputId: A.inputId,
  revisionId: A.revisionId,
  channelId: A.channelId,
  contractId: A.contractId,
  invoiceId: A.invoiceId,
  conceptId: A.conceptId,
  memberUserId: A.userId,
  postId: A.postId,
  jobId: A.jobId,
  dealId: A.dealId,
  coId: 'co_orgA',
  key: 'm1',
  approvalKey: 'capture:x:m1',
  file: 'loud_000.00.jpg',
});

function fill(p) {
  const params = PARAMS();
  return p.replace(/:(\w+)/g, (_, name) => {
    if (!(name in params))
      throw new Error(`cross-org matrix: no org-A value for :${name} in ${p}; add it to PARAMS`);
    // scheduling uses :channelId for SocialChannel and :postId for Publication
    if (p.includes('/scheduling/') && name === 'channelId') return A.socialChannelId;
    if (p.includes('/scheduling/') && name === 'postId') return A.publicationId;
    return params[name];
  });
}

const MATRIX = MOUNTS.flatMap(routesOf).filter((r) => !NOT_ORG_OWNED.has(`${r.method} ${r.path}`));

describe('route table coverage', () => {
  test('every router mounted under /projects or /organizations is in the matrix', () => {
    const appSrc = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
    const mounted = [
      ...appSrc.matchAll(
        /app\.use\(`\$\{config\.apiPrefix\}\/(projects|organizations|users)[^`]*`,\s*(?:require\('\.\/routes\/(\w+)'\)|(\w+))/g,
      ),
    ];
    const varToFile = {
      projectsRouter: 'projects',
      orgRouter: 'organizations',
      contractsRouter: 'contracts',
      invoicesRouter: 'invoices',
      schedulingRouter: 'scheduling',
      usersRouter: 'users',
      deals: 'deals',
    };
    const files = mounted.map((m) => m[2] || varToFile[m[3]]);
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const f of files) expect(MOUNTS.map((x) => x.file)).toContain(f);
  });

  test('the matrix is not empty and covers project sub-resources', () => {
    expect(MATRIX.length).toBeGreaterThan(60);
    expect(MATRIX.some((r) => r.path.endsWith('/projects/:id/comments'))).toBe(true);
  });
});

describe('user of org B gets 404 on every org-A route', () => {
  test.each(MATRIX.map((r) => [`${r.method} ${r.path}`, r]))('%s', async (_name, r) => {
    const url = fill(r.path);
    const call = (u) =>
      request(app)[r.method.toLowerCase()](u).set('Authorization', `Bearer ${B.token}`);
    const plain = await call(url).send({ title: 'x', body: 'x', name: 'x', status: 'todo' });
    expect([plain.status, r.method, url]).toEqual([404, r.method, url]);
    // Spoofed org selector: B names its own org. Must still be 404.
    const sep = url.includes('?') ? '&' : '?';
    const spoof = await call(`${url}${sep}organizationId=${B.orgId}`).send({
      organizationId: B.orgId,
      title: 'x',
      body: 'x',
    });
    expect([spoof.status, r.method, url]).toEqual([404, r.method, url]);
  });

  test('list/create by org selector: B naming org A gets 404', async () => {
    const list = await request(app)
      .get(`${API}/projects?organizationId=${A.orgId}`)
      .set('Authorization', `Bearer ${B.token}`);
    expect(list.status).toBe(404);
    const create = await request(app)
      .post(`${API}/projects`)
      .set('Authorization', `Bearer ${B.token}`)
      .send({ organizationId: A.orgId, title: 'planted' });
    expect(create.status).toBe(404);
  });

  test("B cannot read or mark A's notification", async () => {
    const r = await request(app)
      .patch(`${API}/notifications/${A.notificationId}/read`)
      .set('Authorization', `Bearer ${B.token}`);
    expect(r.status).toBe(404);
    const list = await request(app)
      .get(`${API}/notifications`)
      .set('Authorization', `Bearer ${B.token}`);
    expect(list.body.data.map((n) => String(n._id || n.id))).not.toContain(A.notificationId);
  });

  test("calendar ?projectId= filter cannot reach another org's posts", async () => {
    const r = await request(app)
      .get(`${API}/organizations/${B.orgId}/scheduling/posts?projectId=${A.projectId}`)
      .set('Authorization', `Bearer ${B.token}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(0);
  });
});

describe('positive control: org A reads its own records', () => {
  test.each([
    'comments',
    'tasks',
    'inputs',
    'revisions',
    'channels',
    'brief',
    'activity',
    'versions',
  ])('GET /projects/:id/%s -> 200', async (sub) => {
    const r = await request(app)
      .get(`${API}/projects/${A.projectId}/${sub}`)
      .set('Authorization', `Bearer ${A.token}`);
    expect(r.status).toBe(200);
  });

  test('org selector only picks among memberships: A naming org B is 404', async () => {
    const r = await request(app)
      .get(`${API}/projects?organizationId=${B.orgId}`)
      .set('Authorization', `Bearer ${A.token}`);
    expect(r.status).toBe(404);
  });
});
