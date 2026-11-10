/**
 * deals/demo-content: the people side of the judge demo (Lumen Coffee, "Autumn
 * launch reels"), seeded next to the deal so a judge sees a real workflow at a
 * glance. Display data only: nothing here touches a deal, an amount or a clock.
 *
 *   REEL_MEDIA                 reel key -> its demo cut (apps/web/public/demo/reels, real Pexels footage)
 *   demoFrame(name)            a bundled evidence still (demo-media/<name>.png) or null
 *   seedDemoTeamContent(opts)  team chat (#general, #autumn-launch), version history and
 *                              timecoded review comments on the reel projects, notifications,
 *                              and Brand Brain's brand memory + one sample conversation
 *
 * Idempotent: every record this file writes carries `demoSeed: true` (written
 * through the raw collections so the seeded timestamps stick) and is replaced on
 * each seed; anything a judge adds is left alone.
 */
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const Project = require('../../models/project.model');
const Channel = require('../../models/channel.model');
const ChatMessage = require('../../models/chatMessage.model');
const Comment = require('../../models/comment.model');
const ProjectVersion = require('../../models/projectVersion.model');
const Notification = require('../../models/notification.model');
const Organization = require('../../models/organization.model');
const { BrandRule } = require('../../models/agent');

const REEL_MEDIA: Record<string, string> = {
  reel1: '/demo/reels/lumen-reel1.mp4',
  reel2: '/demo/reels/lumen-reel2.mp4',
  reel3: '/demo/reels/lumen-reel3.mp4',
  reel4: '/demo/reels/lumen-reel4.mp4',
};
const MEDIA_DIR = path.join(__dirname, 'demo-media');
/** The web's public folder, when the API runs from the monorepo (for project version files). */
const REELS_DIR = path.resolve(__dirname, '../../../../web/public/demo/reels');
const DEMO_REF = 'demo:';
const FRAME = /^reel[1-4]_[a-z]{2,8}_v[0-9]_[0-9]{3}\.[0-9]{2}\.png$/;

function demoFrame(name: string): Buffer | null {
  if (typeof name !== 'string' || !FRAME.test(name)) return null;
  try {
    return fs.readFileSync(path.join(MEDIA_DIR, name));
  } catch {
    return null;
  }
}

type Team = { judge: string; editor: string; motion: string; reviewer: string; publisher: string };
type Who = keyof Team;
const HOUR = 3600 * 1000;
const oid = (id: string) => new mongoose.Types.ObjectId(String(id));

/* ------------------------------------------------------------------ team chat */

const CHAT: { channel: 'general' | 'autumn-launch'; h: number; who: Who; text: string }[] = [
  {
    channel: 'general',
    h: 160,
    who: 'judge',
    text: 'Welcome to the Lumen Coffee workspace, Alex, Leo, Maya and Mei!',
  },
  {
    channel: 'general',
    h: 159.6,
    who: 'publisher',
    text: "Hi all! I'll take care of publishing and the posting calendar.",
  },
  {
    channel: 'autumn-launch',
    h: 150,
    who: 'judge',
    text: 'Kicking off the Autumn launch reels. Brief is on each project: 4 reels, LUMEN logo in the first 3s, captions bottom third, mix at -14 LUFS.',
  },
  {
    channel: 'autumn-launch',
    h: 149.7,
    who: 'reviewer',
    text: "I'll review against the brief. This round is Ember Roast and Harvest Blend, no Cold Brew Cans.",
  },
  {
    channel: 'autumn-launch',
    h: 149.4,
    who: 'editor',
    text: 'On it. Reel 1 and the teaser first, story cut and bumper after.',
  },
  {
    channel: 'autumn-launch',
    h: 149.1,
    who: 'motion',
    text: "I'll build the logo sting and the captions template.",
  },
  { channel: 'autumn-launch', h: 121, who: 'editor', text: 'Reel 1 v1 is up.' },
  {
    channel: 'autumn-launch',
    h: 120.6,
    who: 'editor',
    text: 'Checks flagged loudness on reel 1: -20.1 LUFS against -14. Fixing the mix.',
  },
  {
    channel: 'autumn-launch',
    h: 120.2,
    who: 'reviewer',
    text: 'Review note on reel 1: too quiet around 0:12 (fix). A slightly cozier grade would be nice (taste, your call).',
  },
  { channel: 'autumn-launch', h: 101, who: 'editor', text: 'v2 uploaded, every check is green.' },
  {
    channel: 'autumn-launch',
    h: 98.5,
    who: 'judge',
    text: 'Approved reel 1. The payout goes out now, 70/30 Leo and Maya as signed.',
  },
  { channel: 'autumn-launch', h: 97.9, who: 'motion', text: 'Payday! Thank you Nora.' },
  { channel: 'autumn-launch', h: 97.6, who: 'editor', text: 'Got mine too, thanks!' },
  { channel: 'autumn-launch', h: 74, who: 'editor', text: 'Reel 2 teaser is up.' },
  {
    channel: 'autumn-launch',
    h: 73.4,
    who: 'reviewer',
    text: 'Captions check failed on reel 2. Brief item 2 says captions on, bottom third. Comment left at 0:04.',
  },
  {
    channel: 'autumn-launch',
    h: 73.0,
    who: 'editor',
    text: "That's on me, the captions didn't export. Maya, can you burn them in?",
  },
  { channel: 'autumn-launch', h: 72.6, who: 'motion', text: 'Yes, captioned version tomorrow.' },
  {
    channel: 'autumn-launch',
    h: 50,
    who: 'judge',
    text: 'We also want an extra 15s cut for Stories. Leo, raise it as a change order so it is priced from the rate card.',
  },
  {
    channel: 'autumn-launch',
    h: 49.5,
    who: 'editor',
    text: 'Change order drafted: +15s cut, $60 from the rate card. Waiting on your tap.',
  },
  {
    channel: 'autumn-launch',
    h: 26,
    who: 'editor',
    text: 'Reel 3 story cut and reel 4 bumper are up. Checks passed on both.',
  },
  {
    channel: 'autumn-launch',
    h: 25.4,
    who: 'publisher',
    text: 'Reel 1 has a Thursday 9am ET slot pencilled in for Reels and Shorts.',
  },
];

