#!/usr/bin/env node
/**
 * seed-chat.js — curated, synthetic seed for yv..
 *
 * This is NOT a parser. It encodes a SYNTHETIC team chat modelled on the
 * coordination patterns we observed in a real case study (an NGO's content
 * team). All names, messages and links below are fictional; no real chat
 * content is included. The projects, tasks, review cycles and conversation are
 * represented as first-class DB records so the frontend renders structured data.
 *
 * Idempotent: re-running clears the curated records it owns and recreates them,
 * so the dataset stays clean.
 *
 *   node scripts/seed-chat.js            # seed MongoDB
 *   node scripts/seed-chat.js --dry-run  # print what would be created
 *
 * Env overrides: MONGO_URI, ORG_SLUG (default demo).
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const User = require('../src/models/user.model');
const Organization = require('../src/models/organization.model');
const Membership = require('../src/models/membership.model');
const Project = require('../src/models/project.model');
const Channel = require('../src/models/channel.model');
const ChatMessage = require('../src/models/chatMessage.model');
const Task = require('../src/models/task.model');
const Comment = require('../src/models/comment.model');
const RevisionRequest = require('../src/models/revisionRequest.model');
const Publication = require('../src/models/publication.model');
const Notification = require('../src/models/notification.model');

const DRY_RUN = process.argv.includes('--dry-run');
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/cop';
const ORG_SLUG = process.env.ORG_SLUG || 'demo';
const DEMO_PASSWORD = 'demo';

const VALID_ROLES = ['admin', 'editor', 'reviewer', 'designer', 'publisher', 'member'];

/* --------------------------- date helper --------------------------- */
// Chat timestamps look like: "1/8/26, 1:26 PM" (M/D/YY, 12h with AM/PM).
function parseChatDate(s) {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) throw new Error('Bad date: ' + s);
  let [, mm, dd, yy, hh, min, ap] = m;
  let year = parseInt(yy, 10);
  if (year < 100) year += 2000;
  let hour = parseInt(hh, 10);
  const upper = ap.toUpperCase();
  if (upper === 'PM' && hour !== 12) hour += 12;
  if (upper === 'AM' && hour === 12) hour = 0;
  return new Date(year, parseInt(mm, 10) - 1, parseInt(dd, 10), hour, parseInt(min, 10), 0, 0);
}

/* --------------------------- chat participants --------------------------- */
// Fictional team of three (synthetic).
const PARTICIPANTS = [
  { email: 'asha@demo.yv-ops.test', name: 'Asha', role: 'editor', title: 'Content Lead' },
  { email: 'ravi@demo.yv-ops.test', name: 'Ravi', role: 'designer', title: 'Video Editor' },
  { email: 'meghna@demo.yv-ops.test', name: 'Meghna', role: 'editor', title: 'Script Writer' },
];

/* --------------------------- the conversation (synthetic) --------------------------- */
const CHAT_MESSAGES = [
  ['1/8/26, 1:26 PM', 'Asha', 'New series this month: short story reels for expecting parents. First one is the "listening in the womb" story.'],
  ['1/9/26, 6:20 PM', 'Ravi', '@Meghna can you share the script early so I can start on visuals?'],
  ['1/10/26, 8:07 AM', 'Meghna', 'Draft script is in the doc. Voice-over by Friday.'],
  ['1/13/26, 7:51 AM', 'Asha', 'Script is crisp. Only the first line should be a hook.'],
  ['1/13/26, 2:31 PM', 'Ravi', 'Suggest a shorter hook that stays within what the audience already knows.'],
  ['1/15/26, 9:05 AM', 'Ravi', 'Hook line needs a different pitch from the story part: more tension.'],
  ['1/23/26, 2:25 PM', 'Ravi', 'We also need a posting schedule for the series.'],
  ['1/25/26, 9:13 PM', 'Ravi', '@Asha 4 videos in total: 1 delivered, 3 pending. Scripts and VO for 2 are not shared yet.'],
  ['1/27/26, 5:15 PM', 'Asha', 'These visuals are so good'],
  ['1/27/26, 5:17 PM', 'Asha', 'Can you reshare the latest cut? I cannot find which version is final.'],
  ['1/28/26, 11:12 AM', 'Asha', 'Visuals approved. Go ahead.'],
  ['1/30/26, 11:19 AM', 'Meghna', 'Small correction: drop the line about the naming, it is not in the source.'],
  ['1/31/26, 5:12 PM', 'Asha', 'Start the video from 0:41 (hook), then continue from 0:01 to 0:40.'],
  ['1/31/26, 9:11 PM', 'Ravi', 'Clear now. Proceeding.'],
  ['2/3/26, 12:28 AM', 'Meghna', 'Looks amazing. Needs a stronger music bed, and check subtitles fit the 9:16 frame.'],
  ['2/3/26, 7:25 AM', 'Ravi', 'This one took 10 hours because I built the style for the series. Next ones should take 2-3 hours.'],
  ['2/3/26, 11:05 PM', 'Asha', 'One scene may show the father in a bad light. Can we soften it?'],
  ['2/4/26, 1:13 PM', 'Meghna', 'Let us try both versions and pick one.'],
  ['2/5/26, 1:21 PM', 'Meghna', 'Final looks wonderful.'],
  ['2/5/26, 2:04 PM', 'Asha', 'Approved. Publishing today.'],
];

