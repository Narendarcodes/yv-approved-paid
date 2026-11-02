/**
 * deals/demo: the judge demo, "Diwali launch reels" (docs/phase4-ui-plan.md section 6).
 *
 *   DEMO                      fixed ids: deal id, org slug, judge email
 *   seedDealDemo(opts)        (re)build the demo org, users and deal (mock, or PayPal sandbox
 *                             with simulated buyer approval: real order + real invoice ids)
 *   demoJudge()               the seeded judge user, or null
 *
 * Idempotent: the demo deal always has the same id; a re-run deletes that one
 * deal and its ledger rows (by id, guarded to the demo id) and builds it again,
 * so the judge always starts from the same states:
 *
 *   reel1  held -> v1 fails loudness (-20.1 LUFS, screenshot evidence) -> Review
 *          Agent merge ("too quiet" = Fix on the loudness line, "more festive" =
 *          Taste) -> changes requested -> v2 passes every
 *          check -> approved -> $400 captured, paid out 70/30 -> two blocked
 *          attempts on the ledger (capture $450: P3_amount; pay the old v1:
 *          P6_version). No money moved for either.
 *   reel2  held -> 4 of 5 checks pass (no captions) -> dispute opened -> Scope &
 *          Dispute Agent proposes 80% ($240) from checklist arithmetic; the
 *          editor has accepted it, the client's tap is the one left. A $60 change order
 *          for +15 s (priced from the rate card) waits as a draft: the judge's
 *          tap accepts it and drafts the PayPal invoice live.
 *
 * Every step goes through the deal service (policy, ledger, lock) exactly as the
 * routes do. Run it in the server process (DEMO_MODE=1 seeds on boot) so the
 * mock PayPal that holds the authorizations is the same one the Money Agent uses
 * when the judge clicks.
 */
import type { DealDoc, DealTerms } from './lib/types.cts';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const bcrypt = require('bcryptjs');
const User = require('../../models/user.model');
const Organization = require('../../models/organization.model');
const Membership = require('../../models/membership.model');
const { seedDefaultRoles } = require('../../seed/roles');
const { Deal, DealLedger } = require('./lib/models.cts');
const engine = require('./lib/engine.cts');
const { hashOf } = require('./lib/canonical.cts');
const { evidenceDir } = require('./lib/evidence.cts');
const { dealService, gateway } = require('./service.cts');

const DEMO = {
  dealId: 'deal_demo_diwali',
  org: { name: 'Diwali Launch Studio (demo)', slug: 'yv-deal-demo' },
  judge: { email: 'judge@yv-demo.example.com', name: 'Demo Judge' },
  editor: { email: 'editor@yv-demo.example.com', name: 'Ravi (demo editor)', paypal: 'ravi.demo@example.com' },
  motion: { email: 'motion@yv-demo.example.com', name: 'Sana (demo motion)', paypal: 'sana.demo@example.com' },
};

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