async function seedChat(orgId: string, team: Team, nowMs: number, fresh: boolean) {
  const org = oid(orgId);
  const chat = await Project.findOneAndUpdate(
    { organizationId: orgId, title: 'Team Chat' },
    {
      $setOnInsert: {
        organizationId: orgId,
        title: 'Team Chat',
        description: 'Team conversations',
        type: 'Content Production',
        status: 'IN_PROGRESS',
        creator: team.judge,
      },
    },
    { upsert: true, new: true },
  );
  const channels: Record<string, any> = {};
  for (const name of ['general', 'autumn-launch']) {
    const c = await Channel.findOneAndUpdate(
      { organizationId: orgId, projectId: chat._id, name, type: 'channel' },
      {
        $setOnInsert: {
          organizationId: orgId,
          projectId: chat._id,
          name,
          type: 'channel',
          createdBy: team.judge,
        },
      },
      { upsert: true, new: true },
    );
    channels[name] = c._id;
  }
  // channels sort by createdAt: #general first
  await Channel.collection.updateOne(
    { _id: channels.general },
    { $set: { createdAt: new Date(nowMs - 170 * HOUR) } },
  );
  await Channel.collection.updateOne(
    { _id: channels['autumn-launch'] },
    { $set: { createdAt: new Date(nowMs - 169 * HOUR) } },
  );
  // a reset starts the demo chat over; a plain boot keeps what people wrote
  await ChatMessage.collection.deleteMany(
    fresh
      ? { organizationId: org, channelId: { $in: [channels.general, channels['autumn-launch']] } }
      : { organizationId: org, demoSeed: true },
  );
  await ChatMessage.collection.insertMany(
    CHAT.map((m) => {
      const at = new Date(nowMs - m.h * HOUR);
      return {
        organizationId: org,
        projectId: chat._id,
        channelId: channels[m.channel],
        author: oid(team[m.who]),
        parentId: null,
        body: m.text,
        attachments: [],
        sentAt: at,
        createdAt: at,
        updatedAt: at,
        demoSeed: true,
        __v: 0,
      };
    }),
  );
}

/* ------------------------------------------- versions, review comments, notifications */

type VersionSeed = {
  project: string;
  n: number;
  h: number;
  who: Who;
  file: string;
  summary: string;
};
const VERSIONS: VersionSeed[] = [
  {
    project: 'reel1',
    n: 1,
    h: 121,
    who: 'editor',
    file: 'lumen-reel1.mp4',
    summary: 'First cut (checks: loudness -20.1 LUFS, failed)',
  },
  {
    project: 'reel1',
    n: 2,
    h: 101,
    who: 'editor',
    file: 'lumen-reel1.mp4',
    summary: 'Mix raised to -14 LUFS; all checks pass',
  },
  {
    project: 'reel2',
    n: 1,
    h: 74,
    who: 'editor',
    file: 'lumen-reel2.mp4',
    summary: 'Teaser cut (checks: captions missing)',
  },
  {
    project: 'reel3',
    n: 1,
    h: 26,
    who: 'editor',
    file: 'lumen-reel3.mp4',
    summary: 'Story cut; all checks pass',
  },
  {
    project: 'reel4',
    n: 1,
    h: 25.8,
    who: 'motion',
    file: 'lumen-reel4.mp4',
    summary: 'Bumper with logo sting; all checks pass',
  },
];

