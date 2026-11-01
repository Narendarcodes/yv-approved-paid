/**
 * Pipeline view for the dashboard (Phase 3): Idea -> Brief -> Production ->
 * Review -> Publish -> Live, with counts per stage, who each item is waiting
 * on, what goes live today, failed posts, and last week's best post.
 */
const Project = require('../models/project.model');
const Concept = require('../models/concept.model');
const Input = require('../models/input.model');
const Membership = require('../models/membership.model');
const Publication = require('../models/publication.model');
const SocialChannel = require('../models/socialChannel.model');
const config = require('../config');
const { localParts } = require('../utils/tz');
const analytics = require('./analytics.service');

const STAGES = [
  { key: 'idea', label: 'Idea', statuses: ['IDEA', 'APPROVED_CONCEPT'] },
  { key: 'brief', label: 'Brief', statuses: ['ASSIGNED', 'WAITING_FOR_INPUTS', 'INPUTS_READY'] },
  { key: 'production', label: 'Production', statuses: ['IN_PROGRESS', 'REVISION_REQUESTED', 'REVISION_IN_PROGRESS'] },
  { key: 'review', label: 'Review', statuses: ['FIRST_DRAFT_SUBMITTED', 'UNDER_REVIEW', 'REVISION_SUBMITTED'] },
  { key: 'publish', label: 'Publish', statuses: ['APPROVED', 'SCHEDULED'] },
  { key: 'live', label: 'Live', statuses: ['PUBLISHED'] },
];

const ROLE_LABEL = { reviewer: 'Reviewers', publisher: 'Publishers', admin: 'Admins' };