function demoTerms(clientId: string, editorId: string, motionId: string): DealTerms {
  const due = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
  const common = [
    { id: 'len', text: 'Under 45 seconds', kind: 'check', measure: { metric: 'duration_s', op: '<=', value: 45 }, source: 'punchy' },
    { id: 'hook', text: 'Hook in the first 3 seconds', kind: 'check', measure: { metric: 'hook_by_s', op: '<=', value: 3 }, source: 'punchy' },
    { id: 'logo', text: 'Logo visible from 0:00 to 0:03', kind: 'check', measure: { metric: 'logo_present', op: 'present', window: [0, 3] } },
    { id: 'loud', text: 'Loudness -14 LUFS (+-1)', kind: 'check', measure: { metric: 'loudness_lufs', op: 'between', value: -15, max: -13 } },
  ];
  return {
    title: 'Diwali launch reels',
    currency: 'USD',
    client: { role: 'client', userId: clientId, displayName: 'Client' },
    worker: { role: 'worker', userId: editorId, displayName: 'Editor', paypalEmail: DEMO.editor.paypal },
    killFeeBp: 2500,
    humanApprovalThresholdMinor: 50000,
    rateCard: [
      { id: 'extra_cut', label: 'Extra 15s cut', unit: 'per cut', unitPriceMinor: 6000 },
      { id: 'revision_round', label: 'Extra revision round', unit: 'per round', unitPriceMinor: 4000 },
    ],
    milestones: [
      {
        key: 'reel1',
        title: 'Reel 1: 45s launch cut',
        amountMinor: 40000,
        dueAt: due(7),
        graceHours: 24,
        reviewWindowHours: 48,
        revisionRoundsIncluded: 1,
        styleSample: false,
        checklist: [...common, { id: 'vibe', text: 'Feels warm and festive', kind: 'taste' }],
        payees: [
          { userId: editorId, email: DEMO.editor.paypal, shareBp: 7000, displayName: 'Editor' },
          { userId: motionId, email: DEMO.motion.paypal, shareBp: 3000, displayName: 'Motion designer' },
        ],
      },
      {
        key: 'reel2',
        title: 'Reel 2: 30s teaser',
        amountMinor: 30000,
        dueAt: due(10),
        graceHours: 24,
        reviewWindowHours: 48,
        revisionRoundsIncluded: 2,
        styleSample: false,
        checklist: [
          { ...common[0], text: 'Under 30 seconds', measure: { metric: 'duration_s', op: '<=', value: 30 } },
          common[1],
          common[2],
          common[3],
          { id: 'caps', text: 'Captions on, bottom third', kind: 'check', measure: { metric: 'caption_present', op: 'present' } },
        ],
        payees: [{ userId: editorId, email: DEMO.editor.paypal, shareBp: 10000, displayName: 'Editor' }],
      },
    ],
  } as DealTerms;
}

/* ------------------------------------------------- placeholder evidence frames */

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A 160x90 solid PNG (teal = passed, red tint = failed): a stand-in frame for the demo. */
function framePng(ok: boolean): Buffer {
  const [w, h] = [160, 90];
  const rgb = ok ? [3, 94, 94] : [196, 64, 52];
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x += 1) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

type Line = { id: string; metric: string; measured: number | string | boolean; passed: boolean; t: number; tEnd: number; note: string };
function shotName(id: string, version: string, t: number) {
  return `${id}_${version}_${t.toFixed(2).padStart(6, '0')}.png`;
}
function report(versionId: string, sha256: string, lines: Line[], notes: Record<string, string> = {}) {
  return {
    versionId,
    sha256,
    results: lines.map((l) => ({
      checklist_id: l.id,
      metric: l.metric,
      measured: l.measured,
      passed: l.passed,
      evidence: [{ t_start: l.t, t_end: l.tEnd, note: l.note, screenshot: shotName(l.id, versionId, l.t) }],
    })),
    notes,
  };
}
function writeFrames(dir: string | false, dealId: string, versionId: string, lines: Line[]) {
  if (!dir) return;
  try {
    const d = path.join(dir, dealId);
    fs.mkdirSync(d, { recursive: true });
    for (const l of lines) fs.writeFileSync(path.join(d, shotName(l.id, versionId, l.t)), framePng(l.passed));
  } catch {
    /* frames are a nicety; the deal states do not depend on them */
  }
}

/* --------------------------------------------------------------------- seed */

async function upsertUser(u: { email: string; name: string }, password?: string) {
  // demo users have no usable password unless one is given (the judge comes in through demo-login)
  const passwordHash = bcrypt.hashSync(password || crypto.randomBytes(24).toString('base64url'), 10);
  return User.findOneAndUpdate({ email: u.email }, { $set: { name: u.name, passwordHash, disabled: false } }, { upsert: true, new: true });
}

async function purgeDemoDeal(id: string) {
  if (id !== DEMO.dealId) throw new Error('only the demo deal can be purged');
  await Deal.deleteOne({ _id: id });
  // the ledger model refuses deletes; the demo reset goes around it for this one deal id only
  await DealLedger.collection.deleteMany({ dealId: id });
}

