/**
 * deals/demo: the judge demo, Lumen Coffee's "Autumn launch reels" (a fictional global
 * coffee brand, US-based, so the review clock skips US holidays such as Thanksgiving).
 *
 *   DEMO                      fixed ids: deal id, org slug, judge email
 *   seedDealDemo(opts)        (re)build the demo org, users and deal (mock, or PayPal sandbox:
 *                             real pre-approved authorizations from the pool, captures and
 *                             voids; simulated approval only when the pool is empty)
 *                             opts.force rebuilds even an untouched real-sandbox deal (reset)
 *   demoJudge()               the seeded judge user, or null
 *   demoEditor()              the seeded crew member (Leo Carter), or null
 *   ensureEvidenceFrames(d)   rewrite missing placeholder frames from the stored check results
 *
 * Idempotent: the demo deal always has the same id; a re-run deletes that one
 * deal and its ledger rows (by id, guarded to the demo id) and builds it again,
 * so the judge always starts from the same states:
 *
 *   reel1  held -> v1 fails loudness (-20.1 LUFS, screenshot evidence) -> Review
 *          Agent merge ("too quiet" = Fix on the loudness line, "feel cozier" =
 *          Taste) -> changes requested -> v2 passes every
 *          check -> approved -> $400 captured, paid out 70/30 -> two blocked
 *          attempts on the ledger (capture $450: P3_amount; pay the old v1:
 *          P6_version). No money moved for either.
 *   reel2  held -> 4 of 5 checks pass (no captions) -> dispute opened -> Scope &
 *          Dispute Agent proposes 80% ($240) from checklist arithmetic; the
 *          editor has accepted it, the client's tap is the one left. A $60 change order
 *          for +15 s (priced from the rate card) waits as a draft: the judge's
 *          tap accepts it and drafts the PayPal invoice live.
 *   reel3  Fair Review Clock ($400, 70/30, 3 business days, no partial, 3 grace days, 2 rounds):
 *          held -> v1 passes every check -> clock running, ~2 business days left
 *   reel4  same clock terms: v1 passed, no reply in the window -> 50% ($75)
 *          released and paid out 70/30 -> in grace, the rest releases at its end
 *   team draft: unsigned, with the same clock terms (editable before signing)
 *
 * The clock starts are picked from the pure clock maths (pickStart) so the
 * judge sees the same picture on any day. A reuse boot (untouched real-sandbox
 * deal) keeps the deal only while those clocks are still in that picture.
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
const Project = require('../../models/project.model');
const Task = require('../../models/task.model');
const Concept = require('../../models/concept.model');
const Brief = require('../../models/brief.model');
const { seedDefaultRoles } = require('../../seed/roles');
const { Deal, DealLedger } = require('./lib/models.cts');
const engine = require('./lib/engine.cts');
const { hashOf } = require('./lib/canonical.cts');
const { evidenceDir } = require('./lib/evidence.cts');
const { dealService, gateway } = require('./service.cts');
const reviewClock = require('./lib/review-clock.cts');
const { buildSchedule, clockState } = require('./lib/clock.cts');
const Notification = require('../../models/notification.model');
const { seedDemoTeamContent, demoFrame, REEL_MEDIA } = require('./demo-content.cts');

const DEMO = {
  dealId: 'deal_demo_diwali',
  /** A second, unsigned deal so the judge can pick the team and the split (Deal Team card). */
  teamDealId: 'deal_demo_team_draft',
  org: { name: 'Lumen Coffee', slug: 'yv-deal-demo' },
  /** Nora Hayes, content ops lead: the brand side (client, org admin). Demo-login signs in as her. */
  judge: { email: 'judge@yv-demo.example.com', name: 'Nora Hayes' },
  editor: {
    email: 'editor@yv-demo.example.com',
    name: 'Leo Carter',
    paypal: 'leo.demo@example.com',
  },
  motion: {
    email: 'motion@yv-demo.example.com',
    name: 'Maya Ortiz',
    paypal: 'maya.demo@example.com',
  },
  /** Alex Morgan, brand reviewer (reviewer role). */
  reviewer: { email: 'reviewer@yv-demo.example.com', name: 'Alex Morgan' },
  /** Mei Tan, social publisher (publisher role). */
  publisher: { email: 'publisher@yv-demo.example.com', name: 'Mei Tan' },
};

/** The demo deal's title (what judges see). */
const DEMO_TITLE = 'Autumn launch reels';

/** The clock terms every demo clock milestone signs (the setup panel's defaults). */
const DEMO_CLOCK = {
  reviewWindowBusinessDays: 3,
  partialReleasePct: 50,
  graceBusinessDays: 3,
  includedRevisionRounds: 2,
};
const HOUR_MS = 3600 * 1000;

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