type CommentSeed = {
  project: string;
  v: number;
  h: number;
  who: Who;
  t: number;
  text: string;
  resolved?: boolean;
  reply?: number;
};
const COMMENTS: CommentSeed[] = [
  {
    project: 'reel1',
    v: 1,
    h: 120.3,
    who: 'reviewer',
    t: 12.4,
    text: 'Too quiet here. The brief asks for -14 LUFS; the check measured -20.1.',
    resolved: true,
  },
  {
    project: 'reel1',
    v: 1,
    h: 120.2,
    who: 'reviewer',
    t: 6,
    text: 'Could the grade feel a little cozier? Taste note, your call.',
    resolved: true,
  },
  {
    project: 'reel1',
    v: 2,
    h: 98.7,
    who: 'reviewer',
    t: 0,
    text: 'Approved from my side: logo in the first 3s, mix sits right.',
    resolved: true,
  },
  {
    project: 'reel2',
    v: 1,
    h: 73.5,
    who: 'reviewer',
    t: 4,
    text: "Captions are missing. Brief item 2: 'Captions on, bottom third'. Please burn them in before approval.",
  },
  {
    project: 'reel2',
    v: 1,
    h: 73.1,
    who: 'editor',
    t: 4,
    text: 'Maya is burning them in for the next version.',
    reply: 3,
  },
  {
    project: 'reel2',
    v: 1,
    h: 72.9,
    who: 'judge',
    t: 1.1,
    text: 'Love the pour landing on the first beat.',
  },
  {
    project: 'reel3',
    v: 1,
    h: 20,
    who: 'reviewer',
    t: 0.6,
    text: 'Hook works. Checking the swipe-up line with legal before I approve.',
  },
];

/**
 * The demo cut as a project version file. It is not copied into the uploads dir (that dir
 * is ephemeral on the host and the web's public folder is not deployed with the API):
 * the ref `demo:<name>` is served by the file stream route from the bundled copy when
 * the API has one, else redirected to the web's static /demo/reels/<name>.
 */
function demoReelFile(name: string, uploader: string) {
  let size = 0;
  try {
    size = fs.statSync(path.join(REELS_DIR, name)).size;
  } catch {
    size = 0;
  }
  return {
    _id: new mongoose.Types.ObjectId(),
    filename: name,
    mimeType: 'video/mp4',
    size,
    storageRef: `${DEMO_REF}${name}`,
    uploadedBy: oid(uploader),
  };
}

/** `demo:lumen-reelN.mp4` -> the reel's file name, or null for any other ref. */
function demoReelName(storageRef: unknown): string | null {
  if (typeof storageRef !== 'string' || !storageRef.startsWith(DEMO_REF)) return null;
  const name = storageRef.slice(DEMO_REF.length);
  return Object.values(REEL_MEDIA).some((u) => u.endsWith(`/${name}`)) ? name : null;
}

/** Absolute path of a bundled demo reel when this process has the web's public folder. */
function demoReelPath(name: string): string | null {
  const p = path.join(REELS_DIR, name);
  return fs.existsSync(p) ? p : null;
}

