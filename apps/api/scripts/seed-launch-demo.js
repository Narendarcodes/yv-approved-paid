#!/usr/bin/env node
/*
 * Seed a realistic, fictional agency workspace for demos and the launch video.
 *
 *   node scripts/seed-launch-demo.js [--reset] [--api http://localhost:3000/api/v1] [--assets ./demo-assets]
 *
 * Talks to a RUNNING API (so activity events and notifications are generated
 * exactly as they would be in real use). --reset drops the database named in
 * MONGO_URI first - only use it against a local/dev database.
 *
 * Every person and email below is made up. Login after seeding:
 *   kavya.demo@example.com / demo-pass-2026  (admin)
 *
 * Publishing demo data: 4 demo channels (Instagram, YouTube, LinkedIn, X)
 * plus one expired client account (Reconnect state), posts scheduled for
 * today and later, one partially published project (1/2), one failed post
 * with its reason (Retry), and "Rangoli Colours Workshop Reel" approved and
 * ready to schedule.
 *
 * Pipeline + analytics demo data: open concepts, a concept converted into a
 * project with a pre-filled brief, and ~6 weeks of published history across
 * clients and campaigns. Its analytics are SIMULATED (demo mode) and stored
 * with simulated: true, so every screen labels them as such.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const API = opt('--api', process.env.DEMO_API || 'http://localhost:3000/api/v1');
const ASSETS = opt('--assets', process.env.DEMO_ASSETS || '');
const PASSWORD = 'demo-pass-2026';

const PEOPLE = {
  kavya: { name: 'Kavya Reddy', email: 'kavya.demo@example.com', role: 'admin' },
  rahul: { name: 'Rahul Varma', email: 'rahul.demo@example.com', role: 'editor' },
  sneha: { name: 'Sneha Iyer', email: 'sneha.demo@example.com', role: 'editor' },
  anjali: { name: 'Anjali Sharma', email: 'anjali.demo@example.com', role: 'reviewer' },
  meera: { name: 'Meera Joshi', email: 'meera.demo@example.com', role: 'publisher' },
};

const tokens = {};
const ids = {};

async function call(who, method, url, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (who) headers.Authorization = `Bearer ${tokens[who]}`;
  const res = await fetch(`${API}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(json.error || json)}`);
  return json.data;
}

async function upload(who, projectId, versionId, file) {
  const form = new FormData();
  const buf = fs.readFileSync(file);
  form.append('file', new Blob([buf], { type: 'video/mp4' }), path.basename(file));
  const res = await fetch(`${API}/projects/${projectId}/versions/${versionId}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens[who]}` },
    body: form,
  });
  if (!res.ok) throw new Error(`upload ${file} -> ${res.status}`);
}

const days = (n) => new Date(Date.now() + n * 86400000).toISOString();

async function reset() {
  const mongoose = require('mongoose');
  const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/cop';
  await mongoose.connect(uri);
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  console.log('Dropped', uri);
}

async function main() {
  if (flag('--reset')) await reset();

  for (const [key, p] of Object.entries(PEOPLE)) {
    await call(null, 'POST', '/auth/register', { name: p.name, email: p.email, password: PASSWORD }).catch(() => {});
    const login = await call(null, 'POST', '/auth/login', { email: p.email, password: PASSWORD });
    tokens[key] = login.accessToken;
    ids[key] = String(login.user.id || login.user._id);
  }

  const org = await call('kavya', 'POST', '/organizations', { name: 'Little Steps Workshops', slug: 'littlesteps' });
  const orgId = org._id;
  for (const key of ['rahul', 'sneha', 'anjali', 'meera']) {
    await call('kavya', 'POST', `/organizations/${orgId}/members`, { email: PEOPLE[key].email, role: PEOPLE[key].role });
  }

  const mk = async (title, description, extra = {}) =>
    (await call('kavya', 'POST', '/projects', { organizationId: orgId, title, description, ...extra }))._id;
  const OWN = { client: 'Little Steps Workshops' };
  const to = (pid, status, who = 'kavya') => call(who, 'POST', `/projects/${pid}/transition`, { status });
  const assign = (pid, who) => call('kavya', 'POST', `/projects/${pid}/assign`, { assigneeId: ids[who] });
  const version = async (pid, who, summary, file) => {
    const v = await call(who, 'POST', `/projects/${pid}/versions`, { changeSummary: summary });
    if (file && fs.existsSync(file)) await upload(who, pid, v._id, file);
    return v._id;
  };
  const asset = (name) => (ASSETS ? path.join(ASSETS, name) : '');
  const brief = (pid, b) => call('kavya', 'PUT', `/projects/${pid}/brief`, b);
  const task = async (pid, title, priority, who, due, status) => {
    const t = await call('kavya', 'POST', `/projects/${pid}/tasks`, { title, priority, assignee: ids[who], dueDate: days(due) });
    if (status && status !== 'todo') await call('kavya', 'POST', `/projects/${pid}/tasks/${t._id}/status`, { status });
  };

  // 1. The hero project - starts as an idea with a brief and a draft ready, so
  //    the demo can walk it through the whole lifecycle.
  const diwali = await mk(
    'Diwali Pottery Workshop Reel',
    'A 30-second reel inviting families to shape and paint their own clay diyas at the Diwali pottery workshop.',
    { ...OWN, campaign: 'Festive Q4' }
  );
  await brief(diwali, {
    goal: 'Fill all 40 seats for the Diwali pottery workshop on 25 Oct with families from Jubilee Hills and Banjara Hills.',
    targetAudience: 'Parents 28-45 and kids 6-12 who love hands-on weekends',
    videoType: 'Instagram Reel · 9:16 · 30s',
    deliverables: ['1 hero reel', '3 story frames', 'Caption + hashtags', 'Thumbnail'],
    references: ['Last year\'s rangoli reel'],
    deadline: days(6),
    specialInstructions: 'Warm golden-hour palette. Show hands working the clay in the first 2 seconds.',
  });
  await version(diwali, 'kavya', 'First cut - warm grade, kids hook', asset('diwali-v1.mp4'));
  await task(diwali, 'Shoot clay-shaping close-ups', 'high', 'rahul', 2, 'in_progress');
  await task(diwali, 'Write reel caption + hashtags', 'medium', 'sneha', 3, 'todo');

  // 2. In review, with timecoded client feedback to lock.
  const navratri = await mk(
    'Navratri Dandiya Night Promo',
    'Promo video for the Dandiya night - tickets, venue, dress code and the live dhol performance.',
    { client: 'Garba Club Hyderabad', campaign: 'Navratri' }
  );
  await assign(navratri, 'rahul');
  await to(navratri, 'IN_PROGRESS');
  await brief(navratri, {
    goal: 'Sell 150 passes for Dandiya Night in the first week of sales.',
    targetAudience: 'Young professionals 22-35 in Hyderabad',
    videoType: 'Reel + YouTube Short · 20s',
    deliverables: ['Promo reel', 'Ticket story', 'Countdown sticker'],
    deadline: days(4),
  });
  const navV1 = await version(navratri, 'rahul', 'Draft v1 - dhol intro, venue map', asset('navratri-v1.mp4'));
  await to(navratri, 'UNDER_REVIEW');
  const comment = (body, timecode) =>
    call('anjali', 'POST', `/projects/${navratri}/comments`, { versionId: navV1, body, timecode });
  await comment('Please swap the opening shot - start on the dhol drummer, not the venue gate.', 1);
  await comment('Can we make the ticket price bigger and hold it on screen for 2 more seconds?', 4);
  await comment('Fix the date - it should say Sat 18 Oct, not Fri.', 7);
  await task(navratri, 'Re-cut intro on the dhol drummer', 'high', 'rahul', 1, 'in_review');
  await task(navratri, 'Book dhol troupe for the shoot', 'medium', 'sneha', -1, 'done');

  // 3. In production
  const kids = await mk('Kids Summer Art Camp Promo', 'Carousel + reel for the weekend kids art camp - painting, clay and block printing.', { ...OWN, campaign: 'Kids camps' });
  await assign(kids, 'sneha');
  await to(kids, 'IN_PROGRESS');
  await task(kids, 'Design carousel slides (6)', 'high', 'sneha', 2, 'in_progress');
  await task(kids, 'Collect parent testimonials', 'low', 'rahul', 5, 'todo');

  // 4. Waiting for inputs
  const mehendi = await mk('Mehendi Masterclass Teaser', 'Teaser for the bridal mehendi masterclass with guest artist.', { client: 'Henna House', campaign: 'Bridal season' });
  await assign(mehendi, 'rahul');
  await to(mehendi, 'WAITING_FOR_INPUTS');
  await call('kavya', 'POST', `/projects/${mehendi}/inputs`, { title: 'Guest artist portfolio photos', owner: ids.anjali });
  await call('kavya', 'POST', `/projects/${mehendi}/inputs`, { title: 'Final masterclass pricing', owner: ids.kavya });
  await task(mehendi, 'Storyboard the 15s teaser', 'medium', 'rahul', 4, 'todo');

  // Publishing channels (demo mode - no real tokens; the built-in scheduler
  // publishes them). With POSTIZ_API_URL/KEY set you would link Postiz
  // integrations from Publish > Channels instead.
  const sched = (p) => `/organizations/${orgId}/scheduling${p}`;
  const channel = (platform, handle, name) => call('kavya', 'POST', sched('/channels'), { platform, handle, name });
  const ig = await channel('instagram', 'littlesteps.workshops', 'Little Steps Workshops');
  const yt = await channel('youtube', 'littlesteps', 'Little Steps on YouTube');
  const li = await channel('linkedin', 'littlesteps-workshops', 'Little Steps Workshops');
  const xch = await channel('x', 'littlesteps', '@littlesteps');
  const at = (dayOffset, hour, minute = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hour, minute, 0, 0);
    return d.toISOString();
  };
  const approvedWithCut = async (pid, who, summary, file) => {
    await assign(pid, who);
    await to(pid, 'IN_PROGRESS');
    const v = await version(pid, who, summary, file);
    await to(pid, 'UNDER_REVIEW');
    await call('anjali', 'POST', `/projects/${pid}/approve`, { versionId: v });
    return v;
  };
  const schedulePost = (projectId, channels, caption, scheduledAt) =>
    call('meera', 'POST', sched('/posts'), { projectId, channelIds: channels.map((c) => c._id), caption, scheduledAt });

  // 5. Scheduled - Block Printing tutorial to YouTube + Instagram
  const block = await mk('Block Printing Basics Tutorial', 'Step-by-step tutorial video on hand block printing with natural dyes.', { ...OWN, campaign: 'Evergreen tutorials' });
  await approvedWithCut(block, 'sneha', 'Final edit with subtitles', asset('block-final.mp4'));
  const blockPosts = await schedulePost(
    block,
    [yt, ig],
    'Hand block printing, start to finish 🌿 Natural indigo and madder dyes, one wooden block, zero experience needed. Full tutorial on our channel - workshop seats for Saturday in bio.',
    new Date(Date.now() + 90 * 60000).toISOString() // goes live later today
  );
  await task(block, 'Export YouTube + IG cuts', 'medium', 'sneha', 1, 'done');

  // 5b. Scheduled - pottery wheel drop-in to LinkedIn + X
  const wheel = await mk('Weekend Pottery Wheel Drop-in', 'Short promo for the open-studio pottery wheel sessions every weekend.', { ...OWN, campaign: 'Open studio' });
  await approvedWithCut(wheel, 'rahul', 'Final cut - studio ambience mix', asset('wheel-final.mp4'));
  const wheelPosts = await schedulePost(
    wheel,
    [li, xch],
    'Open studio this weekend: two hours on the wheel, clay and glazes included. Walk-ins welcome, 10am-6pm at Little Steps Workshops.',
    at(4, 11, 30)
  );

  // 6. Published through the scheduler, with live link + synced metrics
  const clay = await mk('Clay Modelling for Teens Story Set', 'Five-frame story set announcing the teen clay modelling batch.', { ...OWN, campaign: 'Teen batches' });
  await approvedWithCut(clay, 'rahul', 'Story frames final', asset('clay-stories.mp4'));
  const [clayPost] = await schedulePost(
    clay,
    [ig],
    'New batch alert 🏺 Clay modelling for teens (13-17) starts next Saturday. 8 sessions, all materials included. Tap the link in bio to book.',
    at(1, 10)
  );
  await call('meera', 'POST', sched(`/posts/${clayPost._id}/publish-now`));
  await task(clay, 'Reply to story DMs', 'low', 'sneha', 0, 'done');

  // 6b. Approved and ready to schedule live in the demo (Publish > Compose)
  const rangoli = await mk(
    'Rangoli Colours Workshop Reel',
    'Celebrate Diwali with colour 🌸 Join our rangoli workshop this Sunday - learn freehand and stencil designs with natural colours. All ages welcome, limited seats.',
    { ...OWN, campaign: 'Festive Q4' }
  );
  await approvedWithCut(rangoli, 'sneha', 'Final reel - festive grade', asset('rangoli-final.mp4'));

  // 7. Concepts: two open ideas, and one converted into a project + brief in one step
  const concept = (title, description, type = 'New Concept') =>
    call('kavya', 'POST', `/organizations/${orgId}/concepts`, { title, description, type });
  await concept('Founder Story Interview', 'Short documentary-style interview with the founder about why Little Steps started.');
  await concept('Behind the Wheel: Potter POV Series', 'A 4-part POV series shot on a head-mounted camera at the wheel - built on how well hands-on close-ups did last month.', 'Experiment');
  const pitchCard = await concept('Diya Painting Live Session', 'Live-streamed diya painting session with Q&A - families paint along at home.');
  const converted = await call('kavya', 'PATCH', `/organizations/${orgId}/concepts/${pitchCard.id}/approve`, {
    client: 'Little Steps Workshops',
    campaign: 'Festive Q4',
    brief: {
      goal: 'Get 300 families painting diyas live with us and drive workshop sign-ups.',
      targetAudience: 'Parents 28-45 with kids 6-12',
      deliverables: ['Live session cut-down reel', 'YouTube replay'],
    },
  });
  const diyaLive = converted.projectId;

  // 8. Published history (last ~6 weeks) so Analytics, the Concepts board's
  //    "what worked last month" and client reports have something to show.
  const history = [
    { title: 'Lotus Arts Gallery Walkthrough', desc: 'Guided walkthrough of the Lotus Arts autumn exhibition.', client: 'Lotus Arts Collective', campaign: 'Gallery launch', chans: [ig, li], ago: 35, hour: 10, file: 'wheel-final.mp4' },
    { title: 'Garba Steps in 60 Seconds', desc: 'Quick tutorial: three garba steps anyone can learn before Navratri.', client: 'Garba Club Hyderabad', campaign: 'Navratri', chans: [ig, xch, yt], ago: 25, hour: 18, minute: 30, file: 'navratri-v1.mp4' },
    { pid: diyaLive, title: 'Diya Painting Live Session', ago: 18, hour: 19, chans: [ig, yt], file: 'diwali-v1.mp4' },
    { title: 'Natural Dye Colour Guide', desc: 'Carousel + video guide to natural dye colours from kitchen ingredients.', client: 'Little Steps Workshops', campaign: 'Evergreen tutorials', chans: [yt, li], ago: 9, hour: 17, file: 'block-final.mp4' },
    { title: 'Teen Clay Batch Results', desc: 'Showcase of what the September teen batch made in 8 sessions.', client: 'Little Steps Workshops', campaign: 'Teen batches', chans: [ig, xch], ago: 4, hour: 12, file: 'clay-stories.mp4' },
  ];
  const backdate = []; // [{ projectId, posts, at }]
  for (const h of history) {
    const pid = h.pid || (await mk(h.title, h.desc, { client: h.client, campaign: h.campaign }));
    if (h.pid) await assign(pid, 'sneha').catch(() => {});
    await approvedWithCut(pid, h.pid ? 'sneha' : 'rahul', 'Final cut', asset(h.file)).catch(async () => {
      // diyaLive starts at APPROVED_CONCEPT -> ASSIGNED by assign(); continue the same path
      await to(pid, 'IN_PROGRESS').catch(() => {});
      const v = await version(pid, 'sneha', 'Final cut', asset(h.file));
      await to(pid, 'UNDER_REVIEW');
      await call('anjali', 'POST', `/projects/${pid}/approve`, { versionId: v });
    });
    const posts = await schedulePost(pid, h.chans, `${h.title} - now live.`, new Date(Date.now() + 3600000).toISOString());
    // IST wall-clock -> UTC
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - h.ago);
    d.setUTCHours(h.hour, h.minute || 0, 0, 0);
    backdate.push({ projectId: pid, posts, at: new Date(d.getTime() - 330 * 60000) });
  }

  // Direct DB touch-ups for states the public API (rightly) will not create:
  // posts in the past, a failed post, an expired channel. Same models the API uses.
  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/cop');
  const Publication = require('../src/models/publication.model');
  const Project = require('../src/models/project.model');
  const SocialChannel = require('../src/models/socialChannel.model');
  const scheduling = require('../src/services/scheduling.service');
  const ingest = require('../src/services/analytics.ingest');
  const local = require('../src/services/scheduling/local.provider');
  const HOUR = 3600000;
  const publishAt = async (postId, when) => {
    const pub = await Publication.findById(postId);
    const ch = await SocialChannel.findById(pub.channelId);
    pub.status = 'published';
    pub.scheduledFor = when;
    pub.publishedAt = when;
    pub.postUrl = local._demoPostUrl(pub, ch);
    await pub.save();
    return pub;
  };
  for (const b of backdate) {
    for (const [i, p] of b.posts.entries()) await publishAt(p._id, new Date(b.at.getTime() + i * 7 * 60000));
    await Project.updateOne({ _id: b.projectId }, { $set: { publishedAt: null } });
    await scheduling.syncProjectState(b.projectId);
    await Project.updateOne({ _id: b.projectId }, { $set: { scheduledAt: b.at, publishedAt: b.at } });
  }
  // partial publish: LinkedIn post of the wheel drop-in went out this morning, X is still scheduled
  await publishAt(wheelPosts.find((p) => p.channel.platform === 'linkedin')._id, new Date(Date.now() - 3 * HOUR));
  await scheduling.syncProjectState(wheel);
  // failed post: Instagram rejected the block-printing cut (Retry in the calendar)
  const igBlock = await Publication.findById(blockPosts.find((p) => p.channel.platform === 'instagram')._id);
  igBlock.scheduledFor = new Date(Date.now() - 2 * HOUR);
  await igBlock.save();
  await scheduling.markFailed(igBlock, 'Instagram rejected the video: Reels must be 9:16 and this cut is 16:9. Re-export the vertical cut or post it as a feed video, then retry.');
  // an expired client account -> "Reconnect" on the Channels page
  const lotus = await call('kavya', 'POST', sched('/channels'), { platform: 'instagram', handle: 'lotusarts.collective', name: 'Lotus Arts (client account)' });
  await SocialChannel.updateOne(
    { _id: lotus._id },
    { $set: { status: 'expired', statusReason: 'Authorisation expired - reconnect to keep publishing (demo)', lastCheckedAt: new Date() } }
  );
  // simulated analytics for every live post + every connected channel
  const now = new Date();
  for (const pub of await Publication.find({ organizationId: orgId, status: 'published' })) await ingest.ingestPublication(pub, now);
  for (const ch of await SocialChannel.find({ organizationId: orgId, status: 'connected' })) await ingest.ingestChannel(ch, now, 90);
  await mongoose.disconnect();

  // Team chat (hidden "Team Chat" project hosts the channels)
  const chat = await mk('Team Chat', 'Team conversations');
  const general = await call('kavya', 'POST', `/projects/${chat}/channels`, { name: 'general' });
  const festive = await call('kavya', 'POST', `/projects/${chat}/channels`, { name: 'festive-campaign' });
  const say = (who, ch, body) => call(who, 'POST', `/projects/${chat}/channels/${ch}/messages`, { body });
  await say('kavya', festive._id, 'Morning team! Diwali reel goes into production today 🪔');
  await say('rahul', festive._id, 'Clay close-ups are shot. Uploading the first cut by noon.');
  await say('anjali', festive._id, 'Loved the Navratri draft - left 3 notes on timing in the review.');
  await say('sneha', festive._id, 'Carousel for the kids camp is 4/6 done.');
  await say('sneha', general._id, 'Block printing tutorial is scheduled - goes live on YouTube + IG at 6 pm.');
  await say('kavya', general._id, 'Thanks all - invoices for September are going out today.');

  // Contracts
  const retainer = await call('kavya', 'POST', `/organizations/${orgId}/contracts`, {
    title: 'Q4 Festive Social Retainer',
    amount: 180000,
    currency: 'INR',
    sentTo: 'partnerships@lotusarts.example.org',
    terms: '12 reels, 8 carousels and community management for Oct-Dec.',
  });
  await call('kavya', 'POST', `/organizations/${orgId}/contracts/${retainer._id}/send`);
  await call('kavya', 'POST', `/organizations/${orgId}/contracts/${retainer._id}/view`);
  const sow = await call('kavya', 'POST', `/organizations/${orgId}/contracts`, {
    title: 'Navratri Campaign SOW',
    amount: 65000,
    currency: 'INR',
    projectId: navratri,
    sentTo: 'events@garbaclub.example.org',
  });
  await call('kavya', 'POST', `/organizations/${orgId}/contracts/${sow._id}/send`);
  await call('kavya', 'POST', `/organizations/${orgId}/contracts/${sow._id}/sign`, {
    signerName: 'Ritu Malhotra',
    signerEmail: 'events@garbaclub.example.org',
  });
  await call('kavya', 'POST', `/organizations/${orgId}/contracts`, {
    title: 'Mehendi Masterclass Photo Shoot',
    amount: 28000,
    currency: 'INR',
    projectId: mehendi,
    sentTo: 'studio@hennahouse.example.org',
  });

  // Invoices
  const inv = (number, amount, projectId, dueDays, note) =>
    call('kavya', 'POST', `/organizations/${orgId}/invoices`, { number, amount, currency: 'INR', projectId, dueDate: days(dueDays), note });
  const i1 = await inv('INV-0001', 42000, clay, -20, 'Teen clay story set - design + publishing');
  await call('kavya', 'POST', `/organizations/${orgId}/invoices/${i1._id}/send`);
  await call('kavya', 'POST', `/organizations/${orgId}/invoices/${i1._id}/pay`, { paymentMethod: 'UPI' });
  const i2 = await inv('INV-0002', 65000, navratri, -3, 'Navratri campaign - 50% advance');
  await call('kavya', 'POST', `/organizations/${orgId}/invoices/${i2._id}/send`);
  const i3 = await inv('INV-0003', 38500, block, 21, 'Block printing tutorial production');
  await call('kavya', 'POST', `/organizations/${orgId}/invoices/${i3._id}/send`);
  await inv('INV-0004', 54000, diwali, 30, 'Diwali pottery reel + 3 stories');

  console.log(JSON.stringify({ orgId, diwali, navratri, rangoli, wheel, block, login: PEOPLE.kavya.email, password: PASSWORD }));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