/* --------------------------- content projects --------------------------- */
const PROJECTS = [
  {
    title: 'Womb Story Reel',
    type: 'Content Production',
    status: 'PUBLISHED',
    description: 'First reel in the parenting story series. Scripted by Meghna, edited by Ravi, published to YouTube Shorts + Instagram.',
    creator: 'asha@demo.yv-ops.test',
    assignee: 'ravi@demo.yv-ops.test',
    publishedAt: '2/5/26, 2:04 PM',
  },
  {
    title: 'Bedtime Story Reel',
    type: 'Content Production',
    status: 'IDEA',
    description: 'Next story in the series. Blocked on voice-over script.',
    creator: 'asha@demo.yv-ops.test',
    assignee: 'ravi@demo.yv-ops.test',
  },
  {
    title: 'First Words Reel',
    type: 'Content Production',
    status: 'IDEA',
    description: 'Future story in the series. Blocked on voice-over script.',
    creator: 'asha@demo.yv-ops.test',
    assignee: 'ravi@demo.yv-ops.test',
  },
  {
    title: 'Instagram Auto-DM Workflow',
    type: 'Content Production',
    status: 'IN_PROGRESS',
    description: 'A small UI to manage the Instagram auto-DM automation. Needs hosting.',
    creator: 'ravi@demo.yv-ops.test',
    assignee: 'ravi@demo.yv-ops.test',
  },
  {
    title: 'SM Content Calendar',
    type: 'Content Production',
    status: 'APPROVED',
    description: 'Shared content calendar tracking the posting schedule for the story reels.',
    creator: 'asha@demo.yv-ops.test',
    assignee: 'asha@demo.yv-ops.test',
  },
];

/* --------------------------- publications --------------------------- */
const PUBLICATIONS = [
  { project: 'Womb Story Reel', platform: 'YouTube Shorts', publishedBy: 'meghna@demo.yv-ops.test', publishedAt: '2/5/26, 2:04 PM' },
  { project: 'Womb Story Reel', platform: 'Instagram', publishedBy: 'meghna@demo.yv-ops.test', publishedAt: '2/5/26, 2:10 PM' },
];

/* --------------------------- notifications --------------------------- */
const NOTIFICATIONS = [
  { to: 'asha@demo.yv-ops.test', project: 'Womb Story Reel', type: 'comment_added', title: 'Ravi commented on the draft', body: 'Hook line needs a different pitch from the story part: more tension.', at: '1/15/26, 9:05 AM' },
  { to: 'ravi@demo.yv-ops.test', project: 'Womb Story Reel', type: 'revision_requested', title: 'Script correction requested', body: 'Drop the line about the naming, it is not in the source.', at: '1/30/26, 11:19 AM' },
  { to: 'meghna@demo.yv-ops.test', project: 'Womb Story Reel', type: 'comment_added', title: 'Asha approved the visuals', body: 'These visuals are so good.', at: '1/27/26, 5:15 PM' },
  { to: 'asha@demo.yv-ops.test', project: 'Womb Story Reel', type: 'published', title: 'Womb Story Reel is live', body: 'Published to YouTube Shorts + Instagram.', at: '2/5/26, 2:10 PM', read: true },
];