async function seedReviewTrail(
  orgId: string,
  team: Team,
  projects: Record<string, string>,
  nowMs: number,
) {
  const org = oid(orgId);
  const pids = Object.values(projects).map(oid);
  await ProjectVersion.collection.deleteMany({ organizationId: org, demoSeed: true });
  await Comment.collection.deleteMany({ organizationId: org, demoSeed: true });

  const vid: Record<string, unknown> = {};
  for (const v of VERSIONS) {
    const projectId = projects[v.project];
    if (!projectId) continue;
    const taken = await ProjectVersion.collection.findOne({
      projectId: oid(projectId),
      versionNumber: v.n,
    });
    if (taken) continue; // a judge's own upload holds this number
    const file = demoReelFile(v.file, team[v.who]);
    const at = new Date(nowMs - v.h * HOUR);
    const r = await ProjectVersion.collection.insertOne({
      organizationId: org,
      projectId: oid(projectId),
      versionNumber: v.n,
      uploader: oid(team[v.who]),
      metadata: { source: 'demo seed' },
      changeSummary: v.summary,
      files: [file],
      createdAt: at,
      updatedAt: at,
      demoSeed: true,
      __v: 0,
    });
    vid[`${v.project}:${v.n}`] = r.insertedId;
  }
  const ids: unknown[] = [];
  for (const c of COMMENTS) {
    const projectId = projects[c.project];
    if (!projectId) {
      ids.push(null);
      continue;
    }
    const at = new Date(nowMs - c.h * HOUR);
    const r = await Comment.collection.insertOne({
      organizationId: org,
      projectId: oid(projectId),
      versionId: vid[`${c.project}:${c.v}`] || null,
      author: oid(team[c.who]),
      parentId: c.reply !== undefined ? ids[c.reply] || null : null,
      body: c.text,
      resolved: !!c.resolved,
      timecode: c.t,
      createdAt: at,
      updatedAt: at,
      demoSeed: true,
      __v: 0,
    });
    ids.push(r.insertedId);
  }

  // notifications (no dealId in the payload: the deal's own clock notices stay separate)
  const note = (
    who: Who,
    type: string,
    project: string,
    h: number,
    title: string,
    body: string,
    read = false,
  ) => {
    const at = new Date(nowMs - h * HOUR);
    return {
      userId: oid(team[who]),
      type,
      projectId: projects[project] ? oid(projects[project]) : null,
      title,
      body,
      payload: { demoSeed: true },
      read,
      readAt: read ? at : null,
      createdAt: at,
      updatedAt: at,
      demoSeed: true,
      __v: 0,
    };
  };
  await Notification.collection.deleteMany({
    userId: { $in: Object.values(team).map(oid) },
    demoSeed: true,
  });
  await Notification.collection.insertMany([
    note(
      'judge',
      'review',
      'reel3',
      25.9,
      'Reel 3 is waiting for your review',
      'Leo Carter uploaded the 15s story cut. Every check passed; the review clock is running.',
    ),
    note(
      'judge',
      'review',
      'reel4',
      25.7,
      'Reel 4 is waiting for your review',
      'Maya Ortiz uploaded the 6s bumper. Every check passed.',
    ),
    note(
      'judge',
      'revision',
      'reel2',
      49.4,
      'Change order on Reel 2',
      'Leo Carter drafted a +15s cut at $60 from the signed rate card. It waits for your tap.',
    ),
    note(
      'judge',
      'comment',
      'reel2',
      73.5,
      'Alex Morgan commented on Reel 2 at 0:04',
      "Captions are missing. Brief item 2: 'Captions on, bottom third'.",
    ),
    note(
      'judge',
      'revision',
      'reel2',
      73.9,
      'Checks failed on Reel 2',
      'Captions: none found on the file (brief item 2). 4 of 5 checks passed.',
      true,
    ),
    note(
      'judge',
      'approval',
      'reel1',
      98.4,
      'Reel 1 approved and paid out',
      '$400 captured and paid 70/30 to Leo Carter and Maya Ortiz.',
      true,
    ),
    note(
      'editor',
      'approval',
      'reel1',
      98.3,
      'Payout sent for Reel 1',
      'Your 70% share of Reel 1 is on its way to PayPal.',
    ),
    note(
      'motion',
      'approval',
      'reel1',
      98.3,
      'Payout sent for Reel 1',
      'Your 30% share of Reel 1 is on its way to PayPal.',
    ),
    note(
      'editor',
      'comment',
      'reel2',
      73.5,
      'Alex Morgan commented on Reel 2 at 0:04',
      "Captions are missing. Brief item 2: 'Captions on, bottom third'.",
    ),
    note(
      'reviewer',
      'review',
      'reel3',
      25.9,
      'Reel 3 is ready for review',
      'Every check passed; the review clock is running.',
    ),
    note(
      'publisher',
      'approval',
      'reel1',
      98.4,
      'Reel 1 is approved',
      'Ready to schedule for Instagram Reels and YouTube Shorts.',
    ),
  ]);
}

/* ------------------------------------------------------------- Brand Brain memory */

