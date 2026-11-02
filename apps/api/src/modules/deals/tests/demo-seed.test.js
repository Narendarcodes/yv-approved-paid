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
const { makeMockGateway } = require('../paypal.cts');
const { DEMO, seedDealDemo } = require('../demo.cts');

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

  test('idempotent: a second run rebuilds the same deal with the same ledger shape', async () => {
    const before = await dealService().ledgerOf(DEMO.dealId, seeded.orgId);
    const again = await seedDealDemo({ evidenceDir: false });
    expect(again).toMatchObject({ orgId: seeded.orgId, dealId: DEMO.dealId, judge: { userId: seeded.judge.userId } });
    const after = await dealService().ledgerOf(DEMO.dealId, seeded.orgId);
    expect(after.chain.ok).toBe(true);
    expect(after.entries.map((e) => e.type)).toEqual(before.entries.map((e) => e.type));
    expect(after.totals).toEqual(before.totals);
  });

  test('refuses to run on a real PayPal gateway', async () => {
    const real = makeMockGateway();
    real.name = 'sandbox';
    configureDeals({ gateway: real });
    await expect(seedDealDemo({ evidenceDir: false })).rejects.toThrow(/mock gateway only/);
    configureDeals({ gateway: makeMockGateway() });
  });
});