function demoTerms(clientId: string, editorId: string, motionId: string): DealTerms {
  const due = (days: number) => new Date(Date.now() + days * 86400000).toISOString();
  const common = [
    {
      id: 'len',
      text: 'Under 45 seconds',
      kind: 'check',
      measure: { metric: 'duration_s', op: '<=', value: 45 },
      source: 'punchy',
    },
    {
      id: 'hook',
      text: 'Hook in the first 3 seconds',
      kind: 'check',
      measure: { metric: 'hook_by_s', op: '<=', value: 3 },
      source: 'punchy',
    },
    {
      id: 'logo',
      text: 'Logo visible from 0:00 to 0:03',
      kind: 'check',
      measure: { metric: 'logo_present', op: 'present', window: [0, 3] },
    },
    {
      id: 'loud',
      text: 'Loudness -14 LUFS (+-1)',
      kind: 'check',
      measure: { metric: 'loudness_lufs', op: 'between', value: -15, max: -13 },
    },
  ];
  return {
    title: DEMO_TITLE,
    currency: 'USD',
    // a US brand: the Fair Review Clock counts US business days (America/New_York) and skips US holidays
    client: { role: 'client', userId: clientId, displayName: 'Lumen Coffee', country: 'US' },
    worker: {
      role: 'worker',
      userId: editorId,
      displayName: 'Leo Carter',
      paypalEmail: DEMO.editor.paypal,
    },
    killFeeBp: 2500,
    humanApprovalThresholdMinor: 50000,
    rateCard: [
      { id: 'extra_cut', label: 'Extra 15s cut', unit: 'per cut', unitPriceMinor: 6000 },
      {
        id: 'revision_round',
        label: 'Extra revision round',
        unit: 'per round',
        unitPriceMinor: 4000,
      },
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
        checklist: [...common, { id: 'vibe', text: 'Feels warm and cozy', kind: 'taste' }],
        payees: [
          { userId: editorId, email: DEMO.editor.paypal, shareBp: 7000, displayName: 'Leo Carter' },
          {
            userId: motionId,
            email: DEMO.motion.paypal,
            shareBp: 3000,
            displayName: 'Maya Ortiz',
          },
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
          {
            ...common[0],
            text: 'Under 30 seconds',
            measure: { metric: 'duration_s', op: '<=', value: 30 },
          },
          common[1],
          common[2],
          common[3],
          {
            id: 'caps',
            text: 'Captions on, bottom third',
            kind: 'check',
            measure: { metric: 'caption_present', op: 'present' },
          },
        ],
        payees: [
          {
            userId: editorId,
            email: DEMO.editor.paypal,
            shareBp: 10000,
            displayName: 'Leo Carter',
          },
        ],
      },
      {
        // Fair Review Clock: running, about 2 business days left (seedClocks)
        key: 'reel3',
        title: 'Reel 3: 15s story cut',
        amountMinor: 40000,
        dueAt: due(12),
        graceHours: 24,
        reviewWindowHours: 48,
        revisionRoundsIncluded: 2,
        styleSample: false,
        checklist: [
          {
            ...common[0],
            text: 'Under 15 seconds',
            measure: { metric: 'duration_s', op: '<=', value: 15 },
          },
          common[1],
          common[2],
          common[3],
          { id: 'vibe', text: 'Feels warm and cozy', kind: 'taste' },
        ],
        payees: [
          { userId: editorId, email: DEMO.editor.paypal, shareBp: 7000, displayName: 'Leo Carter' },
          {
            userId: motionId,
            email: DEMO.motion.paypal,
            shareBp: 3000,
            displayName: 'Maya Ortiz',
          },
        ],
        clock: { ...DEMO_CLOCK, partialReleasePct: 0 },
      },
      {
        // Fair Review Clock: no reply in the window, 50% released, now in grace (seedClocks)
        key: 'reel4',
        title: 'Reel 4: 6s bumper',
        amountMinor: 15000,
        dueAt: due(12),
        graceHours: 24,
        reviewWindowHours: 48,
        revisionRoundsIncluded: 2,
        styleSample: false,
        checklist: [
          {
            ...common[0],
            text: 'Under 6 seconds',
            measure: { metric: 'duration_s', op: '<=', value: 6 },
          },
          common[2],
          common[3],
        ],
        payees: [
          { userId: editorId, email: DEMO.editor.paypal, shareBp: 7000, displayName: 'Leo Carter' },
          {
            userId: motionId,
            email: DEMO.motion.paypal,
            shareBp: 3000,
            displayName: 'Maya Ortiz',
          },
        ],
        clock: { ...DEMO_CLOCK },
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
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

type Line = {
  id: string;
  metric: string;
  measured: number | string | boolean;
  passed: boolean;
  t: number;
  tEnd: number;
  note: string;
};
function shotName(key: string, id: string, version: string, t: number) {
  return `${key}_${id}_${version}_${t.toFixed(2).padStart(6, '0')}.png`;
}
function report(
  key: string,
  versionId: string,
  sha256: string,
  lines: Line[],
  notes: Record<string, string> = {},
) {
  return {
    versionId,
    sha256,
    results: lines.map((l) => ({
      checklist_id: l.id,
      metric: l.metric,
      measured: l.measured,
      passed: l.passed,
      evidence: [
        {
          t_start: l.t,
          t_end: l.tEnd,
          note: l.note,
          screenshot: shotName(key, l.id, versionId, l.t),
        },
      ],
    })),
    notes,
  };
}
function writeFrames(
  dir: string | false,
  dealId: string,
  key: string,
  versionId: string,
  lines: Line[],
) {
  if (!dir) return;
  try {
    const d = path.join(dir, dealId);
    fs.mkdirSync(d, { recursive: true });
    for (const l of lines) {
      const name = shotName(key, l.id, versionId, l.t);
      fs.writeFileSync(path.join(d, name), demoFrame(name) || framePng(l.passed));
    }
  } catch {
    /* frames are a nicety; the deal states do not depend on them */
  }
}

/**
 * Rewrite any missing placeholder frame the deal's stored check results point at.
 * The frames live on local (on Render: ephemeral) disk and are deterministic, so a
 * restart that reuses an untouched real-sandbox deal, or a cold disk, can rebuild
 * them from the stored results alone. Returns how many files were written.
 */
function ensureEvidenceFrames(deal: DealDoc | null, dir: string | false = evidenceDir()): number {
  if (!deal || !dir || !/^[A-Za-z0-9_-]{1,64}$/.test(deal.id)) return 0;
  let wrote = 0;
  try {
    const d = path.join(dir, deal.id);
    for (const m of deal.milestones || []) {
      for (const v of m.versions || []) {
        for (const r of v.checks?.results || []) {
          for (const e of r.evidence || []) {
            const name = typeof e.screenshot === 'string' ? path.basename(e.screenshot) : '';
            if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}\.png$/.test(name) || name.includes('..'))
              continue;
            const file = path.join(d, name);
            if (fs.existsSync(file) || fs.existsSync(path.join(dir, name))) continue;
            fs.mkdirSync(d, { recursive: true });
            fs.writeFileSync(file, demoFrame(name) || framePng(!!r.passed));
            wrote += 1;
          }
        }
      }
    }
  } catch {
    /* frames are a nicety; the deal states do not depend on them */
  }
  return wrote;
}

/* --------------------------------------------------------------------- seed */

async function upsertUser(u: { email: string; name: string }, password?: string) {
  // demo users have no usable password unless one is given (the judge comes in through demo-login)
  const passwordHash = bcrypt.hashSync(
    password || crypto.randomBytes(24).toString('base64url'),
    10,
  );
  return User.findOneAndUpdate(
    { email: u.email },
    { $set: { name: u.name, passwordHash, disabled: false } },
    { upsert: true, new: true },
  );
}

async function purgeDemoDeal(id: string) {
  if (id !== DEMO.dealId && id !== DEMO.teamDealId)
    throw new Error('only the demo deals can be purged');
  await Deal.deleteOne({ _id: id });
  // the ledger model refuses deletes; the demo reset goes around it for this one deal id only
  await DealLedger.collection.deleteMany({ dealId: id });
  // clock reminders/releases the seed itself caused; a reseed sends them again
  await Notification.deleteMany({ 'payload.dealId': id });
}

/** Terms for the unsigned team demo: one milestone, Leo 70% / motion designer 30%, editable by the judge (client). */
function teamDraftTerms(clientId: string, editorId: string, motionId: string): DealTerms {
  const t = demoTerms(clientId, editorId, motionId);
  const reel = t.milestones[0];
  return {
    ...t,
    title: 'Holiday gift reel (team draft)',
    rateCard: [t.rateCard[0]],
    milestones: [
      {
        ...reel,
        key: 'greeting',
        title: 'Holiday gift reel: 20s',
        amountMinor: 25000,
        checklist: reel.checklist.slice(0, 2),
        clock: { ...DEMO_CLOCK },
      },
    ],
  } as DealTerms;
}

/** Project titles the demo seeds (the web and the tests look them up by these). */
const DEMO_PROJECTS = {
  reel1: 'Reel 1: 45s launch cut',
  reel2: 'Reel 2: 30s teaser',
  reel3: 'Reel 3: 15s story cut',
  reel4: 'Reel 4: 6s bumper',
  team: 'Holiday gift reel (team draft)',
};

/**
 * The demo projects, one per piece of deal work, each with an assignee and one
 * task, so the Assign picker and the stage gates have something to show.
 * Created once, keyed by title: a re-seed never overwrites what a judge changed
 * (reassigning, moving a task, editing the brief).
 *
 * Every project meets the stage gates of the stage it sits in (services/
 * stageGates.service.js): it came from an approved concept, its brief has
 * deliverables and an editor is assigned. The links (concept, deal, milestone)
 * are re-set on every seed so a reset deal is always the one the project reads.
 *   reel 1 (Publish)     deal_demo_diwali/reel1: approved and paid out -> Live waits on Mei's post
 *   reel 2 (Production)  deal_demo_diwali/reel2: captions check failed, in dispute -> ready for Review
 *   reel 3 (Review)      deal_demo_diwali/reel3: clock running
 *   reel 4 (Review)      deal_demo_diwali/reel4: clock in grace
 *   team draft (Brief)   deal_demo_team_draft/greeting: unsigned, nothing held -> locked
 * Projects left over from the earlier demo brand (titles starting "Diwali") are removed.
 */
async function seedDemoProjects(
  orgId: string,
  judgeId: string,
  editorId: string,
  motionId: string,
): Promise<Record<string, string>> {
  const old = await Project.find({ organizationId: orgId, title: /^Diwali / })
    .select('_id')
    .lean();
  if (old.length) {
    const ids = old.map((o: { _id: unknown }) => o._id);
    await Promise.all([
      Task.deleteMany({ organizationId: orgId, projectId: { $in: ids } }),
      Brief.deleteMany({ organizationId: orgId, projectId: { $in: ids } }),
      Concept.deleteMany({ organizationId: orgId, approvedProjectId: { $in: ids } }),
    ]);
    await Project.deleteMany({ organizationId: orgId, _id: { $in: ids } });
  }
  const rows = [
    {
      key: 'reel1',
      title: DEMO_PROJECTS.reel1,
      description: 'Ember Roast launch cut for Instagram Reels and YouTube Shorts.',
      status: 'APPROVED',
      assignee: editorId,
      task: 'Hand the approved cut to Mei for scheduling',
      taskAssignee: editorId,
      dealId: DEMO.dealId,
      milestoneKey: 'reel1',
      deliverables: [
        '45s launch cut (9:16)',
        'LUMEN logo in the first 3s',
        'Mix at -14 LUFS',
        'Captions on, bottom third',
      ],
    },
    {
      key: 'reel2',
      title: DEMO_PROJECTS.reel2,
      description: 'Autumn teaser with captions in the bottom third.',
      status: 'REVISION_REQUESTED',
      assignee: editorId,
      task: 'Burn in captions, bottom third (brief item 2)',
      taskAssignee: motionId,
      dealId: DEMO.dealId,
      milestoneKey: 'reel2',
      deliverables: [
        '30s teaser (9:16)',
        'Captions on, bottom third',
        'LUMEN logo in the first 3s',
      ],
    },
    {
      key: 'reel3',
      title: DEMO_PROJECTS.reel3,
      description: 'Harvest Blend story cut for Instagram Stories.',
      status: 'UNDER_REVIEW',
      assignee: editorId,
      task: 'Stand by for review notes',
      taskAssignee: editorId,
      dealId: DEMO.dealId,
      milestoneKey: 'reel3',
      deliverables: ['15s story cut (9:16)', 'Hook in the first 3s', 'LUMEN logo in the first 3s'],
    },
    {
      key: 'reel4',
      title: DEMO_PROJECTS.reel4,
      description: 'Ember Roast 6s bumper for pre-roll.',
      status: 'UNDER_REVIEW',
      assignee: motionId,
      task: 'Logo sting for the bumper (0:00-0:03)',
      taskAssignee: motionId,
      dealId: DEMO.dealId,
      milestoneKey: 'reel4',
      deliverables: ['6s bumper (9:16)', 'LUMEN logo in the first 3s'],
    },
    {
      key: 'team',
      title: DEMO_PROJECTS.team,
      description: 'A 20s holiday gift reel; the team and the split are still being agreed.',
      status: 'ASSIGNED',
      assignee: editorId,
      task: 'Rough cut of the holiday gift reel',
      taskAssignee: editorId,
      dealId: DEMO.teamDealId,
      milestoneKey: 'greeting',
      deliverables: ['20s holiday gift reel (9:16)', 'Captions'],
    },
  ];
  const out: Record<string, string> = {};
  for (const r of rows) {
    const p = await Project.findOneAndUpdate(
      { organizationId: orgId, title: r.title },
      {
        $setOnInsert: {
          organizationId: orgId,
          title: r.title,
          description: r.description,
          type: 'Content Production',
          status: r.status,
          creator: judgeId,
          assignee: r.assignee,
          assignedAt: new Date(),
        },
      },
      { upsert: true, new: true },
    );
    const concept = await Concept.findOneAndUpdate(
      { organizationId: orgId, title: r.title },
      {
        $setOnInsert: {
          organizationId: orgId,
          title: r.title,
          description: r.description,
          proposer: judgeId,
          status: 'APPROVED',
          approvedProjectId: p._id,
        },
      },
      { upsert: true, new: true },
    );
    await Project.updateOne(
      { _id: p._id },
      { $set: { conceptId: concept._id, dealId: r.dealId, milestoneKey: r.milestoneKey } },
    );
    await Brief.findOneAndUpdate(
      { projectId: p._id },
      {
        $setOnInsert: {
          projectId: p._id,
          organizationId: orgId,
          goal: r.description,
          deliverables: r.deliverables,
          submittedBy: judgeId,
        },
      },
      { upsert: true, new: true },
    );
    await Task.findOneAndUpdate(
      { projectId: p._id, title: r.task },
      {
        $setOnInsert: {
          projectId: p._id,
          organizationId: orgId,
          title: r.task,
          status: 'in_progress',
          priority: 'high',
          assignee: r.taskAssignee,
          createdBy: judgeId,
        },
      },
      { upsert: true, new: true },
    );
    out[r.key] = String(p._id);
  }
  return out;
}

/**
 * On PayPal sandbox a boot does not need to rebuild a demo deal nobody has touched:
 * its authorizations are real (they survive a restart), so rebuilding would only
 * burn two more pre-approved authorizations from the pool. Untouched = both holds
 * are real PayPal ids, reel2 is still in its open dispute with no split tapped and
 * a hold valid for another day, and the change order is still a draft.
 * SIM- (and mock) ids live in this process's memory only, so a deal holding them is rebuilt.
 */
function untouchedRealDemo(d: DealDoc | null, nowMs: number): boolean {
  if (!d) return false;
  // a deal seeded under the earlier demo brand is rebuilt once (Lumen Coffee, US clock calendar)
  if (d.terms?.title !== DEMO_TITLE || d.terms?.client?.country !== 'US') return false;
  const real = (id?: string) => !!id && !id.startsWith('SIM-') && !id.endsWith('MOCK'); // not simulated, not the mock's
  const r1 = d.milestones.find((m) => m.key === 'reel1');
  const r2 = d.milestones.find((m) => m.key === 'reel2');
  if (!r1 || !r2 || !real(r1.funding?.authorizationId) || !real(r2.funding?.authorizationId))
    return false;
  if (!r1.captures.length || !r1.captures.every((c) => real(c.id))) return false;
  if (
    r2.state !== 'DISPUTED' ||
    r2.funding?.status !== 'AUTHORIZED' ||
    r2.split?.client !== undefined
  )
    return false;
  if (!r2.funding?.expiresAt || Date.parse(r2.funding.expiresAt) < nowMs + 24 * 3600 * 1000)
    return false;
  if (!clocksAsSeeded(d, nowMs)) return false;
  return d.changeOrders.length > 0 && d.changeOrders.every((c) => c.status === 'draft');
}

/** reel3's clock still running with a business day or more left, reel4 still in grace after its partial release. */
function clocksAsSeeded(d: DealDoc, nowMs: number): boolean {
  const now = new Date(nowMs).toISOString();
  const r3 = reviewClock.viewOf(d, 'reel3', now);
  const r4 = reviewClock.viewOf(d, 'reel4', now);
  return (
    !!r3 &&
    r3.status === 'running' &&
    r3.state.status === 'running' &&
    r3.state.businessDaysLeft >= 1 &&
    !!r4 &&
    r4.status === 'running' &&
    r4.state.status === 'released_partial' &&
    r4.doneSteps.includes('release_partial')
  );
}

async function seedDealDemo(
  opts: { evidenceDir?: string | false; judgePassword?: string; force?: boolean } = {},
) {
  const gw = gateway() as any;
  // mock: the in-memory buyer approves. sandbox: each hold first takes a real authorization a
  // sandbox buyer approved ahead of time (pool.cts); only when the pool is empty is the
  // approval simulated, and every id after it says "SIM-".
  const approve =
    gw.name === 'mock' && typeof gw.approveOrder === 'function'
      ? (orderId: string) => gw.approveOrder(orderId)
      : gw.name === 'paypal-sandbox' &&
          gw.simulate &&
          typeof gw.simulateBuyerApproval === 'function'
        ? (orderId: string) => gw.simulateBuyerApproval(orderId)
        : null;
  if (!approve)
    throw new Error(
      'the deal demo seeds on PAYPAL_MODE=mock, or PAYPAL_MODE=sandbox with DEMO_MODE=1',
    );
  const dir = opts.evidenceDir === undefined ? evidenceDir() : opts.evidenceDir;

  await seedDefaultRoles();
  const org = await Organization.findOneAndUpdate(
    { slug: DEMO.org.slug },
    { $set: DEMO.org },
    { upsert: true, new: true },
  );
  const judge = await upsertUser(DEMO.judge, opts.judgePassword);
  const editor = await upsertUser(DEMO.editor);
  const motion = await upsertUser(DEMO.motion);
  const reviewer = await upsertUser(DEMO.reviewer);
  const publisher = await upsertUser(DEMO.publisher);
  for (const [u, role] of [
    [judge, 'admin'],
    [editor, 'editor'],
    [motion, 'editor'],
    [reviewer, 'reviewer'],
    [publisher, 'publisher'],
  ] as const) {
    await Membership.findOneAndUpdate(
      { userId: u._id, organizationId: org._id },
      { $set: { role, disabled: false } },
      { upsert: true, new: true },
    );
  }
  const orgId = String(org._id);
  const [J, E] = [String(judge._id), String(editor._id)];
  const projectIds = await seedDemoProjects(orgId, J, E, String(motion._id));
  const team = {
    judge: J,
    editor: E,
    motion: String(motion._id),
    reviewer: String(reviewer._id),
    publisher: String(publisher._id),
  };
  const id = DEMO.dealId;
  const s = dealService();
  const must = (r: { out: any }, what: string) => {
    if (r.out?.outcome && r.out.outcome !== 'done')
      throw new Error(`demo seed: ${what} did not complete (${r.out.outcome})`);
    return r;
  };

  if (!opts.force && gw.name === 'paypal-sandbox') {
    const existing = await s.get(id, orgId).catch(() => null);
    if (untouchedRealDemo(existing, Date.now())) {
      // the deal survived the restart, its frames (local disk) may not have
      ensureEvidenceFrames(existing, dir);
      await purgeDemoDeal(DEMO.teamDealId);
      await s.create(orgId, J, teamDraftTerms(J, E, String(motion._id)), { id: DEMO.teamDealId });
      await seedDemoTeamContent({ orgId, team, projects: projectIds, nowMs: Date.now() });
      return {
        orgId,
        dealId: id,
        teamDealId: DEMO.teamDealId,
        judge: { userId: J, email: DEMO.judge.email },
        editor: { userId: E, email: DEMO.editor.email },
        reused: true,
      };
    }
  }

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
    {
      id: 'len',
      metric: 'duration_s',
      measured: 41.2,
      passed: true,
      t: 0,
      tEnd: 41.2,
      note: 'file runs 41.2s',
    },
    {
      id: 'hook',
      metric: 'hook_by_s',
      measured: 0.8,
      passed: true,
      t: 0.8,
      tEnd: 2.9,
      note: "first words at 0.8s: 'This autumn, slow down.'",
    },
    {
      id: 'logo',
      metric: 'logo_present',
      measured: true,
      passed: true,
      t: 0,
      tEnd: 3,
      note: 'logo matched (score 0.91) from 0.0s to 3.0s',
    },
    {
      id: 'loud',
      metric: 'loudness_lufs',
      measured: -20.1,
      passed: false,
      t: 12.4,
      tEnd: 12.4,
      note: 'integrated -20.1 LUFS, LRA 6.2, loudest moment at 12.4s',
    },
  ];
  await s.submitVersion(id, orgId, E, 'reel1', { id: 'v1', sha256: sha('lumen-reel1-v1') });
  await s.recordCheckReport(
    id,
    orgId,
    'reel1',
    report('reel1', 'v1', sha('lumen-reel1-v1'), v1, {
      loud: 'About 6 LU too quiet for the -14 LUFS target; raise the mix.',
    }),
  );
  writeFrames(dir, id, 'reel1', 'v1', v1);

  // Review Agent merge, then the client sends exactly those items
  const rv = await s.storeProposal(id, orgId, 'reel1', 'review', {
    versionId: 'v1',
    items: [
      { text: 'too quiet', tag: 'fix', checklistId: 'loud' },
      { text: 'make it feel cozier', tag: 'taste' },
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
    {
      ...v1[3],
      measured: -14.2,
      passed: true,
      note: 'integrated -14.2 LUFS, LRA 5.8, loudest moment at 12.4s',
    },
  ];
  await s.submitVersion(id, orgId, E, 'reel1', { id: 'v2', sha256: sha('lumen-reel1-v2') });
  await s.recordCheckReport(id, orgId, 'reel1', report('reel1', 'v2', sha('lumen-reel1-v2'), v2));
  writeFrames(dir, id, 'reel1', 'v2', v2);
  await s.approve(id, orgId, J, 'reel1', 'v2', false);
  await s.tick(id, orgId);

  // what a copilot asking to "capture $450" or "pay the old version" gets: blocked, on the ledger, no money moved
  await s.withDeal(id, orgId, async (deal: DealDoc) => {
    const a = await engine.execute(s.deps, deal, {
      kind: 'capture',
      milestoneKey: 'reel1',
      amountMinor: 45000,
      versionId: 'v2',
      final: true,
      reason: 'approval',
    });
    const b = await engine.execute(s.deps, a.deal, {
      kind: 'capture',
      milestoneKey: 'reel1',
      amountMinor: 40000,
      versionId: 'v1',
      final: true,
      reason: 'approval',
    });
    return { deal: b.deal, out: [a.result, b.result] };
  });

  // reel2: 4 of 5 checks pass (no captions) -> dispute -> 80% proposed; the editor has accepted it
  const r2: Line[] = [
    {
      id: 'len',
      metric: 'duration_s',
      measured: 29.5,
      passed: true,
      t: 0,
      tEnd: 29.5,
      note: 'file runs 29.5s',
    },
    {
      id: 'hook',
      metric: 'hook_by_s',
      measured: 1.1,
      passed: true,
      t: 1.1,
      tEnd: 2.6,
      note: 'first cut at 1.1s: the pour lands on the beat',
    },
    {
      id: 'logo',
      metric: 'logo_present',
      measured: true,
      passed: true,
      t: 0,
      tEnd: 3,
      note: 'logo matched (score 0.88) from 0.0s to 3.0s',
    },
    {
      id: 'loud',
      metric: 'loudness_lufs',
      measured: -14.4,
      passed: true,
      t: 8.2,
      tEnd: 8.2,
      note: 'integrated -14.4 LUFS, LRA 5.1, loudest moment at 8.2s',
    },
    {
      id: 'caps',
      metric: 'caption_present',
      measured: false,
      passed: false,
      t: 0,
      tEnd: 29.5,
      note: 'no caption track and no burned-in captions found (the LUMEN logo is the only on-screen text)',
    },
  ];
  await s.submitVersion(id, orgId, E, 'reel2', { id: 'v1', sha256: sha('lumen-reel2-v1') });
  await s.recordCheckReport(
    id,
    orgId,
    'reel2',
    report('reel2', 'v1', sha('lumen-reel2-v1'), r2, {
      caps: 'Captions were in the brief; none are on the file.',
    }),
  );
  writeFrames(dir, id, 'reel2', 'v1', r2);
  await s.openDispute(id, orgId, E, 'reel2');
  const dp = await s.storeProposal(id, orgId, 'reel2', 'dispute', {
    notes: 'Captions are the only signed line not met; the rest of the checklist passed.',
  });
  await s.acceptSplit(id, orgId, E, 'reel2', dp.out.workerMinor);

  // +15 s cut on reel2 (still open): out of scope, priced from the signed rate card ($60 x 1).
  // Left as a draft so the judge's one tap accepts it and drafts the PayPal invoice live.
  await s.draftChangeOrder(id, orgId, {
    milestoneKey: 'reel2',
    rateCardItemId: 'extra_cut',
    quantity: 1,
    ask: 'Add an extra 15-second cut for Instagram Stories',
    by: 'agent',
  });

  await seedClocks(s, id, orgId, E, dir, approve, must, J);

  // the team demo: unsigned, so the judge (client) can pick members and set the split
  await purgeDemoDeal(DEMO.teamDealId);
  await s.create(orgId, J, teamDraftTerms(J, E, String(motion._id)), { id: DEMO.teamDealId });

  // the cuts themselves: each reel's latest version points at its demo file (display only)
  await attachReelMedia(s, id, orgId);
  // team chat, review comments, version history, notifications, Brand Brain memory
  await seedDemoTeamContent({
    orgId,
    team,
    projects: projectIds,
    nowMs: Date.now(),
    fresh: !!opts.force,
  });

  return {
    orgId,
    dealId: id,
    teamDealId: DEMO.teamDealId,
    judge: { userId: J, email: DEMO.judge.email },
    editor: { userId: E, email: DEMO.editor.email },
    reused: false,
  };
}

/**
 * Point each reel's latest version at its demo cut (apps/web/public/demo/reels), so
 * the deal page can play it and the check time chips can seek it. Display data only:
 * no state, amount or check result changes.
 */
async function attachReelMedia(s: any, dealId: string, orgId: string) {
  await s.withDeal(dealId, orgId, async (d: DealDoc) => ({
    deal: {
      ...d,
      milestones: d.milestones.map((m) => {
        const url = REEL_MEDIA[m.key];
        if (!url || !m.versions.length) return m;
        const versions = m.versions.map((v, i) =>
          i === m.versions.length - 1 ? { ...v, mediaUrl: url } : v,
        );
        return { ...m, versions };
      }),
    },
    out: null,
  }));
}

/* ------------------------------------------------------- Fair Review Clock */

/**
 * The newest clock start (on the hour, going back from now) whose state
 * matches `want`. The clock maths is pure, so the seed picks a start that
 * gives the judge the same picture whatever the day: reel3 ~2 business days
 * left, reel4 just past its window and in grace.
 */
function pickStart(
  d: DealDoc,
  key: string,
  nowMs: number,
  want: (st: any, sched: any) => boolean,
): string {
  const t = d.terms.milestones.find((x) => x.key === key)!;
  const ct = reviewClock.clockTermsOf(d.terms, t);
  const now = new Date(nowMs).toISOString();
  let first: string | null = null;
  for (let h = 0; h <= 24 * 25; h += 1) {
    const start = new Date(Math.floor(nowMs / HOUR_MS) * HOUR_MS - h * HOUR_MS).toISOString();
    const sched = buildSchedule(start, ct, t.amountMinor);
    const st = clockState({ schedule: sched, now });
    if (want(st, sched)) return start;
    if (!first && st.status !== 'waiting_checks') first = start;
  }
  return first || now;
}

/**
 * Move a just-started clock back to `startISO`: the frozen schedule is rebuilt
 * from the same signed terms, and the version, its checks and the "started"
 * line move with it. Demo only; money is never touched here.
 */
async function rebaseClock(s: any, dealId: string, orgId: string, key: string, startISO: string) {
  await s.withDeal(dealId, orgId, async (d: DealDoc) => {
    const t = d.terms.milestones.find((x) => x.key === key)!;
    const ct = reviewClock.clockTermsOf(d.terms, t);
    const milestones = d.milestones.map((m) => {
      if (m.key !== key || !m.clock) return m;
      const schedule = buildSchedule(startISO, ct, t.amountMinor);
      schedule.currency = d.terms.currency;
      const versions = m.versions.map((v, i) =>
        i === m.versions.length - 1
          ? {
              ...v,
              submittedAt: startISO,
              checks: v.checks ? { ...v.checks, at: startISO } : v.checks,
            }
          : v,
      );
      return {
        ...m,
        versions,
        reviewStartedAt: startISO,
        clock: {
          ...m.clock,
          startedAt: startISO,
          schedule,
          timeline: m.clock.timeline.map((e) => (e.id === 'started' ? { ...e, at: startISO } : e)),
        },
      };
    });
    return { deal: { ...d, milestones }, out: null };
  });
}

/**
 * Run the steps already due (as the driver would), reminders silently, then
 * date each reminder line at its scheduled time and label it: the seed wrote
 * that history, no reminder was sent.
 */
async function runDueSteps(s: any, dealId: string, orgId: string, key: string) {
  let d: DealDoc = await s.get(dealId, orgId);
  const m = d.milestones.find((x) => x.key === key)!;
  const due: string[] = reviewClock.dueFor(m.clock, new Date().toISOString());
  for (const stepId of due) {
    const r = await s.runClockStep(dealId, key, stepId, { silent: !stepId.startsWith('release_') });
    if (!r.out.ok)
      throw new Error(
        `demo seed: clock step ${key}:${stepId} did not complete (${r.out.note || 'refused'})`,
      );
  }
  const at = new Map<string, string>(
    (m.clock!.schedule.steps as { id: string; atISO: string }[]).map((x) => [x.id, x.atISO]),
  );
  await s.withDeal(dealId, orgId, async (doc: DealDoc) => {
    d = {
      ...doc,
      milestones: doc.milestones.map((x) =>
        x.key !== key || !x.clock
          ? x
          : {
              ...x,
              clock: {
                ...x.clock,
                timeline: x.clock.timeline.map((e) =>
                  e.kind === 'step' && !e.id.startsWith('release_') && at.has(e.id)
                    ? {
                        ...e,
                        at: at.get(e.id)!,
                        note: 'reminder logged by the demo seed (not sent)',
                      }
                    : e,
                ),
              },
            },
      ),
    };
    return { deal: d, out: null };
  });
}

/**
 * reel3 and reel4 on the Fair Review Clock. Both are held, delivered and pass
 * every check (which starts the clock), then:
 *   reel3  running, about 2 business days left (no reply yet)
 *   reel4  no reply in its window: 50% released and paid out 70/30, now in grace
 * Every money step goes through the service (policy, ledger, lock).
 */
async function seedClocks(
  s: any,
  id: string,
  orgId: string,
  E: string,
  dir: string | false,
  approve: (orderId: string) => unknown,
  must: (r: { out: any }, what: string) => unknown,
  J: string,
) {
  for (const key of ['reel3', 'reel4']) {
    const d = await s.startFunding(id, orgId, J, key);
    approve(d.milestones.find((m: { key: string }) => m.key === key)!.funding!.orderId!);
    must(await s.confirmFunding(id, orgId, J, key), `hold on ${key}`);
  }
  const lines: Record<string, Line[]> = {
    reel3: [
      {
        id: 'len',
        metric: 'duration_s',
        measured: 14.6,
        passed: true,
        t: 0,
        tEnd: 14.6,
        note: 'file runs 14.6s',
      },
      {
        id: 'hook',
        metric: 'hook_by_s',
        measured: 0.6,
        passed: true,
        t: 0.6,
        tEnd: 2.4,
        note: "first words at 0.6s: 'Your autumn cup is ready.'",
      },
      {
        id: 'logo',
        metric: 'logo_present',
        measured: true,
        passed: true,
        t: 0,
        tEnd: 3,
        note: 'logo matched (score 0.93) from 0.0s to 3.0s',
      },
      {
        id: 'loud',
        metric: 'loudness_lufs',
        measured: -14.2,
        passed: true,
        t: 6.3,
        tEnd: 6.3,
        note: 'integrated -14.2 LUFS, LRA 4.9, loudest moment at 6.3s',
      },
    ],
    reel4: [
      {
        id: 'len',
        metric: 'duration_s',
        measured: 5.8,
        passed: true,
        t: 0,
        tEnd: 5.8,
        note: 'file runs 5.8s',
      },
      {
        id: 'logo',
        metric: 'logo_present',
        measured: true,
        passed: true,
        t: 0,
        tEnd: 3,
        note: 'logo matched (score 0.95) from 0.0s to 3.0s',
      },
      {
        id: 'loud',
        metric: 'loudness_lufs',
        measured: -13.8,
        passed: true,
        t: 2.1,
        tEnd: 2.1,
        note: 'integrated -13.8 LUFS, LRA 3.2, loudest moment at 2.1s',
      },
    ],
  };
  const nowMs = Date.now();
  for (const key of ['reel3', 'reel4']) {
    const v = sha(`lumen-${key}-v1`);
    await s.submitVersion(id, orgId, E, key, { id: 'v1', sha256: v });
    await s.recordCheckReport(id, orgId, key, report(key, 'v1', v, lines[key]));
    writeFrames(dir, id, key, 'v1', lines[key]);
  }
  const d0: DealDoc = await s.get(id, orgId);
  // reel3: the newest start with exactly 2 business days left
  await rebaseClock(
    s,
    id,
    orgId,
    'reel3',
    pickStart(d0, 'reel3', nowMs, (st) => st.status === 'running' && st.businessDaysLeft === 2),
  );
  // reel4: the newest start whose window ended (partial released) with at most 3 days of grace left
  await rebaseClock(
    s,
    id,
    orgId,
    'reel4',
    pickStart(
      d0,
      'reel4',
      nowMs,
      (st, sched) =>
        st.status === 'released_partial' && Date.parse(sched.graceDeadline) - nowMs <= 72 * HOUR_MS,
    ),
  );
  await runDueSteps(s, id, orgId, 'reel3');
  await runDueSteps(s, id, orgId, 'reel4');
}

async function demoJudge() {
  return User.findOne({ email: DEMO.judge.email, disabled: { $ne: true } });
}

/** The seeded crew member (Leo Carter, editor), or null: the crew view of the demo. */
async function demoEditor() {
  return User.findOne({ email: DEMO.editor.email, disabled: { $ne: true } });
}

module.exports = {
  DEMO,
  DEMO_PROJECTS,
  seedDealDemo,
  demoJudge,
  demoEditor,
  demoTerms,
  untouchedRealDemo,
  clocksAsSeeded,
  ensureEvidenceFrames,
};
