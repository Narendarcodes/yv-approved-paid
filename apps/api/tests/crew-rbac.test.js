/**
 * Strict role-based access for the crew 'editor' role (demo Leo): every
 * brand-only capability is refused by the API, not only hidden in the web.
 * Admin ('*', demo Nora) keeps everything.
 *
 *   invoices / contracts   editor reads only what they created (invoice.view /
 *                          contract.view); every write needs *.manage (admin)
 *   project.assign         admin only
 */
const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const { seedDefaultRoles, DEFAULT_ROLES } = require('../src/seed/roles');
const Invoice = require('../src/models/invoice.model');
const Contract = require('../src/models/contract.model');

const PASSWORD = 'P@ssw0rd-crew-rbac';
const auth = (u) => ({ Authorization: `Bearer ${u.token}` });
const U = {};
let orgId;
let projectId;
const O = (p = '') => `/api/v1/organizations/${orgId}${p}`;

async function user(key, role) {
  const email = `${key}@crew-rbac.example.com`;
  await request(app).post('/api/v1/auth/register').send({ name: key, email, password: PASSWORD });
  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  const out = { token: login.body.data.accessToken, userId: login.body.data.user._id, email };
  if (role) {
    const add = await request(app).post(O('/members')).set(auth(U.admin)).send({ email, role });
    expect(add.statusCode).toBe(201);
  }
  return out;
}

const ids = {};

beforeAll(async () => {
  await require('../src/db/mongo').connect();
  await seedDefaultRoles();
  U.admin = await user('nora');
  const org = await request(app)
    .post('/api/v1/organizations')
    .set(auth(U.admin))
    .send({ name: 'Crew RBAC', slug: 'crew-rbac' });
  orgId = org.body.data._id;
  U.editor = await user('leo', 'editor');
  U.editor2 = await user('maya', 'editor');
  const p = await request(app)
    .post('/api/v1/projects')
    .set(auth(U.admin))
    .send({ organizationId: orgId, title: 'Crew reel' });
  projectId = p.body.data._id;

  // the admin's records, and one record each crew member created (e.g. before a role change)
  const adminInv = await request(app)
    .post(O('/invoices'))
    .set(auth(U.admin))
    .send({ number: 'INV-ADMIN', amount: 900, currency: 'USD' });
  expect(adminInv.statusCode).toBe(201);
  ids.adminInvoice = adminInv.body.data._id;
  await request(app)
    .post(O(`/invoices/${ids.adminInvoice}/send`))
    .set(auth(U.admin))
    .expect(200);
  const adminCon = await request(app)
    .post(O('/contracts'))
    .set(auth(U.admin))
    .send({ title: 'Brand agreement', amount: 900, currency: 'USD', terms: 'x' });
  expect(adminCon.statusCode).toBe(201);
  ids.adminContract = adminCon.body.data._id;

  const own = await Invoice.create({
    organizationId: orgId,
    number: 'INV-LEO',
    amount: 120,
    currency: 'USD',
    status: 'sent',
    createdBy: U.editor.userId,
  });
  ids.leoInvoice = String(own._id);
  const mayaInv = await Invoice.create({
    organizationId: orgId,
    number: 'INV-MAYA',
    amount: 80,
    currency: 'USD',
    createdBy: U.editor2.userId,
  });
  ids.mayaInvoice = String(mayaInv._id);
  const ownCon = await Contract.create({
    organizationId: orgId,
    title: 'Leo crew agreement',
    amount: 120,
    currency: 'USD',
    createdBy: U.editor.userId,
  });
  ids.leoContract = String(ownCon._id);
});

afterAll(async () => {
  await mongoose.disconnect();
});

describe('role seeds', () => {
  test('editor holds no brand-only grant; deal.manage stays for crew deal paths', () => {
    const editor = DEFAULT_ROLES.find((r) => r.name === 'editor').permissions;
    for (const p of [
      'project.assign',
      'project.approve',
      'project.schedule',
      'project.publish',
      'invoice.manage',
      'contract.manage',
      'manage_members',
      'payables.view_org',
      '*',
    ])
      expect(editor).not.toContain(p);
    expect(editor).toEqual(
      expect.arrayContaining(['invoice.view', 'contract.view', 'deal.manage']),
    );
  });

  test('no non-admin role holds invoice/contract writes, members, assign or the org payables board', () => {
    for (const r of DEFAULT_ROLES.filter((x) => x.name !== 'admin')) {
      for (const p of [
        'invoice.manage',
        'contract.manage',
        'manage_members',
        'project.assign',
        'payables.view_org',
        '*',
      ])
        expect([r.name, r.permissions.includes(p)]).toEqual([r.name, false]);
    }
  });
});