/* --------------------------- tasks (kanban) --------------------------- */
const TASKS = [
  { title: 'Write script', status: 'done', priority: 'high', assignee: 'meghna@demo.yv-ops.test', project: 'Womb Story Reel', due: '1/10/26, 12:03 AM' },
  { title: 'Record voice-over', status: 'done', priority: 'high', assignee: 'meghna@demo.yv-ops.test', project: 'Womb Story Reel', due: '1/31/26, 2:39 PM' },
  { title: 'Create story visuals', status: 'done', priority: 'medium', assignee: 'ravi@demo.yv-ops.test', project: 'Womb Story Reel', due: '1/27/26, 5:32 PM' },
  { title: 'Edit video (build series style)', status: 'done', priority: 'high', assignee: 'ravi@demo.yv-ops.test', project: 'Womb Story Reel', due: '2/3/26, 7:25 AM' },
  { title: 'Review script & hook line', status: 'done', priority: 'high', assignee: 'asha@demo.yv-ops.test', project: 'Womb Story Reel', due: '1/13/26, 7:51 AM' },
  { title: 'Add music bed / SFX', status: 'in_progress', priority: 'medium', assignee: 'ravi@demo.yv-ops.test', project: 'Womb Story Reel', due: '2/5/26, 1:21 PM' },
  { title: 'Publish to YouTube & Instagram', status: 'done', priority: 'high', assignee: 'meghna@demo.yv-ops.test', project: 'Womb Story Reel', due: '2/5/26, 2:04 PM' },
  { title: 'Deploy Auto-DM workflow', status: 'in_progress', priority: 'medium', assignee: 'ravi@demo.yv-ops.test', project: 'Instagram Auto-DM Workflow', due: '1/23/26, 2:30 PM' },
  { title: 'Share next VO scripts', status: 'todo', priority: 'medium', assignee: 'meghna@demo.yv-ops.test', project: 'Bedtime Story Reel', due: '1/25/26, 9:13 PM' },
];

/* --------------------------- reviews (comments) --------------------------- */
const COMMENTS = [
  { project: 'Womb Story Reel', author: 'asha@demo.yv-ops.test', body: 'Script is crisp. Only the first line should be a hook.', at: '1/13/26, 7:51 AM' },
  { project: 'Womb Story Reel', author: 'meghna@demo.yv-ops.test', body: 'Drop the line about the naming, it is not in the source.', at: '1/30/26, 11:19 AM', resolved: true },
  { project: 'Womb Story Reel', author: 'ravi@demo.yv-ops.test', body: 'Hook line needs a different pitch from the story part: more tension.', at: '1/15/26, 9:05 AM' },
  { project: 'Womb Story Reel', author: 'asha@demo.yv-ops.test', body: 'These visuals are so good', at: '1/27/26, 5:15 PM', resolved: true },
  { project: 'Womb Story Reel', author: 'meghna@demo.yv-ops.test', body: 'Needs a stronger music bed, and check subtitles fit the 9:16 frame.', at: '2/3/26, 12:28 AM' },
  { project: 'Womb Story Reel', author: 'asha@demo.yv-ops.test', body: 'One scene may show the father in a bad light. Can we soften it?', at: '2/3/26, 11:05 PM' },
];

/* --------------------------- revision requests --------------------------- */
const REVISIONS = [
  { project: 'Womb Story Reel', revisionNumber: 1, reason: 'Script correction: drop the naming line (not in the source).', requester: 'meghna@demo.yv-ops.test', status: 'resolved', requestedAt: '1/30/26, 11:19 AM', resolvedAt: '1/30/26, 12:05 PM' },
  { project: 'Womb Story Reel', revisionNumber: 2, reason: 'Video edit change: soften the scene that may show the father in a bad light; finalize between the two versions.', requester: 'asha@demo.yv-ops.test', status: 'resolved', requestedAt: '2/3/26, 11:05 PM', resolvedAt: '2/4/26, 1:13 PM' },
];

