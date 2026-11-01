/**
 * Seeds an NGO-style demo org for the agent platform: posts, a
 * time-series of metrics, YouTube retention curves (one with a rewatch spike
 * at 0:42), transcript + scene cuts, brand knowledge and reviewer comments.
 * All data is synthetic. Idempotent: wipes and re-creates the demo org's
 * agent collections.
 *
 *   MONGO_URI=... node scripts/seed-agent-demo.js   -> prints {orgId, postIds, login}
 */
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../src/models/user.model');
const Organization = require('../src/models/organization.model');
const Membership = require('../src/models/membership.model');
const { seedDefaultRoles } = require('../src/seed/roles');
const A = require('../src/models/agent');

const LOGIN = { email: process.env.DEMO_EMAIL || 'demo.ngo@example.com', password: process.env.DEMO_PASSWORD || 'demo1234' };
const ORG = { name: 'Little Steps Workshops (demo)', slug: 'littlesteps-demo' };
const DAY = 86400000;

const POSTS = [
  { key: 'breath', platform: 'youtube', format: 'short', durationSec: 58, title: '3 breathing cues for the third trimester', tags: ['breathing', 'trimester-3', 'telugu'], views: 184000, likes: 12100, comments: 640, shares: 2900, saves: 0, avd: 49 },
  { key: 'garbh', platform: 'youtube', format: 'long', durationSec: 480, title: 'Garbh Sanskar explained in 8 minutes', tags: ['garbh-sanskar', 'explainer'], views: 41000, likes: 1900, comments: 210, shares: 300, saves: 0, avd: 182 },
  { key: 'dads', platform: 'youtube', format: 'short', durationSec: 45, title: 'What dads can do in week 30', tags: ['dads', 'trimester-3'], views: 9800, likes: 410, comments: 22, shares: 35, saves: 0, avd: 19 },
  { key: 'lullaby', platform: 'instagram', format: 'reel', durationSec: 30, title: 'A Telugu lullaby for your bump (30s)', tags: ['lullaby', 'telugu', 'music'], views: 96000, likes: 8800, comments: 410, shares: 2100, saves: 6400, avd: 0 },
  { key: 'myth', platform: 'instagram', format: 'reel', durationSec: 24, title: 'Myth vs fact: eating for two', tags: ['nutrition', 'myth'], views: 38000, likes: 2100, comments: 190, shares: 520, saves: 900, avd: 0 },
  { key: 'bts', platform: 'instagram', format: 'reel', durationSec: 35, title: 'Workshop day, behind the scenes', tags: ['bts', 'community'], views: 7200, likes: 380, comments: 18, shares: 12, saves: 40, avd: 0 },
];

const BRAND = [
  { kind: 'purpose', title: 'Why Little Steps exists', body: 'Calm, evidence-informed guidance for expecting parents through small-group workshops. Content should leave viewers feeling reassured, never anxious.' },
  { kind: 'voice', title: 'Voice and language', body: 'Warm, like an elder sister. Telugu-first with simple English words where natural. Second person ("you", "mee"). No fear-based hooks.' },
  { kind: 'dont', title: 'No medical advice', body: 'Never prescribe or diagnose. Any health claim ends with "please check with your doctor". Show the on-screen disclaimer "Not medical advice" in the first 3 seconds of health videos.' },
  { kind: 'visual', title: 'Visual identity', body: 'Teal #035E5E accents on warm off-white; natural light; real mothers who signed consent forms; captions always on, bottom-third, max 2 lines.' },
  { kind: 'do', title: 'Hooks', body: 'Open with a physical action the viewer can do right now (place a palm, breathe in) within the first 2 seconds. Close-ups of hands work better than wide shots.' },
  { kind: 'do', title: 'Call to action', body: 'End every video with "Join the next workshop" and the link in bio. Never use "Buy now" or discount language.' },
  { kind: 'audience', title: 'Audience', body: 'First-time parents aged 24-34 in Telangana and Andhra Pradesh, plus grandparents who share videos on WhatsApp.' },
  { kind: 'resource', title: 'Workshop calendar sheet', body: 'Shared Google Sheet with every upcoming workshop date and city. Purpose: the single source of truth for dates mentioned in captions.', sourceUrl: 'https://docs.google.com/spreadsheets/d/demo-workshop-calendar' },
];

// What is spoken / on screen in the winning short (transcript as Whisper segments).
const BREATH_TRANSCRIPT = [
  { start: 0, end: 4, text: 'Sit back, place one hand on your belly. Breathe in with me.' },
  { start: 4, end: 14, text: 'Cue one: four counts in through the nose, feel your ribs widen sideways.' },
  { start: 14, end: 26, text: 'Cue two: a long hum on the way out. Your baby hears this hum as a gentle vibration.' },
  { start: 26, end: 38, text: 'Cue three: drop your shoulders, unclench the jaw, slow the exhale to six counts.' },
  { start: 38, end: 46, text: 'Now keep your palm right here. Feel that? That little kick is your baby responding to the hum.' },
  { start: 46, end: 58, text: 'Practise this every night this week, and join the next workshop to learn the full routine.' },
];
const BREATH_SCENES = [
  { second: 0, label: 'Mother on sofa, caption "Breathe with me"' },
  { second: 13.5, label: 'Graphic: rib-cage outline widening' },
  { second: 25.8, label: 'Mid shot, shoulders relaxing' },
  { second: 41.2, label: 'Close-up: palm on belly, visible kick, caption "Feel that?"' },
  { second: 46.5, label: 'End card: "Join the next workshop"' },
];