async function seedDealDemo(opts: { evidenceDir?: string | false; judgePassword?: string } = {}) {
  const gw = gateway() as any;
  // mock: the in-memory buyer approves. sandbox: the order is real, but no sandbox buyer can
  // log in from here, so its approval is simulated and every id after it says "SIM-".
  const approve =
    gw.name === 'mock' && typeof gw.approveOrder === 'function'
      ? (orderId: string) => gw.approveOrder(orderId)
      : gw.name === 'paypal-sandbox' && gw.simulate && typeof gw.simulateBuyerApproval === 'function'
        ? (orderId: string) => gw.simulateBuyerApproval(orderId)
        : null;
  if (!approve) throw new Error('the deal demo seeds on PAYPAL_MODE=mock, or PAYPAL_MODE=sandbox with DEMO_MODE=1');
  const dir = opts.evidenceDir === undefined ? evidenceDir() : opts.evidenceDir;

  await seedDefaultRoles();
  const org = await Organization.findOneAndUpdate({ slug: DEMO.org.slug }, { $set: DEMO.org }, { upsert: true, new: true });
  const judge = await upsertUser(DEMO.judge, opts.judgePassword);
  const editor = await upsertUser(DEMO.editor);
  const motion = await upsertUser(DEMO.motion);
  for (const [u, role] of [[judge, 'admin'], [editor, 'editor'], [motion, 'editor']] as const) {
    await Membership.findOneAndUpdate({ userId: u._id, organizationId: org._id }, { $set: { role, disabled: false } }, { upsert: true, new: true });
  }
  const orgId = String(org._id);
  const [J, E] = [String(judge._id), String(editor._id)];
  const id = DEMO.dealId;
  const s = dealService();
  const must = (r: { out: any }, what: string) => {
    if (r.out?.outcome && r.out.outcome !== 'done') throw new Error(`demo seed: ${what} did not complete (${r.out.outcome})`);
    return r;
  };

  await purgeDemoDeal(id);
  let d: DealDoc = await s.create(orgId, J, demoTerms(J, E, String(motion._id)), { id });
  const h = hashOf(d.terms);
  await s.sign(id, orgId, J, h);
  await s.sign(id, orgId, E, h);
  for (const key of ['reel1', 'reel2']) {
    d = await s.startFunding(id, orgId, J, key);
    approve(d.milestones.find((m) => m.key === key)!.funding!.orderId!);
    must(await s.confirmFunding(id, orgId, J, key), `hold on ${key}`);
  }

  // reel1 v1: loudness fails at -20.1 LUFS
  const v1: Line[] = [
    { id: 'len', metric: 'duration_s', measured: 41.2, passed: true, t: 0, tEnd: 41.2, note: 'file runs 41.2s' },
    { id: 'hook', metric: 'hook_by_s', measured: 0.8, passed: true, t: 0.8, tEnd: 2.9, note: "first words at 0.8s: 'This Diwali, light up...'" },
    { id: 'logo', metric: 'logo_present', measured: true, passed: true, t: 0, tEnd: 3, note: 'logo matched (score 0.91) from 0.0s to 3.0s' },
    { id: 'loud', metric: 'loudness_lufs', measured: -20.1, passed: false, t: 12.4, tEnd: 12.4, note: 'integrated -20.1 LUFS, LRA 6.2, loudest moment at 12.4s' },
  ];
  await s.submitVersion(id, orgId, E, 'reel1', { id: 'v1', sha256: sha('diwali-reel1-v1') });
  await s.recordCheckReport(id, orgId, 'reel1', report('v1', sha('diwali-reel1-v1'), v1, { loud: 'About 6 LU too quiet for the -14 LUFS target; raise the mix.' }));
  writeFrames(dir, id, 'v1', v1);

  // Review Agent merge, then the client sends exactly those items
  const rv = await s.storeProposal(id, orgId, 'reel1', 'review', {
    versionId: 'v1',
    items: [
      { text: 'too quiet', tag: 'fix', checklistId: 'loud' },
      { text: 'make it more festive', tag: 'taste' },
    ],
    contradictions: [],
    rationale: '1 fix (cites the failed loudness line), 1 taste',
  });
  await s.requestChanges(id, orgId, J, 'reel1', rv.out.items);

  // reel1 v2: every check passes -> approved -> $400 captured, paid out 70/30
  const v2: Line[] = [
    { ...v1[0], measured: 42.0, tEnd: 42.0, note: 'file runs 42.0s' },
    v1[1],
    v1[2],
    { ...v1[3], measured: -14.2, passed: true, note: 'integrated -14.2 LUFS, LRA 5.8, loudest moment at 12.4s' },
  ];
  await s.submitVersion(id, orgId, E, 'reel1', { id: 'v2', sha256: sha('diwali-reel1-v2') });
  await s.recordCheckReport(id, orgId, 'reel1', report('v2', sha('diwali-reel1-v2'), v2));
  writeFrames(dir, id, 'v2', v2);
  await s.approve(id, orgId, J, 'reel1', 'v2', false);
  await s.tick(id, orgId);

  // what a copilot asking to "capture $450" or "pay the old version" gets: blocked, on the ledger, no money moved
  await s.withDeal(id, orgId, async (deal: DealDoc) => {
    const a = await engine.execute(s.deps, deal, { kind: 'capture', milestoneKey: 'reel1', amountMinor: 45000, versionId: 'v2', final: true, reason: 'approval' });
    const b = await engine.execute(s.deps, a.deal, { kind: 'capture', milestoneKey: 'reel1', amountMinor: 40000, versionId: 'v1', final: true, reason: 'approval' });
    return { deal: b.deal, out: [a.result, b.result] };
  });

  // reel2: 4 of 5 checks pass (no captions) -> dispute -> 80% proposed; the editor has accepted it
  const r2: Line[] = [
    { id: 'len', metric: 'duration_s', measured: 29.5, passed: true, t: 0, tEnd: 29.5, note: 'file runs 29.5s' },
    { id: 'hook', metric: 'hook_by_s', measured: 1.1, passed: true, t: 1.1, tEnd: 2.6, note: "first words at 1.1s: 'Coming this Diwali...'" },
    { id: 'logo', metric: 'logo_present', measured: true, passed: true, t: 0, tEnd: 3, note: 'logo matched (score 0.88) from 0.0s to 3.0s' },
    { id: 'loud', metric: 'loudness_lufs', measured: -14.4, passed: true, t: 8.2, tEnd: 8.2, note: 'integrated -14.4 LUFS, LRA 5.1, loudest moment at 8.2s' },
    { id: 'caps', metric: 'caption_present', measured: false, passed: false, t: 0, tEnd: 29.5, note: 'no caption track and no burned-in text found' },
  ];
  await s.submitVersion(id, orgId, E, 'reel2', { id: 'v1', sha256: sha('diwali-reel2-v1') });
  await s.recordCheckReport(id, orgId, 'reel2', report('v1', sha('diwali-reel2-v1'), r2, { caps: 'Captions were in the brief; none are on the file.' }));
  writeFrames(dir, id, 'v1', r2);
  await s.openDispute(id, orgId, E, 'reel2');
  const dp = await s.storeProposal(id, orgId, 'reel2', 'dispute', { notes: 'Captions are the only signed line not met; the rest of the checklist passed.' });
  await s.acceptSplit(id, orgId, E, 'reel2', dp.out.workerMinor);

  // +15 s cut on reel2 (still open): out of scope, priced from the signed rate card ($60 x 1).
  // Left as a draft so the judge's one tap accepts it and drafts the PayPal invoice live.
  await s.draftChangeOrder(id, orgId, { milestoneKey: 'reel2', rateCardItemId: 'extra_cut', quantity: 1, ask: 'Add an extra 15-second cut for Instagram Stories', by: 'agent' });

  return { orgId, dealId: id, judge: { userId: J, email: DEMO.judge.email }, editor: { userId: E, email: DEMO.editor.email } };
}

async function demoJudge() {
  return User.findOne({ email: DEMO.judge.email, disabled: { $ne: true } });
}

module.exports = { DEMO, seedDealDemo, demoJudge, demoTerms };