const BRAND_MEMORY = [
  {
    kind: 'purpose',
    title: 'Who Lumen Coffee is',
    body: 'Lumen Coffee is a specialty coffee roaster with cafes in North America and Europe. Every piece of content should feel like the first warm cup on a cold morning: calm, inviting, never loud.',
  },
  {
    kind: 'voice',
    title: 'Voice and tone',
    body: 'Warm, unhurried and confident. Short sentences in second person ("your cup", "your morning"). Light humour is fine; hype and urgency are not. Write in US English.',
  },
  {
    kind: 'do',
    title: 'Words to use',
    body: 'slow down, warm, small-batch, roasted, cozy, ritual, morning, your cafe, harvest, toasted, caramel. Name the product (Ember Roast, Harvest Blend, Cold Brew Cans) in the caption.',
  },
  {
    kind: 'dont',
    title: 'Words to avoid',
    body: 'Never use "Buy now", "limited time", "cheap", "deal", "best coffee in the world", "addictive" or any health claim (energy, focus, weight loss). No exclamation marks in on-screen captions.',
  },
  {
    kind: 'visual',
    title: 'Logo and colour rules',
    body: 'The LUMEN wordmark is on screen in the first 3 seconds of every reel, in cream (#FFF4E6) on footage, never stretched or recoloured. Warm palette only: cream, caramel (#F2B66D), espresso brown (#3B1F0E). Captions on, bottom third, max two lines.',
  },
  {
    kind: 'audience',
    title: 'Audience',
    body: 'Urban coffee lovers aged 22 to 40 in the US, Canada, UK and Germany who treat coffee as a daily ritual; they watch Reels and Shorts on mute, so captions carry the story.',
  },
  {
    kind: 'do',
    title: 'Past campaign learning: Spring Bloom 2026',
    body: 'Reels that opened on a pour close-up inside the first second kept 31% more viewers at 3 seconds than reels that opened on the logo alone. Lead with the pour; let the logo sit over it.',
  },
  {
    kind: 'do',
    title: 'Past campaign learning: Summer Cold Brew 2026',
    body: 'Captioned cuts got 2.4x the shares of uncaptioned ones because most viewers watch muted. A reel without captions is not approved.',
  },
  {
    kind: 'do',
    title: 'Past campaign learning: Holiday 2025',
    body: 'Mixes louder than -13 LUFS drew "too loud" comments on Shorts; -14 LUFS (plus or minus 1) is the house target. Bumpers under 6 seconds performed best as pre-roll.',
  },
  {
    kind: 'resource',
    title: 'Product list',
    body: 'Ember Roast: dark roast, notes of caramel and toasted pecan, the autumn hero. Harvest Blend: medium roast, seasonal, back every autumn. Cold Brew Cans: ready-to-drink, summer focus, not part of the autumn launch.',
  },
  {
    kind: 'resource',
    title: 'Brief template',
    body: 'Every reel brief lists: 1) goal and product, 2) length and format (9:16), 3) LUMEN logo in the first 3s, 4) captions on, bottom third, 5) mix at -14 LUFS, 6) hook in the first 3s, 7) call to action ("Find it at your Lumen cafe"), 8) channels and posting date, 9) owner and reviewer.',
  },
];

const SAMPLE_THREAD = [
  {
    q: 'Can we end the teaser with "Buy now, limited time"?',
    a: 'No. "Buy now" and "limited time" are both on the words-to-avoid list, and the voice is unhurried rather than urgent. Use the call to action from the brief template instead: "Find it at your Lumen cafe."',
    cites: ['Words to avoid', 'Voice and tone', 'Brief template'],
  },
  {
    q: 'What should open reel 3?',
    a: 'Lead with a pour close-up in the first second and keep the LUMEN wordmark over it for the first 3 seconds. Spring Bloom 2026 showed pour openers kept 31% more viewers at 3 seconds, and the logo rule asks for the wordmark in the first 3 seconds.',
    cites: ['Past campaign learning: Spring Bloom 2026', 'Logo and colour rules'],
  },
  {
    q: 'Which product is the hero this autumn?',
    a: 'Ember Roast: the dark roast with notes of caramel and toasted pecan. Harvest Blend is the seasonal second product. Cold Brew Cans are a summer focus and stay out of the autumn launch.',
    cites: ['Product list'],
  },
];

async function seedBrandMemory(orgId: string) {
  await BrandRule.deleteMany({ organizationId: orgId });
  await BrandRule.insertMany(BRAND_MEMORY.map((b) => ({ ...b, organizationId: orgId })));
  await Organization.updateOne(
    { _id: orgId },
    { $set: { 'settings.brandBrainSample': SAMPLE_THREAD } },
  );
}

async function seedDemoTeamContent(opts: {
  orgId: string;
  team: Team;
  projects: Record<string, string>;
  nowMs: number;
  /** a demo reset: the two demo channels start over (people's own messages there go too) */
  fresh?: boolean;
}) {
  const { orgId, team, projects, nowMs } = opts;
  await seedChat(orgId, team, nowMs, !!opts.fresh);
  await seedReviewTrail(orgId, team, projects, nowMs);
  await seedBrandMemory(orgId);
}

module.exports = {
  REEL_MEDIA,
  demoFrame,
  demoReelName,
  demoReelPath,
  seedDemoTeamContent,
  BRAND_MEMORY,
  SAMPLE_THREAD,
};