async function pipeline({ organizationId, now = new Date() }) {
  const [projects, openConcepts, members, failed] = await Promise.all([
    // "Team Chat" is the hidden container project for chat channels, not work
    Project.find({ organizationId, status: { $nin: ['CANCELLED', 'CLOSED'] }, title: { $ne: 'Team Chat' } })
      .populate('assignee', 'name')
      .sort({ updatedAt: -1 })
      .lean(),
    Concept.countDocuments({ organizationId, status: 'IDEA' }),
    Membership.find({ organizationId, disabled: { $ne: true } }).populate('userId', 'name').lean(),
    Publication.find({ organizationId, status: 'failed' }, { projectId: 1, failureReason: 1, platform: 1 }).lean(),
  ]);
  const byRole = (role) => members.filter((m) => m.role === role && m.userId).map((m) => m.userId.name);
  const roleOwner = (role) => {
    const names = byRole(role);
    if (names.length === 1) return { kind: 'user', name: names[0] };
    return { kind: 'role', name: ROLE_LABEL[role] || role };
  };
  const failedByProject = new Map();
  for (const f of failed) failedByProject.set(String(f.projectId), (failedByProject.get(String(f.projectId)) || 0) + 1);

  const waitingInputs = projects.filter((p) => p.status === 'WAITING_FOR_INPUTS').map((p) => p._id);
  const pendingInputs = waitingInputs.length
    ? await Input.find({ projectId: { $in: waitingInputs }, state: { $ne: 'received' } }).populate('owner', 'name').lean()
    : [];
  const inputsByProject = new Map();
  for (const i of pendingInputs) {
    const k = String(i.projectId);
    inputsByProject.set(k, [...(inputsByProject.get(k) || []), i]);
  }

  const assigneeOr = (p, fallback) =>
    p.assignee ? { kind: 'user', id: p.assignee._id, name: p.assignee.name } : fallback || { kind: 'unassigned', name: 'Unassigned' };

  function blockedOn(p) {
    switch (p.status) {
      case 'IDEA':
      case 'APPROVED_CONCEPT':
        return { ...assigneeOr(p, { kind: 'unassigned', name: 'Needs an owner' }), action: 'Assign and write the brief' };
      case 'ASSIGNED':
        return { ...assigneeOr(p), action: 'Finish the brief / request inputs' };
      case 'WAITING_FOR_INPUTS': {
        const ins = inputsByProject.get(String(p._id)) || [];
        const owner = ins.find((i) => i.owner);
        const who = owner ? { kind: 'user', id: owner.owner._id, name: owner.owner.name } : { kind: 'client', name: (ins[0] && ins[0].source) || p.client || 'Client' };
        return { ...who, action: `${ins.length || 'Some'} input${ins.length === 1 ? '' : 's'} outstanding` };
      }
      case 'INPUTS_READY':
      case 'IN_PROGRESS':
        return { ...assigneeOr(p), action: 'Produce the first draft' };
      case 'REVISION_REQUESTED':
      case 'REVISION_IN_PROGRESS':
        return { ...assigneeOr(p), action: 'Apply the locked feedback' };
      case 'FIRST_DRAFT_SUBMITTED':
      case 'UNDER_REVIEW':
      case 'REVISION_SUBMITTED':
        return { ...roleOwner('reviewer'), action: 'Review the latest version' };
      case 'APPROVED':
        return { ...roleOwner('publisher'), action: 'Schedule it' };
      case 'SCHEDULED':
        if (failedByProject.get(String(p._id))) return { ...roleOwner('publisher'), action: 'Fix a failed post' };
        return { kind: 'system', name: 'Scheduler', action: 'Goes live on schedule' };
      default:
        return null;
    }
  }

  const liveSince = new Date(now.getTime() - 30 * 86400000);
  const stages = STAGES.map((s) => {
    let items = projects.filter((p) => s.statuses.includes(p.status));
    if (s.key === 'live') items = items.filter((p) => p.publishedAt && new Date(p.publishedAt) >= liveSince);
    return {
      key: s.key,
      label: s.label,
      count: items.length + (s.key === 'idea' ? openConcepts : 0),
      concepts: s.key === 'idea' ? openConcepts : undefined,
      items: items.slice(0, 6).map((p) => ({
        _id: p._id,
        title: p.title,
        status: p.status,
        client: p.client || '',
        updatedAt: p.updatedAt,
        publishProgress: p.publishProgress,
        failedPosts: failedByProject.get(String(p._id)) || 0,
        blockedOn: s.key === 'live' ? null : blockedOn(p),
      })),
    };
  });

  // who is the pipeline waiting on (people/roles with the most items)
  const waiting = new Map();
  for (const p of projects) {
    if (p.status === 'PUBLISHED') continue;
    const b = blockedOn(p);
    if (!b || b.kind === 'system') continue;
    const key = `${b.kind}:${b.name}`;
    const w = waiting.get(key) || { kind: b.kind, name: b.name, count: 0, projects: [] };
    w.count += 1;
    if (w.projects.length < 3) w.projects.push({ _id: p._id, title: p.title, action: b.action });
    waiting.set(key, w);
  }
  const blocked = [...waiting.values()].sort((a, b) => b.count - a.count);

  // going live today (team timezone)
  const today = localParts(now, config.timezone).date;
  const window = await Publication.find({
    organizationId,
    status: { $in: ['scheduled', 'published', 'failed'] },
    $or: [
      { scheduledFor: { $gte: new Date(now.getTime() - 36 * 3600000), $lte: new Date(now.getTime() + 36 * 3600000) } },
      { publishedAt: { $gte: new Date(now.getTime() - 36 * 3600000), $lte: new Date(now.getTime() + 36 * 3600000) } },
    ],
  }).lean();
  const todays = window.filter((p) => {
    const t = p.status === 'published' ? p.publishedAt : p.scheduledFor;
    return t && localParts(t, config.timezone).date === today;
  });
  const chIds = [...new Set(todays.filter((p) => p.channelId).map((p) => String(p.channelId)))];
  const chans = await SocialChannel.find({ _id: { $in: chIds } }, { platform: 1, name: 1 }).lean();
  const chById = new Map(chans.map((c) => [String(c._id), c]));
  const pTitle = new Map(projects.map((p) => [String(p._id), p.title]));
  const missingTitles = todays.filter((p) => !pTitle.has(String(p.projectId))).map((p) => p.projectId);
  if (missingTitles.length) {
    for (const p of await Project.find({ _id: { $in: missingTitles } }, { title: 1 }).lean()) pTitle.set(String(p._id), p.title);
  }
  const goingLiveToday = todays
    .map((p) => ({
      _id: p._id,
      projectId: p.projectId,
      title: pTitle.get(String(p.projectId)) || 'Untitled',
      status: p.status,
      at: p.status === 'published' ? p.publishedAt : p.scheduledFor,
      platform: (chById.get(String(p.channelId)) || {}).platform || String(p.platform).toLowerCase(),
      channel: (chById.get(String(p.channelId)) || {}).name || p.platform,
      failureReason: p.failureReason || '',
    }))
    .sort((a, b) => new Date(a.at) - new Date(b.at));

  const week = await analytics.summary({ organizationId, days: 7, now });
  const best = week.topContent[0] || null;

  return {
    stages,
    blocked,
    goingLiveToday,
    failedPosts: failed.length,
    lastWeekBest: best ? { ...best, simulated: week.simulated } : null,
    lastWeek: { views: week.totals.views, engagementRate: week.totals.engagementRate, change: week.change.views, simulated: week.simulated },
  };
}

module.exports = { pipeline, STAGES };
