/**
 * The judge demo seed (Phase 4 gap 4): Lumen Coffee's "Autumn launch reels" on the mock gateway,
 * with every state from docs/phase4-ui-plan.md section 6, built through the deal
 * service (policy, ledger, lock). Idempotent: a second run rebuilds the same deal.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mongoose = require('mongoose');
const { configureDeals, dealService } = require('../service.cts');
const { makeMockGateway, makeSandboxGateway } = require('../paypal.cts');
const { DEMO, seedDealDemo, ensureEvidenceFrames, clocksAsSeeded } = require('../demo.cts');

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
    expect(d.terms.title).toBe('Autumn launch reels');
    expect(d.terms.client.country).toBe('US'); // US clock calendar (Thanksgiving, Veterans Day)
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
    expect(loud.evidence[0].screenshot).toMatch(/^reel1_loud_v1_\d{3}\.\d{2}\.png$/);
    expect(fs.existsSync(path.join(dir, DEMO.dealId, loud.evidence[0].screenshot))).toBe(true);

    expect(m.proposals.review.items.map((i) => [i.text, i.tag])).toEqual([
      ['too quiet', 'fix'],
      ['make it feel cozier', 'taste'],
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
    const captured = l.entries
      .filter((e) => e.moved && /capture/.test(e.type))
      .reduce((a, e) => a + e.amountMinor, 0);
    // reel1 $400 approved + reel4's review-clock partial release $75
    expect(captured).toBe(47500);
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
      expect.objectContaining({
        milestoneKey: 'reel2',
        rateCardItemId: 'extra_cut',
        quantity: 1,
        amountMinor: 6000,
        status: 'draft',
      }),
    ]);
    const r = await dealService().decideChangeOrder(
      DEMO.dealId,
      seeded.orgId,
      seeded.judge.userId,
      d.changeOrders[0].id,
      true,
    );
    expect(r.out).toMatchObject({ outcome: 'done' });
    const after = await dealService().get(DEMO.dealId, seeded.orgId);
    expect(after.changeOrders[0]).toMatchObject({
      status: 'invoiced',
      invoiceId: expect.any(String),
    });
    const l = await dealService().ledgerOf(DEMO.dealId, seeded.orgId);
    expect(l.chain.ok).toBe(true);
    expect(l.entries.filter((e) => e.type === 'invoice')).toEqual([
      expect.objectContaining({ amountMinor: 6000, moved: false }),
    ]);
    await seedDealDemo({ evidenceDir: false }); // back to the judge's starting state
  });

  test('reel3: Fair Review Clock running with about 2 business days left; the line names the exact partial amount', async () => {
    const d = await dealService().get(DEMO.dealId, seeded.orgId);
    expect(d.terms.milestones.find((m) => m.key === 'reel3').clock).toEqual({
      reviewWindowBusinessDays: 3,
      partialReleasePct: 50,
      graceBusinessDays: 3,
      includedRevisionRounds: 2,
    });
    const v = await dealService().clockView(DEMO.dealId, seeded.orgId, 'reel3');
    expect(v).toMatchObject({
      milestoneState: 'IN_REVIEW',
      status: 'running',
      revisionsUsed: 0,
      includedRevisionRounds: 2,
    });
    expect(v.state.status).toBe('running');
    expect(v.state.businessDaysLeft).toBe(2);
    expect(v.amounts).toMatchObject({
      amountMinor: 20000,
      partialAmountCents: 10000,
      remainderCents: 10000,
      currency: 'USD',
    });
    expect(v.state.line).toMatch(/^If no reply by .+, \$100\.00 \(50%\) releases to the team\.$/);
    expect(v.doneSteps).not.toContain('release_partial');
    expect(v.timeline[0]).toMatchObject({ kind: 'action', id: 'started' });
  });

  test('reel4: no reply in the window -> 50% released once and paid 70/30, now in grace, with a timeline', async () => {
    const d = await dealService().get(DEMO.dealId, seeded.orgId);
    const m = ms(d, 'reel4');
    expect(m.state).toBe('IN_REVIEW');
    expect(m.captures.map((c) => [c.reason, c.amountMinor])).toEqual([['clock_partial', 7500]]);
    expect(m.payouts.map((p) => [p.email, p.amountMinor, p.tranche])).toEqual([
      [DEMO.editor.paypal, 5250, 'clock_partial'],
      [DEMO.motion.paypal, 2250, 'clock_partial'],
    ]);
    const v = await dealService().clockView(DEMO.dealId, seeded.orgId, 'reel4');
    expect(v.state.status).toBe('released_partial');
    expect(v.doneSteps).toEqual(
      expect.arrayContaining(['remind_50', 'remind_80', 'final_24h', 'release_partial']),
    );
    expect(v.doneSteps).not.toContain('release_grace');
    expect(Date.parse(v.state.graceDeadline)).toBeGreaterThan(Date.now());
    const ids = v.timeline.map((e) => e.id);
    expect(ids[0]).toBe('started');
    expect(ids).toEqual(
      expect.arrayContaining(['remind_50', 'remind_80', 'final_24h', 'release_partial']),
    );
    expect(v.timeline.find((e) => e.id === 'remind_50').note).toMatch(/demo seed/);
    expect(v.timeline.find((e) => e.id === 'release_partial').amountMinor).toBe(7500);
    // the reminders the seed logged were not sent; only the release told the parties
    const Notification = require('../../../models/notification.model');
    const n = await Notification.find({ 'payload.dealId': DEMO.dealId }).lean();
    expect(n.every((x) => x.type === 'deal_clock_release')).toBe(true);
  });

  test('reuse boots keep the deal only while the clocks are still as seeded', async () => {
    const d = await dealService().get(DEMO.dealId, seeded.orgId);
    expect(clocksAsSeeded(d, Date.now())).toBe(true);
    expect(clocksAsSeeded(d, Date.now() + 20 * 86400000)).toBe(false); // windows long over: rebuild
  });

  test('the team draft carries the default clock terms, still editable (unsigned)', async () => {
    const d = await dealService().get(DEMO.teamDealId, seeded.orgId);
    expect(d.terms.milestones[0].clock).toMatchObject({
      reviewWindowBusinessDays: 3,
      partialReleasePct: 50,
    });
    expect(d.termsHash).toBeUndefined();
  });

  test('ensureEvidenceFrames rewrites every missing frame from the stored results (restart on ephemeral disk)', async () => {
    const d = await dealService().get(DEMO.dealId, seeded.orgId);
    const cold = fs.mkdtempSync(path.join(os.tmpdir(), 'yv-demo-cold-'));
    try {
      const wrote = ensureEvidenceFrames(d, cold);
      expect(wrote).toBeGreaterThanOrEqual(11);
      const files = fs.readdirSync(path.join(cold, DEMO.dealId));
      expect(files).toHaveLength(wrote);
      const loud = files.find((f) => /^reel1_loud_v1_/.test(f));
      expect(
        fs
          .readFileSync(path.join(cold, DEMO.dealId, loud))
          .subarray(1, 4)
          .toString(),
      ).toBe('PNG');
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
    expect(again).toMatchObject({
      orgId: seeded.orgId,
      dealId: DEMO.dealId,
      judge: { userId: seeded.judge.userId },
    });
    const after = await dealService().ledgerOf(DEMO.dealId, seeded.orgId);
    expect(after.chain.ok).toBe(true);
    expect(after.entries.map((e) => e.type)).toEqual(before.entries.map((e) => e.type));
    expect(after.totals).toEqual(before.totals);
    // a reseed never stacks the seed's clock notifications
    const Notification = require('../../../models/notification.model');
    expect(
      await Notification.countDocuments({
        'payload.dealId': DEMO.dealId,
        type: 'deal_clock_release',
      }),
    ).toBeLessThanOrEqual(2);
  });

  test('team: Leo 70% / motion designer 30% on reel1; an unsigned team draft; two demo projects with assignees', async () => {
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
    const projects = await Project.find({
      organizationId: seeded.orgId,
      assignee: { $ne: null },
    }).lean();
    expect(projects.length).toBeGreaterThanOrEqual(2);
    expect(
      await Task.countDocuments({ organizationId: seeded.orgId, assignee: { $ne: null } }),
    ).toBeGreaterThanOrEqual(2);
    // a re-seed neither duplicates the projects nor overwrites a reassignment
    await Project.updateOne({ _id: projects[0]._id }, { $set: { assignee: seeded.judge.userId } });
    await seedDealDemo({ evidenceDir: false });
    expect(
      await Project.countDocuments({ organizationId: seeded.orgId, title: { $ne: 'Team Chat' } }),
    ).toBe(projects.length);
    expect(String((await Project.findById(projects[0]._id).lean()).assignee)).toBe(
      seeded.judge.userId,
    );
    expect((await dealService().get(DEMO.teamDealId, seeded.orgId)).signatures).toEqual([]);
  });

  test('stage gates: every demo project meets the gates of its stage; reel 2 can move on, reel 1 waits on a post, the team draft is locked on the deal', async () => {
    const Project = require('../../../models/project.model');
    const gates = require('../../../services/stageGates.service');
    const { DEMO_PROJECTS } = require('../demo.cts');
    const byTitle = async (t) => Project.findOne({ organizationId: seeded.orgId, title: t }).lean();
    const p = {};
    for (const [k, t] of Object.entries(DEMO_PROJECTS)) p[k] = await byTitle(t);
    for (const k of ['reel1', 'reel2', 'reel3', 'reel4'])
      expect([p[k].dealId, p[k].milestoneKey]).toEqual([DEMO.dealId, k]);
    expect([p.team.dealId, p.team.milestoneKey]).toEqual([DEMO.teamDealId, 'greeting']);
    // no project from the earlier demo brand is left
    expect(await Project.countDocuments({ organizationId: seeded.orgId, title: /Diwali/ })).toBe(0);
    // every gate up to the stage each project sits in is met
    for (const x of Object.values(p)) {
      const upTo = gates.STAGES.slice(1, gates.stageIndex(x.status) + 1).map((s) => s.key);
      for (const stage of upTo) {
        const missing = (await gates.checklist(x, stage)).filter((i) => !i.done).map((i) => i.key);
        expect({ title: x.title, stage, missing }).toEqual({ title: x.title, stage, missing: [] });
      }
    }
    // reel 1: approved (Publish); scheduling is the next move, and Live waits on Mei's post
    expect(await gates.evaluate(p.reel1)).toMatchObject({
      from: 'publish',
      to: 'publish',
      ready: true,
    });
    const live = (await gates.checklist(p.reel1, 'live')).filter((i) => !i.done).map((i) => i.key);
    expect(live).toEqual(['post_scheduled']);
    // reel 2: changes requested (Production); the Review gate (a version, checks ran) is already met
    expect(await gates.evaluate(p.reel2)).toMatchObject({ from: 'production', ready: true });
    expect((await gates.checklist(p.reel2, 'review')).filter((i) => !i.done)).toEqual([]);
    expect(gates.stageIndex(p.reel3.status)).toBe(gates.stageIndex('UNDER_REVIEW'));
    expect(gates.stageIndex(p.reel4.status)).toBe(gates.stageIndex('UNDER_REVIEW'));
    const g3 = await gates.evaluate(p.team);
    expect(g3).toMatchObject({ from: 'brief', to: 'production', ready: false });
    expect(g3.missing.map((m) => m.key)).toEqual(['deal_signed', 'money_held']);
  });

  test('team, chat, review trail and Brand Brain memory: five people, #general + #autumn-launch, versions, comments, notifications', async () => {
    const User = require('../../../models/user.model');
    const Membership = require('../../../models/membership.model');
    const Channel = require('../../../models/channel.model');
    const ChatMessage = require('../../../models/chatMessage.model');
    const Comment = require('../../../models/comment.model');
    const ProjectVersion = require('../../../models/projectVersion.model');
    const Notification = require('../../../models/notification.model');
    const Organization = require('../../../models/organization.model');
    const { BrandRule } = require('../../../models/agent');
    const org = await Organization.findById(seeded.orgId).lean();
    expect(org.name).toBe('Lumen Coffee');
    const people = {};
    for (const k of ['judge', 'editor', 'motion', 'reviewer', 'publisher']) {
      const u = await User.findOne({ email: DEMO[k].email }).lean();
      const m = await Membership.findOne({ userId: u._id, organizationId: seeded.orgId }).lean();
      people[k] = [u.name, m.role];
    }
    expect(people).toEqual({
      judge: ['Nora Hayes', 'admin'],
      editor: ['Leo Carter', 'editor'],
      motion: ['Maya Ortiz', 'editor'],
      reviewer: ['Alex Morgan', 'reviewer'],
      publisher: ['Mei Tan', 'publisher'],
    });
    const chans = await Channel.find({ organizationId: seeded.orgId })
      .sort({ createdAt: 1 })
      .lean();
    expect(chans.map((c) => c.name)).toEqual(['general', 'autumn-launch']);
    const msgs = await ChatMessage.find({ organizationId: seeded.orgId }).lean();
    expect(msgs.length).toBeGreaterThanOrEqual(15);
    expect(new Set(msgs.map((m) => String(m.author))).size).toBe(5);
    expect(await ProjectVersion.countDocuments({ organizationId: seeded.orgId })).toBe(5);
    // every seeded version carries its reel as a demo:<name> file (no copy on the host's disk)
    const vs = await ProjectVersion.find({ organizationId: seeded.orgId }).lean();
    for (const v of vs) {
      expect(v.files).toHaveLength(1);
      expect(v.files[0]).toMatchObject({ mimeType: 'video/mp4' });
      expect(v.files[0].storageRef).toMatch(/^demo:lumen-reel[1-4]\.mp4$/);
    }
    const cs = await Comment.find({ organizationId: seeded.orgId }).lean();
    expect(cs.some((c) => /Captions on, bottom third/.test(c.body) && c.timecode === 4)).toBe(true);
    expect(
      await Notification.countDocuments({ userId: seeded.judge.userId, 'payload.demoSeed': true }),
    ).toBeGreaterThanOrEqual(5);
    const rules = await BrandRule.find({ organizationId: seeded.orgId }).lean();
    expect(rules.map((r) => r.kind)).toEqual(
      expect.arrayContaining(['voice', 'do', 'dont', 'visual', 'audience', 'resource']),
    );
    expect(rules.filter((r) => /^Past campaign learning/.test(r.title))).toHaveLength(3);
    expect(rules.find((r) => r.title === 'Product list').body).toMatch(
      /Ember Roast.*Harvest Blend.*Cold Brew Cans/s,
    );
    expect(org.settings.brandBrainSample.length).toBeGreaterThanOrEqual(3);
    // re-seeding replaces the seeded records instead of stacking them
    await seedDealDemo({ evidenceDir: false });
    expect(await ChatMessage.countDocuments({ organizationId: seeded.orgId })).toBe(msgs.length);
    expect(await Comment.countDocuments({ organizationId: seeded.orgId })).toBe(cs.length);
    expect(await BrandRule.countDocuments({ organizationId: seeded.orgId })).toBe(rules.length);
    // the reels point at their demo cuts (display only)
    const d = await dealService().get(DEMO.dealId, seeded.orgId);
    for (const k of ['reel1', 'reel2', 'reel3', 'reel4']) {
      const m = ms(d, k);
      expect(m.versions[m.versions.length - 1].mediaUrl).toBe(`/demo/reels/lumen-${k}.mp4`);
    }
  });

  test('evidence frames are real stills from the demo reels when bundled', async () => {
    const d = await dealService().get(DEMO.dealId, seeded.orgId);
    const caps = ms(d, 'reel2').versions[0].checks.results.find((r) => r.checklistId === 'caps');
    const name = caps.evidence[0].screenshot;
    expect(name).toBe('reel2_caps_v1_000.00.png');
    const bundled = fs.readFileSync(path.join(__dirname, '..', 'demo-media', name));
    expect(fs.readFileSync(path.join(dir, DEMO.dealId, name)).equals(bundled)).toBe(true);
  });

  test('refuses to run on a real PayPal gateway', async () => {
    const real = makeMockGateway();
    real.name = 'sandbox';
    configureDeals({ gateway: real });
    await expect(seedDealDemo({ evidenceDir: false })).rejects.toThrow(
      /PAYPAL_MODE=mock, or PAYPAL_MODE=sandbox with DEMO_MODE=1/,
    );
    configureDeals({
      gateway: makeSandboxGateway({
        clientId: 'id',
        clientSecret: 's',
        fetchImpl: async () => ({ ok: false, status: 500, text: async () => '' }),
      }),
    });
    await expect(seedDealDemo({ evidenceDir: false })).rejects.toThrow(/DEMO_MODE=1/); // sandbox without simulated approval
    configureDeals({ gateway: makeMockGateway() });
  });

  test('PAYPAL_MODE=sandbox: real order and INV2 invoice ids; simulated buyer approval is labelled, never passed off as real', async () => {
    let n = 0;
    const reply = (status, body) => ({
      ok: status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    });
    const fetchImpl = async (url, init = {}) => {
      const key = `${init.method || 'GET'} ${new URL(url).pathname}`;
      if (key === 'POST /v1/oauth2/token')
        return reply(200, { access_token: 'tok', token_type: 'Bearer', expires_in: 32400 });
      if (key === 'POST /v2/checkout/orders')
        return reply(201, {
          id: `5O190127TN36471${String(++n).padStart(2, '0')}`,
          status: 'PAYER_ACTION_REQUIRED',
          links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow' }],
        });
      if (key === 'POST /v1/payments/payouts')
        return reply(403, {
          name: 'PAYOUT_NOT_AVAILABLE',
          message: 'You live in a country that is not allowed to send this payout.',
        });
      if (key === 'POST /v2/invoicing/invoices')
        return reply(201, { id: 'INV2-AB12-CD34-EF56-GH78', status: 'DRAFT' });
      if (/^POST \/v2\/invoicing\/invoices\/.+\/send$/.test(key))
        return reply(200, {
          href: 'https://www.sandbox.paypal.com/invoice/p/#INV2-AB12-CD34-EF56-GH78',
        });
      throw new Error(`unexpected PayPal call ${key}`);
    };
    configureDeals({
      gateway: makeSandboxGateway({ clientId: 'id', clientSecret: 's', fetchImpl, simulate: true }),
    });
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
      expect(
        ms(d, 'reel1').payouts.every((p) => /^SIM-BATCH-/.test(p.batchId) && p.simulated === true),
      ).toBe(true);
      const accepted = await dealService().decideChangeOrder(
        DEMO.dealId,
        r.orgId,
        r.judge.userId,
        d.changeOrders[0].id,
        true,
      );
      expect(accepted.out).toMatchObject({ outcome: 'done' });
      const after = await dealService().get(DEMO.dealId, r.orgId);
      expect(after.changeOrders[0]).toMatchObject({
        status: 'invoiced',
        invoiceId: 'INV2-AB12-CD34-EF56-GH78',
      });
      const l = await dealService().ledgerOf(DEMO.dealId, r.orgId);
      expect(l.chain.ok).toBe(true);
      const moved = l.entries.filter((e) => ['authorize', 'capture', 'payout'].includes(e.type));
      expect(moved.length).toBeGreaterThan(0);
      for (const e of moved) expect(e.explanation).toMatch(/PayPal sandbox/);
      expect(l.entries.find((e) => e.type === 'authorize').explanation).toMatch(
        /PayPal sandbox: buyer approval simulated/,
      );
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