/* ------------------------------- main -------------------------------- */
async function main() {
  const passwordHash = bcrypt.hashSync(DEMO_PASSWORD, bcrypt.genSaltSync(10));

  // Resolve org
  const org = await Organization.findOneAndUpdate(
    { slug: ORG_SLUG },
    { $set: { name: 'Demo Content Team', slug: ORG_SLUG } },
    { upsert: true, new: true }
  );

  // Users + memberships for the three chat participants
  const emailToId = {};
  for (const p of PARTICIPANTS) {
    const user = await User.findOneAndUpdate(
      { email: p.email.toLowerCase() },
      { $set: { name: p.name, email: p.email.toLowerCase(), passwordHash, title: p.title } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    emailToId[p.email.toLowerCase()] = user._id;
    const role = VALID_ROLES.includes(p.role) ? p.role : 'member';
    await Membership.findOneAndUpdate(
      { userId: user._id, organizationId: org._id },
      { $set: { role, disabled: false } },
      { upsert: true, new: true }
    );
    console.log(`Upserted user ${p.email} -> ${role}`);
  }
  const resolveUser = (email) => (email ? emailToId[email.toLowerCase()] : null);

  // ---- Chat: clear any prior synthetic "Team Chat" data, then recreate ----
  const oldChat = await Project.findOne({ organizationId: org._id, title: 'Team Chat' });
  if (oldChat) {
    const oldChannels = await Channel.find({ projectId: oldChat._id });
    for (const ch of oldChannels) await ChatMessage.deleteMany({ channelId: ch._id });
    await Channel.deleteMany({ projectId: oldChat._id });
    await Project.deleteOne({ _id: oldChat._id });
    console.log('Cleared previous synthetic Team Chat data');
  }

  const chatProject = await Project.findOneAndUpdate(
    { organizationId: org._id, title: 'Team Chat' },
    { $set: { title: 'Team Chat', type: 'Content Production', status: 'IN_PROGRESS', description: 'Synthetic team conversation ("Stories Category").' } },
    { upsert: true, new: true }
  );
  const channel = await Channel.findOneAndUpdate(
    { projectId: chatProject._id, name: 'Stories Category' },
    { $set: { projectId: chatProject._id, name: 'Stories Category', type: 'channel' } },
    { upsert: true, new: true }
  );
  let msgCount = 0;
  for (const [dateStr, authorName, body] of CHAT_MESSAGES) {
    const author = resolveUser(PARTICIPANTS.find((p) => p.name === authorName).email);
    if (!author) continue;
    await ChatMessage.findOneAndUpdate(
      { channelId: channel._id, body },
      { $set: { channelId: channel._id, projectId: chatProject._id, author, body, sentAt: parseChatDate(dateStr) } },
      { upsert: true, new: true }
    );
    msgCount++;
  }
  console.log(`Upserted #Stories Category: ${msgCount} messages`);

  // ---- Clear legacy synthetic demo projects (from the old mock seed) ----
  // These contradict the "real data only" intent; remove them so the DB
  // reflects just the curated chat-derived records.
  const LEGACY_MOCK_TITLES = [
    'Ashram Testimonial — Episode 1',
    'Pre-pregnancy Awareness Reel',
    'Diwali Campaign — Light of Giving',
    'Post-natal Nutrition Carousel',
    'Yoga Series — Episode 4',
    'Festive Special — Puranic Story',
    'Annual Impact Report 2026',
    "Kids' Story Corner — Pilot",
    'Ashram Tour — Behind the Scenes',
    "Mothers' Day Tribute Reel",
    'Monsoon Relief Update',
    'Krishna Janmashtami Reel',
  ];
  const legacyProjects = await Project.find({ organizationId: org._id, title: { $in: LEGACY_MOCK_TITLES } });
  for (const lp of legacyProjects) {
    await Task.deleteMany({ projectId: lp._id });
    await Comment.deleteMany({ projectId: lp._id });
    await RevisionRequest.deleteMany({ projectId: lp._id });
    const lch = await Channel.find({ projectId: lp._id });
    for (const ch of lch) await ChatMessage.deleteMany({ channelId: ch._id });
    await Channel.deleteMany({ projectId: lp._id });
  }
  if (legacyProjects.length) {
    await Project.deleteMany({ _id: { $in: legacyProjects.map((p) => p._id) } });
    console.log(`Cleared ${legacyProjects.length} legacy synthetic demo projects`);
  }

  // ---- Content projects ----
  const projectByTitle = {};
  for (const p of PROJECTS) {
    const update = {
      title: p.title,
      type: p.type || 'Content Production',
      description: p.description || '',
      status: p.status,
      creator: resolveUser(p.creator),
      assignee: resolveUser(p.assignee),
      publishedAt: p.publishedAt ? parseChatDate(p.publishedAt) : null,
    };
    const project = await Project.findOneAndUpdate(
      { organizationId: org._id, title: p.title },
      { $set: update },
      { upsert: true, new: true }
    );
    projectByTitle[p.title] = project._id;
    console.log(`Upserted project "${p.title}" [${p.status}]`);
  }

  // ---- Tasks ----
  await Task.deleteMany({ projectId: { $in: Object.values(projectByTitle) } });
  for (const t of TASKS) {
    const pid = projectByTitle[t.project];
    if (!pid) continue;
    await Task.create({
      projectId: pid,
      title: t.title,
      status: t.status,
      priority: t.priority,
      assignee: resolveUser(t.assignee),
      createdBy: resolveUser(t.assignee),
      dueDate: t.due ? parseChatDate(t.due) : null,
    });
  }
  console.log(`Created ${TASKS.length} tasks`);

  // ---- Comments / reviews ----
  await Comment.deleteMany({ projectId: { $in: Object.values(projectByTitle) } });
  for (const c of COMMENTS) {
    const pid = projectByTitle[c.project];
    if (!pid) continue;
    await Comment.create({
      projectId: pid,
      author: resolveUser(c.author),
      body: c.body,
      resolved: !!c.resolved,
      createdAt: parseChatDate(c.at),
    });
  }
  console.log(`Created ${COMMENTS.length} review comments`);

  // ---- Revision requests ----
  await RevisionRequest.deleteMany({ projectId: { $in: Object.values(projectByTitle) } });
  for (const r of REVISIONS) {
    const pid = projectByTitle[r.project];
    if (!pid) continue;
    await RevisionRequest.create({
      projectId: pid,
      revisionNumber: r.revisionNumber,
      reason: r.reason,
      requester: resolveUser(r.requester),
      status: r.status,
      requestedAt: parseChatDate(r.requestedAt),
      resolvedAt: r.resolvedAt ? parseChatDate(r.resolvedAt) : null,
    });
  }
  console.log(`Created ${REVISIONS.length} revision requests`);

  // ---- Publications ----
  await Publication.deleteMany({ projectId: { $in: Object.values(projectByTitle) } });
  for (const pub of PUBLICATIONS) {
    const pid = projectByTitle[pub.project];
    if (!pid) continue;
    await Publication.create({
      projectId: pid,
      platform: pub.platform,
      postUrl: pub.postUrl || '',
      publishedBy: resolveUser(pub.publishedBy),
      publishedAt: parseChatDate(pub.publishedAt),
    });
  }
  console.log(`Created ${PUBLICATIONS.length} publications`);

  // ---- Notifications ----
  await Notification.deleteMany({ projectId: { $in: Object.values(projectByTitle) } });
  for (const n of NOTIFICATIONS) {
    const uid = resolveUser(n.to);
    const pid = projectByTitle[n.project];
    if (!uid || !pid) continue;
    await Notification.create({
      userId: uid,
      projectId: pid,
      type: n.type,
      title: n.title,
      body: n.body,
      read: !!n.read,
      createdAt: parseChatDate(n.at),
    });
  }
  console.log(`Created ${NOTIFICATIONS.length} notifications`);

  console.log('Seed complete.');
}

if (DRY_RUN) {
  console.log(`DRY RUN — would create:`);
  console.log(`  • ${PARTICIPANTS.length} users`);
  console.log(`  • 1 "Team Chat" project + #Stories Category with ${CHAT_MESSAGES.length} messages`);
  console.log(`  • ${PROJECTS.length} content projects`);
  console.log(`  • ${TASKS.length} tasks`);
  console.log(`  • ${COMMENTS.length} review comments`);
  console.log(`  • ${REVISIONS.length} revision requests`);
  console.log(`  • ${PUBLICATIONS.length} publications`);
  console.log(`  • ${NOTIFICATIONS.length} notifications`);
  console.log('DRY RUN — no database changes made.');
  process.exit(0);
}

mongoose
  .connect(MONGO_URI)
  .then(() => {
    console.log('Connected to', MONGO_URI);
    return main();
  })
  .then(() => mongoose.disconnect())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