describe('invoices: editor reads own only, writes refused', () => {
  test('list shows only the invoices the editor created', async () => {
    const r = await request(app).get(O('/invoices')).set(auth(U.editor)).expect(200);
    expect(r.body.data.items.map((i) => i.number)).toEqual(['INV-LEO']);
    expect(r.body.data.total).toBe(1);
    const a = await request(app).get(O('/invoices')).set(auth(U.admin)).expect(200);
    expect(a.body.data.total).toBe(3);
  });

  test('another member’s invoice answers 404; own answers 200', async () => {
    await request(app)
      .get(O(`/invoices/${ids.leoInvoice}`))
      .set(auth(U.editor))
      .expect(200);
    for (const id of [ids.adminInvoice, ids.mayaInvoice])
      await request(app)
        .get(O(`/invoices/${id}`))
        .set(auth(U.editor))
        .expect(404);
  });

  test('outstanding sums only the editor’s own invoices', async () => {
    const r = await request(app).get(O('/invoices/outstanding')).set(auth(U.editor)).expect(200);
    expect(r.body.data.totalOutstanding).toBe(120);
    const a = await request(app).get(O('/invoices/outstanding')).set(auth(U.admin)).expect(200);
    expect(a.body.data.totalOutstanding).toBe(1020);
  });

  test('create, edit, send, pay and void are 403 for the editor, even on their own invoice', async () => {
    const writes = [
      ['post', O('/invoices'), { number: 'INV-X', amount: 1, currency: 'USD' }],
      ['patch', O(`/invoices/${ids.leoInvoice}`), { amount: 999 }],
      ['post', O(`/invoices/${ids.leoInvoice}/send`), {}],
      ['post', O(`/invoices/${ids.leoInvoice}/pay`), { paymentMethod: 'cash' }],
      ['post', O(`/invoices/${ids.leoInvoice}/void`), {}],
      ['post', O(`/invoices/${ids.adminInvoice}/pay`), { paymentMethod: 'cash' }],
    ];
    for (const [m, url, body] of writes) {
      const r = await request(app)[m](url).set(auth(U.editor)).send(body);
      expect([m, url, r.statusCode]).toEqual([m, url, 403]);
    }
    expect((await Invoice.findById(ids.leoInvoice)).amount).toBe(120);
    expect((await Invoice.findById(ids.adminInvoice)).status).toBe('sent');
  });
});

describe('contracts: editor reads own only, writes refused', () => {
  test('list and detail are scoped to createdBy = self', async () => {
    const r = await request(app).get(O('/contracts')).set(auth(U.editor)).expect(200);
    expect(r.body.data.items.map((c) => c.title)).toEqual(['Leo crew agreement']);
    await request(app)
      .get(O(`/contracts/${ids.leoContract}`))
      .set(auth(U.editor))
      .expect(200);
    await request(app)
      .get(O(`/contracts/${ids.adminContract}`))
      .set(auth(U.editor))
      .expect(404);
    const a = await request(app).get(O('/contracts')).set(auth(U.admin)).expect(200);
    expect(a.body.data.total).toBe(2);
  });

  test('create, edit, send, view and sign are 403 for the editor', async () => {
    const writes = [
      ['post', O('/contracts'), { title: 'x', amount: 1, currency: 'USD', terms: 'x' }],
      ['patch', O(`/contracts/${ids.leoContract}`), { title: 'changed' }],
      ['post', O(`/contracts/${ids.adminContract}/send`), {}],
      ['post', O(`/contracts/${ids.adminContract}/view`), {}],
      ['post', O(`/contracts/${ids.adminContract}/sign`), { signerName: 'Leo' }],
    ];
    for (const [m, url, body] of writes) {
      const r = await request(app)[m](url).set(auth(U.editor)).send(body);
      expect([m, url, r.statusCode]).toEqual([m, url, 403]);
    }
    expect((await Contract.findById(ids.leoContract)).title).toBe('Leo crew agreement');
  });
});

describe('projects: assignment is brand-only', () => {
  test('the editor cannot assign a project (403)', async () => {
    const r = await request(app)
      .post(`/api/v1/projects/${projectId}/assign`)
      .set(auth(U.editor))
      .send({ assigneeId: U.editor.userId });
    expect(r.statusCode).toBe(403);
  });
});