function retentionCurve(durationSec, { spikeAt = null, decay = 0.006, start = 1.0 } = {}) {
  const step = durationSec > 120 ? Math.round(durationSec / 100) : 1;
  const pts = [];
  for (let s = 0; s <= durationSec; s += step) {
    let r = start * Math.exp(-decay * s) * (s < 3 ? 1 : 0.93);
    if (spikeAt !== null) r += 0.42 * Math.exp(-((s - spikeAt) ** 2) / (2 * 1.6 ** 2));
    pts.push({ second: s, audienceWatchRatio: Math.round(r * 1000) / 1000 });
  }
  return pts;
}

async function seedAgentDemo({ now = new Date() } = {}) {
  await seedDefaultRoles();
  const org = await Organization.findOneAndUpdate({ slug: ORG.slug }, { $set: ORG }, { upsert: true, new: true });
  const passwordHash = bcrypt.hashSync(LOGIN.password, 10);
  const user = await User.findOneAndUpdate({ email: LOGIN.email }, { $set: { name: 'Demo Admin', passwordHash } }, { upsert: true, new: true });
  await Membership.findOneAndUpdate({ userId: user._id, organizationId: org._id }, { $set: { role: 'admin', disabled: false } }, { upsert: true, new: true });

  const orgId = org._id;
  for (const M of [A.Post, A.Asset, A.BrandRule, A.RetentionPoint, A.Insight, A.ReviewComment, A.AgentJob]) await M.deleteMany({ organizationId: orgId });
  await A.Metric.deleteMany({ 'meta.organizationId': orgId });

  const ids = {};
  for (const [i, p] of POSTS.entries()) {
    const post = await A.Post.create({
      organizationId: orgId,
      platform: p.platform,
      externalId: `${p.platform}-demo-${p.key}`,
      title: p.title,
      caption: p.title,
      format: p.format,
      durationSec: p.durationSec,
      publishedAt: new Date(now.getTime() - (8 + i * 3) * DAY),
      tags: p.tags,
      source: 'fixture',
    });
    ids[p.key] = String(post._id);
    // 7 daily cumulative snapshots ramping to the final value
    const rows = [];
    const keys = ['views', 'likes', 'comments', 'shares', 'saves'].filter((k) => !(p.platform === 'youtube' && k === 'saves'));
    for (let d = 6; d >= 0; d--) {
      const frac = 1 - d * 0.12;
      const ts = new Date(now.getTime() - d * DAY);
      for (const k of keys) rows.push({ ts, meta: { organizationId: orgId, postId: post._id, metric: k, source: 'fixture' }, value: Math.round(p[k] * frac) });
      if (p.avd) rows.push({ ts, meta: { organizationId: orgId, postId: post._id, metric: 'avgViewDurationSec', source: 'fixture' }, value: p.avd });
    }
    await A.Metric.insertMany(rows);
    if (p.platform === 'youtube') {
      const curve = retentionCurve(p.durationSec, p.key === 'breath' ? { spikeAt: 42, decay: 0.004 } : { decay: p.key === 'dads' ? 0.02 : 0.004 });
      await A.RetentionPoint.insertMany(curve.map((c) => ({ ...c, organizationId: orgId, postId: post._id })));
    }
  }
  await A.Asset.create({ organizationId: orgId, postId: ids.breath, kind: 'video', storageKey: 's3://yv-media/demo/breath.wav', transcript: BREATH_TRANSCRIPT, transcriptEngine: 'fixture', sceneCuts: BREATH_SCENES });
  await A.Asset.create({ organizationId: orgId, postId: ids.dads, kind: 'audio', storageKey: 's3://yv-media/demo/dads.wav' });
  await A.BrandRule.insertMany(BRAND.map((b) => ({ ...b, organizationId: orgId })));
  const comments = [
    ['Sana (client)', 'client', 'The background music is too loud around 0:12, I can barely hear the voice.', 12],
    ['Priya (editor)', 'editor', 'Lower the music under the voiceover at 0:10-0:15.', 11],
    ['Sana (client)', 'client', 'We need the "Not medical advice" disclaimer at the start.', 1],
    ['Meera (publisher)', 'publisher', 'Disclaimer missing in first 3 seconds - brand rule.', 2],
    ['Priya (editor)', 'editor', 'Caption typo: "excercise" should be "exercise".', 20],
    ['Meera (publisher)', 'publisher', 'End card should say "Join the next workshop", not "Book now".', 43],
    ['Sana (client)', 'client', 'Can we open on the dad placing his hand on the belly? Feels warmer.', 0],
  ];
  await A.ReviewComment.insertMany(comments.map(([author, role, body, t], i) => ({ organizationId: orgId, postId: ids.dads, author, role, body, timecodeSec: t, createdAt: new Date(now.getTime() - (10 - i) * 3600000) })));
  return { orgId: String(orgId), userId: String(user._id), postIds: ids, login: LOGIN };
}

module.exports = { seedAgentDemo, retentionCurve, LOGIN };

if (require.main === module) {
  (async () => {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/cop');
    const out = await seedAgentDemo();
    console.log(JSON.stringify(out));
    await mongoose.disconnect();
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
