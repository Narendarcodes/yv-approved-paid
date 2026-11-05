/**
 * The judge demo seed (Phase 4 gap 4): "Diwali launch reels" on the mock gateway,
 * with every state from docs/phase4-ui-plan.md section 6, built through the deal
 * service (policy, ledger, lock). Idempotent: a second run rebuilds the same deal.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mongoose = require('mongoose');
const { configureDeals, dealService } = require('../service.cts');
const { makeMockGateway, makeSandboxGateway } = require('../paypal.cts');
const { DEMO, seedDealDemo, ensureEvidenceFrames } = require('../demo.cts');

let dir;
let seeded;

const ms = (d, k) => d.milestones.find((m) => m.key === k);

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yv-demo-evidence-'));
  await require('../../../db/mongo').connect();
  configureDeals({ gateway: makeMockGateway() });
  seeded = await seedDealDemo({ evidenceDir: dir });
});
afterAll(async () => {
  fs.rmSync(dir, { recursive: true, force: true });
  await mongoose.disconnect();
});

describe('seed-deal-demo', () => {
  test('fixed deal id, signed by both sides, both reels held on PayPal', async () => {
    expect(seeded.dealId).toBe(DEMO.dealId);
    const d = await dealService().get(DEMO.dealId, seeded.orgId);
    expect(d.terms.title).toBe('Diwali launch reels');
    expect(d.signatures).toHaveLength(2);
    expect(ms(d, 'reel1').funding.authorizationId).toBeTruthy();
    expect(ms(d, 'reel2').funding.authorizationId).toBeTruthy();
  });

  test('reel1: v1 fails loudness at -20.1 LUFS with evidence; review merge Fix/Taste; v2 passes; $400 captured and paid 70/30', async () => {
    const d = await dealService().get(DEMO.dealId, seeded.orgId);
    const m = ms(d, 'reel1');
    const [v1, v2] = m.versions;
    expect(v1.checks.passed).toBe(false);
    const loud = v1.checks.results.find((r) => r.checklistId === 'loud');
    expect(loud).toMatchObject({ measured: -20.1, passed: false });
    expect(loud.evidence[0].screenshot).toMatch(/^loud_v1_\d{3}\.\d{2}\.png$/);
    expect(fs.existsSync(path.join(dir, DEMO.dealId, loud.evidence[0].screenshot))).toBe(true);

    expect(m.proposals.review.items.map((i) => [i.text, i.tag])).toEqual([
      ['too quiet', 'fix'],
      ['make it more festive', 'taste'],
    ]);
    expect(m.proposals.review.items[0].checklistId).toBe('loud');
    expect(m.changeRequests).toHaveLength(1);

    expect(v2.checks.passed).toBe(true);
    expect(m.approvedVersionId).toBe('v2');
    expect(m.state).toBe('PAID_OUT');
    expect(m.capturedMinor).toBe(40000);
    expect(m.payouts.map((p) => [p.email, p.amountMinor])).toEqual([
      [DEMO.editor.paypal, 28000],
      [DEMO.motion.paypal, 12000],
    ]);
  });

  test('the ledger verifies and carries the blocked $450 (P3_amount) and old-version (P6_version) attempts, no money moved', async () => {
    const l = await dealService().ledgerOf(DEMO.dealId, seeded.orgId);
    expect(l.chain.ok).toBe(true);
    const blocked = l.entries.filter((e) => e.type === 'blocked');
    expect(blocked).toHaveLength(2);
    expect(blocked.every((e) => e.moved === false)).toBe(true);
    expect(blocked[0]).toMatchObject({ amountMinor: 45000 });
    expect(blocked[0].policy.violations.map((v) => v.rule)).toContain('P3_amount');
    expect(blocked[1].policy.violations.map((v) => v.rule)).toContain('P6_version');
    expect(l.entries.filter((e) => e.type === 'invoice')).toEqual([]);
    const captured = l.entries.filter((e) => e.moved && /capture/.test(e.type)).reduce((a, e) => a + e.amountMinor, 0);
    expect(captured).toBe(40000);
  });

  test('reel2: 4 of 5 checks -> dispute -> 80% proposed from checklist arithmetic, editor accepted, client tap left', async () => {
    const d = await dealService().get(DEMO.dealId, seeded.orgId);
    const m = ms(d, 'reel2');
    expect(m.state).toBe('DISPUTED');
    expect(m.proposals.dispute).toMatchObject({
      basis: { passedChecks: 4, totalChecks: 5, shareBp: 8000 },
      workerMinor: 24000,
      clientMinor: 6000,
      decision: { allowed: true },
    });
    expect(m.split).toEqual({ worker: 24000 });
  });

  test('reel2: a $60 change order waits as a draft; the judge tap accepts it and drafts the PayPal invoice', async () => {
    const d = await dealService().get(DEMO.dealId, seeded.orgId);
    expect(d.changeOrders).toEqual([
      expect.objectContaining({ milestoneKey: 'reel2', rateCardItemId: 'extra_cut', quantity: 1, amountMinor: 6000, status: 'draft' }),
    ]);
    const r = await dealService().decideChangeOrder(DEMO.dealId, seeded.orgId, seeded.judge.userId, d.changeOrders[0].id, true);
    expect(r.out).toMatchObject({ outcome: 'done' });
    const after = await dealService().get(DEMO.dealId, seeded.orgId);
    expect(after.changeOrders[0]).toMatchObject({ status: 'invoiced', invoiceId: expect.any(String) });
    const l = await dealService().ledgerOf(DEMO.dealId, seeded.orgId);
    expect(l.chain.ok).toBe(true);
    expect(l.entries.filter((e) => e.type === 'invoice')).toEqual([expect.objectContaining({ amountMinor: 6000, moved: false })]);
    await seedDealDemo({ evidenceDir: false }); // back to the judge's starting state
  });

  test('ensureEvidenceFrames rewrites every missing frame from the stored results (restart on ephemeral disk)', async () => {
    const d = await dealService().get(DEMO.dealId, seeded.orgId);
    const cold = fs.mkdtempSync(path.join(os.tmpdir(), 'yv-demo-cold-'));
    try {
      const wrote = ensureEvidenceFrames(d, cold);
      expect(wrote).toBeGreaterThanOrEqual(11);
      const files = fs.readdirSync(path.join(cold, DEMO.dealId));
      expect(files).toHaveLength(wrote);
      const loud = files.find((f) => /^loud_v1_/.test(f));
      expect(fs.readFileSync(path.join(cold, DEMO.dealId, loud)).subarray(1, 4).toString()).toBe('PNG');
      expect(ensureEvidenceFrames(d, cold)).toBe(0); // nothing missing now
      expect(ensureEvidenceFrames(null, cold)).toBe(0);
      expect(ensureEvidenceFrames(d, false)).toBe(0);
    } finally {
      fs.rmSync(cold, { recursive: true, force: true });
    }
  });

  test('idempotent: a second run rebuilds the same deal with the same ledger shape', async () => {
    const before = await dealService().ledgerOf(DEMO.dealId, seeded.orgId);
    const again = await seedDealDemo({ evidenceDir: false });
    expect(again).toMatchObject({ orgId: seeded.orgId, dealId: DEMO.dealId, judge: { userId: seeded.judge.userId } });
    const after = await dealService().ledgerOf(DEMO.dealId, seeded.orgId);
    expect(after.chain.ok).toBe(true);
    expect(after.entries.map((e) => e.type)).toEqual(before.entries.map((e) => e.type));
    expect(after.totals).toEqual(before.totals);
  });

  test('team: Ravi 70% / motion designer 30% on reel1; an unsigned team draft; two demo projects with assignees', async () => {
    const Project = require('../../../models/project.model');
    const Task = require('../../../models/task.model');
    const d = await dealService().get(DEMO.dealId, seeded.orgId);
    const reel1 = d.terms.milestones.find((m) => m.key === 'reel1');
    expect(reel1.payees.map((p) => [p.userId, p.shareBp])).toEqual([
      [seeded.editor.userId, 7000],
      [expect.any(String), 3000],
    ]);
    const draft = await dealService().get(DEMO.teamDealId, seeded.orgId);
    expect(draft.termsHash).toBeUndefined();
    expect(draft.signatures).toEqual([]);
    expect(draft.terms.client.userId).toBe(seeded.judge.userId);
    expect(draft.terms.milestones[0].payees.map((p) => p.shareBp)).toEqual([7000, 3000]);
    const projects = await Project.find({ organizationId: seeded.orgId, assignee: { $ne: null } }).lean();
    expect(projects.length).toBeGreaterThanOrEqual(2);
    expect(await Task.countDocuments({ organizationId: seeded.orgId, assignee: { $ne: null } })).toBeGreaterThanOrEqual(2);
    // a re-seed neither duplicates the projects nor overwrites a reassignment
    await Project.updateOne({ _id: projects[0]._id }, { $set: { assignee: seeded.judge.userId } });
    await seedDealDemo({ evidenceDir: false });
    expect(await Project.countDocuments({ organizationId: seeded.orgId })).toBe(projects.length);
    expect(String((await Project.findById(projects[0]._id).lean()).assignee)).toBe(seeded.judge.userId);
    expect((await dealService().get(DEMO.teamDealId, seeded.orgId)).signatures).toEqual([]);
  });

  test('refuses to run on a real PayPal gateway', async () => {
    const real = makeMockGateway();
    real.name = 'sandbox';
    configureDeals({ gateway: real });
    await expect(seedDealDemo({ evidenceDir: false })).rejects.toThrow(/PAYPAL_MODE=mock, or PAYPAL_MODE=sandbox with DEMO_MODE=1/);
    configureDeals({ gateway: makeSandboxGateway({ clientId: 'id', clientSecret: 's', fetchImpl: async () => ({ ok: false, status: 500, text: async () => '' }) }) });
    await expect(seedDealDemo({ evidenceDir: false })).rejects.toThrow(/DEMO_MODE=1/); // sandbox without simulated approval
    configureDeals({ gateway: makeMockGateway() });
  });

  test('PAYPAL_MODE=sandbox: real order and INV2 invoice ids; simulated buyer approval is labelled, never passed off as real', async () => {
    let n = 0;
    const reply = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body), json: async () => body });
    const fetchImpl = async (url, init = {}) => {
      const key = `${init.method || 'GET'} ${new URL(url).pathname}`;
      if (key === 'POST /v1/oauth2/token') return reply(200, { access_token: 'tok', expires_in: 32400 });
      if (key === 'POST /v2/checkout/orders') return reply(201, { id: `5O190127TN36471${String(++n).padStart(2, '0')}`, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow' }] });
      if (key === 'POST /v1/payments/payouts') return reply(403, { name: 'PAYOUT_NOT_AVAILABLE', message: 'You live in a country that is not allowed to send this payout.' });
      if (key === 'POST /v2/invoicing/invoices') return reply(201, { id: 'INV2-AB12-CD34-EF56-GH78', status: 'DRAFT' });
      if (/^POST \/v2\/invoicing\/invoices\/.+\/send$/.test(key)) return reply(200, { href: 'https://www.sandbox.paypal.com/invoice/p/#INV2-AB12-CD34-EF56-GH78' });
      throw new Error(`unexpected PayPal call ${key}`);
    };
    configureDeals({ gateway: makeSandboxGateway({ clientId: 'id', clientSecret: 's', fetchImpl, simulate: true }) });
    try {
      const r = await seedDealDemo({ evidenceDir: false });
      const d = await dealService().get(DEMO.dealId, r.orgId);
      for (const key of ['reel1', 'reel2']) {
        const f = ms(d, key).funding;
        expect(f.orderId).toMatch(/^5O190127TN36471\d\d$/);
        expect(f.authorizationId).toBe(`SIM-AUTH-${f.orderId}`);
      }
      expect(ms(d, 'reel1').state).toBe('PAID_OUT');
      expect(ms(d, 'reel1').captures[0].id).toMatch(/^SIM-CAPTURE-/);
      expect(ms(d, 'reel1').payouts.every((p) => /^SIM-PAYOUT-/.test(p.batchId))).toBe(true);
      const accepted = await dealService().decideChangeOrder(DEMO.dealId, r.orgId, r.judge.userId, d.changeOrders[0].id, true);
      expect(accepted.out).toMatchObject({ outcome: 'done' });
      const after = await dealService().get(DEMO.dealId, r.orgId);
      expect(after.changeOrders[0]).toMatchObject({ status: 'invoiced', invoiceId: 'INV2-AB12-CD34-EF56-GH78' });
      const l = await dealService().ledgerOf(DEMO.dealId, r.orgId);
      expect(l.chain.ok).toBe(true);
      const moved = l.entries.filter((e) => ['authorize', 'capture', 'payout'].includes(e.type));
      expect(moved.length).toBeGreaterThan(0);
      for (const e of moved) expect(e.explanation).toMatch(/PayPal sandbox/);
      expect(l.entries.find((e) => e.type === 'authorize').explanation).toMatch(/PayPal sandbox: buyer approval simulated/);
      const inv = l.entries.find((e) => e.type === 'invoice');
      expect(inv).toMatchObject({ paypalRef: 'INV2-AB12-CD34-EF56-GH78' });
      expect(inv.explanation).toMatch(/^Created and sent a PayPal invoice/);
      expect(inv.explanation).not.toMatch(/simulated/);
    } finally {
      configureDeals({ gateway: makeMockGateway() });
      await seedDealDemo({ evidenceDir: false });
    }
  });
});
