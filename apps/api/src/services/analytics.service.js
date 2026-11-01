/**
 * Analytics read model (Phase 2). Everything is derived from the
 * PerformanceMetric time series written by analytics.ingest.js.
 *
 * Post metrics are cumulative snapshots per day, so "what happened in a
 * window [from, to]" for a post = value as of `to` minus value as of `from`.
 * Platform flows (impressions, followersGained) are summed per day.
 */
const mongoose = require('mongoose');
const Project = require('../models/project.model');
const Publication = require('../models/publication.model');
const SocialChannel = require('../models/socialChannel.model');
const PerformanceMetric = require('../models/performanceMetric.model');
const Concept = require('../models/concept.model');
const config = require('../config');
const { localParts, WEEKDAYS } = require('../utils/tz');
const { platformLabel } = require('../integrations/postiz/channels');

const DAY = 86400000;
const METRICS = ['views', 'likes', 'comments', 'shares', 'saves', 'watchTime'];
const ENGAGEMENT = ['likes', 'comments', 'shares', 'saves'];
const ALLOWED_DAYS = [7, 30, 90];

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const dayStart = (d) => {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
};
const pct = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : cur ? null : 0);
const rate = (m) => (m.views ? (ENGAGEMENT.reduce((s, k) => s + (m[k] || 0), 0) / m.views) : 0);
const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

function clampDays(days) {
  const n = parseInt(days, 10);
  return ALLOWED_DAYS.includes(n) ? n : 30;
}

function badRequest(message) {
  return { status: 400, code: 'validation_error', message };
}

/** Load post-scope series for an org (optionally restricted) -> Map(key -> {meta, metrics: {m: [{t, v}]}}). */
async function loadPostSeries(organizationId, { projectIds = null, until = new Date() } = {}) {
  const q = { organizationId: oid(organizationId), scope: 'post', metric: { $in: METRICS } };
  if (projectIds) q.projectId = { $in: projectIds.map(oid) };
  const rows = await PerformanceMetric.find(q, { publicationId: 1, projectId: 1, platform: 1, metric: 1, value: 1, date: 1, recordedAt: 1, simulated: 1 }).lean();
  const series = new Map();
  let simulated = false;
  for (const r of rows) {
    const t = (r.date || r.recordedAt || new Date(0)).getTime();
    if (t > until.getTime()) continue;
    const key = r.publicationId ? String(r.publicationId) : `project:${r.projectId}`;
    let s = series.get(key);
    if (!s) {
      s = { publicationId: r.publicationId ? String(r.publicationId) : null, projectId: String(r.projectId), platform: r.platform, metrics: {} };
      series.set(key, s);
    }
    if (r.platform && !s.platform) s.platform = r.platform;
    (s.metrics[r.metric] = s.metrics[r.metric] || []).push({ t, v: r.value });
    if (r.simulated) simulated = true;
  }
  for (const s of series.values()) for (const m of Object.keys(s.metrics)) s.metrics[m].sort((a, b) => a.t - b.t);
  return { series, simulated };
}

/** value of a cumulative series as of time t (last point <= t), 0 before the first */
function valueAt(points, t) {
  if (!points || !points.length) return 0;
  let lo = 0;
  let hi = points.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans === -1 ? 0 : points[ans].v;
}

function growth(s, from, to) {
  const out = {};
  for (const m of METRICS) out[m] = Math.max(0, valueAt(s.metrics[m], to) - valueAt(s.metrics[m], from));
  return out;
}

function lifetime(s, to) {
  const out = {};
  for (const m of METRICS) out[m] = valueAt(s.metrics[m], to);
  return out;
}

function addInto(acc, m) {
  for (const k of METRICS) acc[k] = (acc[k] || 0) + (m[k] || 0);
  return acc;
}

function emptyTotals() {
  return METRICS.reduce((o, k) => ({ ...o, [k]: 0 }), {});
}

async function platformFlows(organizationId, from, to) {
  const rows = await PerformanceMetric.find({
    organizationId: oid(organizationId),
    scope: 'platform',
    metric: { $in: ['followersGained', 'followers'] },
    date: { $gt: from, $lte: to },
  }).lean();
  const gained = {};
  const followers = {};
  let simulated = false;
  for (const r of rows) {
    if (r.simulated) simulated = true;
    if (r.metric === 'followersGained') gained[r.platform] = (gained[r.platform] || 0) + r.value;
    if (r.metric === 'followers') {
      const cur = followers[r.platform];
      if (!cur || cur.t < r.date.getTime()) followers[r.platform] = { t: r.date.getTime(), v: r.value, ch: String(r.channelId) };
    }
  }
  return { gained, followers, simulated };
}

/**
 * Org-wide summary for a 7/30/90-day window: totals with % change vs the
 * previous window, daily trend, top content, platform comparison, rollups.
 */
async function summary({ organizationId, days = 30, now = new Date() }) {
  days = clampDays(days);
  const to = now.getTime();
  const from = to - days * DAY;
  const prevFrom = from - days * DAY;
  const { series, simulated } = await loadPostSeries(organizationId, { until: now });

  const totals = emptyTotals();
  const prev = emptyTotals();
  const byProject = new Map();
  const byPlatform = new Map();
  for (const s of series.values()) {
    const g = growth(s, from, to);
    addInto(totals, g);
    addInto(prev, growth(s, prevFrom, from));
    const p = byProject.get(s.projectId) || { projectId: s.projectId, metrics: emptyTotals(), platforms: new Set(), posts: 0 };
    addInto(p.metrics, g);
    p.platforms.add(s.platform);
    p.posts += 1;
    byProject.set(s.projectId, p);
    const pl = byPlatform.get(s.platform) || { platform: s.platform, metrics: emptyTotals(), posts: 0 };
    addInto(pl.metrics, g);
    if (g.views || g.likes) pl.posts += 1;
    byPlatform.set(s.platform, pl);
  }
  const engagements = ENGAGEMENT.reduce((a, k) => a + totals[k], 0);
  const prevEngagements = ENGAGEMENT.reduce((a, k) => a + prev[k], 0);

  // daily trend (sum of per-day increments)
  const trend = [];
  for (let t = dayStart(from + DAY).getTime(); t <= to; t += DAY) {
    const day = { date: new Date(t).toISOString().slice(0, 10), views: 0, engagements: 0 };
    for (const s of series.values()) {
      const end = Math.min(t + DAY - 1, to);
      day.views += Math.max(0, valueAt(s.metrics.views, end) - valueAt(s.metrics.views, t - 1));
      for (const k of ENGAGEMENT) day.engagements += Math.max(0, valueAt(s.metrics[k], end) - valueAt(s.metrics[k], t - 1));
    }
    trend.push(day);
  }

  const flows = await platformFlows(organizationId, new Date(from), now);
  const prevFlows = await platformFlows(organizationId, new Date(prevFrom), new Date(from));
  const followersGained = Object.values(flows.gained).reduce((a, b) => a + b, 0);
  const prevFollowersGained = Object.values(prevFlows.gained).reduce((a, b) => a + b, 0);

  const projects = await Project.find({ _id: { $in: [...byProject.keys()].map(oid) } }, { title: 1, client: 1, campaign: 1, publishedAt: 1, conceptId: 1 }).lean();
  const pById = new Map(projects.map((p) => [String(p._id), p]));

  const topContent = [...byProject.values()]
    .filter((p) => p.metrics.views >= 50)
    .map((p) => {
      const proj = pById.get(p.projectId) || {};
      return {
        projectId: p.projectId,
        title: proj.title || 'Untitled',
        client: proj.client || '',
        platforms: [...p.platforms].filter(Boolean),
        views: p.metrics.views,
        engagements: ENGAGEMENT.reduce((a, k) => a + p.metrics[k], 0),
        engagementRate: round(rate(p.metrics)),
      };
    })
    .sort((a, b) => b.engagementRate - a.engagementRate || b.views - a.views)
    .slice(0, 10);

  const platforms = [...byPlatform.values()]
    .filter((p) => p.platform)
    .map((p) => ({
      platform: p.platform,
      label: platformLabel(p.platform),
      posts: p.posts,
      views: p.metrics.views,
      likes: p.metrics.likes,
      comments: p.metrics.comments,
      shares: p.metrics.shares,
      saves: p.metrics.saves,
      watchTime: p.metrics.watchTime,
      engagementRate: round(rate(p.metrics)),
      followersGained: flows.gained[p.platform] || 0,
      followers: flows.followers[p.platform] ? flows.followers[p.platform].v : null,
    }))
    .sort((a, b) => b.views - a.views);

  const rollup = (field) => {
    const groups = new Map();
    for (const p of byProject.values()) {
      const proj = pById.get(p.projectId) || {};
      const key = proj[field] || '';
      const g = groups.get(key) || { name: key || (field === 'client' ? 'No client' : 'No campaign'), projects: 0, metrics: emptyTotals() };
      g.projects += 1;
      addInto(g.metrics, p.metrics);
      groups.set(key, g);
    }
    return [...groups.values()]
      .map((g) => ({ name: g.name, projects: g.projects, views: g.metrics.views, engagements: ENGAGEMENT.reduce((a, k) => a + g.metrics[k], 0), engagementRate: round(rate(g.metrics)) }))
      .sort((a, b) => b.views - a.views);
  };

  return {
    days,
    from: new Date(from),
    to: now,
    simulated: simulated || flows.simulated,
    totals: {
      ...totals,
      engagements,
      engagementRate: round(rate(totals)),
      followersGained,
      posts: [...series.values()].filter((s) => growth(s, from, to).views > 0).length,
    },
    change: {
      views: pct(totals.views, prev.views),
      engagements: pct(engagements, prevEngagements),
      engagementRate: rate(prev) ? Math.round((rate(totals) - rate(prev)) * 10000) / 100 : null, // percentage points
      followersGained: pct(followersGained, prevFollowersGained),
      watchTime: pct(totals.watchTime, prev.watchTime),
    },
    trend,
    topContent,
    platforms,
    rollups: { client: rollup('client'), campaign: rollup('campaign') },
  };
}

/** Best posting day/hour from our own history: 7x24 grid of avg engagement rate. */
async function heatmap({ organizationId, now = new Date(), lookbackDays = 180 }) {
  const pubs = await Publication.find({
    organizationId: oid(organizationId),
    status: 'published',
    publishedAt: { $gte: new Date(now.getTime() - lookbackDays * DAY), $lte: now },
  }).lean();
  const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ n: 0, sum: 0 })));
  let simulated = false;
  for (const p of pubs) {
    const m = p.metrics || {};
    if (!m.views) continue;
    if (p.metricsSimulated) simulated = true;
    const { weekday, hour } = localParts(p.publishedAt, config.timezone);
    grid[weekday][hour].n += 1;
    grid[weekday][hour].sum += rate(m);
  }
  const cells = [];
  let best = null;
  grid.forEach((row, weekday) =>
    row.forEach((c, hour) => {
      if (!c.n) return;
      const cell = { weekday, day: WEEKDAYS[weekday], hour, posts: c.n, engagementRate: round(c.sum / c.n) };
      cells.push(cell);
      if (!best || cell.engagementRate > best.engagementRate) best = cell;
    })
  );
  const byDay = WEEKDAYS.map((day, weekday) => {
    const row = grid[weekday];
    const n = row.reduce((a, c) => a + c.n, 0);
    return { weekday, day, posts: n, engagementRate: n ? round(row.reduce((a, c) => a + c.sum, 0) / n) : 0 };
  });
  return { timezone: config.timezone, posts: pubs.filter((p) => (p.metrics || {}).views).length, simulated, cells, byDay, best };
}

/** Per-channel performance for one project (Project detail "Performance" card). */
async function projectPerformance({ organizationId, projectId, days = 30, now = new Date() }) {
  const project = await Project.findOne({ _id: projectId, organizationId });
  if (!project) throw { status: 404, code: 'project_not_found', message: 'Project not found' };
  days = clampDays(days);
  const pubs = await Publication.find({ projectId, status: 'published' }).sort({ publishedAt: 1 });
  const channels = await SocialChannel.find({ _id: { $in: pubs.map((p) => p.channelId).filter(Boolean) } });
  const chById = new Map(channels.map((c) => [String(c._id), c]));
  const { series, simulated } = await loadPostSeries(organizationId, { projectIds: [projectId], until: now });
  const to = now.getTime();
  const half = Math.max(1, Math.round(Math.min(days, 14) / 2));
  const rows = pubs.map((pub) => {
    const s = series.get(String(pub._id)) || { metrics: {} };
    const life = s.metrics.views ? lifetime(s, to) : { ...emptyTotals(), ...(pub.metrics || {}) };
    const spark = [];
    const start = Math.max(dayStart(pub.publishedAt || now).getTime(), dayStart(to - (days - 1) * DAY).getTime());
    for (let t = start; t <= to; t += DAY) {
      spark.push({ date: new Date(t).toISOString().slice(0, 10), views: Math.max(0, valueAt(s.metrics.views, Math.min(t + DAY - 1, to)) - valueAt(s.metrics.views, t - 1)) });
    }
    const recent = valueAt(s.metrics.views, to) - valueAt(s.metrics.views, to - half * DAY);
    const before = valueAt(s.metrics.views, to - half * DAY) - valueAt(s.metrics.views, to - 2 * half * DAY);
    const ch = pub.channelId ? chById.get(String(pub.channelId)) : null;
    return {
      publicationId: pub._id,
      platform: (ch && ch.platform) || String(pub.platform).toLowerCase(),
      channel: ch ? { _id: ch._id, name: ch.name, handle: ch.handle } : null,
      postUrl: pub.postUrl,
      provider: pub.provider,
      publishedAt: pub.publishedAt,
      metrics: life,
      engagementRate: round(rate(life)),
      sparkline: spark,
      change: { window: `${half}d`, views: pct(recent, before) },
      simulated: Boolean(pub.metricsSimulated) || pub.provider === 'local',
      lastSyncedAt: pub.analyticsSyncedAt || pub.lastSyncedAt,
    };
  });
  const totals = rows.reduce((acc, r) => addInto(acc, r.metrics), emptyTotals());
  return {
    projectId,
    days,
    simulated: simulated || rows.some((r) => r.simulated),
    totals: { ...totals, engagementRate: round(rate(totals)) },
    channels: rows,
    pending: await Publication.countDocuments({ projectId, status: { $in: ['scheduled', 'failed'] } }),
  };
}

function monthRange(month, now = new Date()) {
  let y;
  let m;
  if (month) {
    const match = /^(\d{4})-(\d{1,2})$/.exec(String(month));
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) throw badRequest('month must be YYYY-MM');
    y = Number(match[1]);
    m = Number(match[2]) - 1;
  } else {
    y = now.getUTCFullYear();
    m = now.getUTCMonth() - 1; // last full month
  }
  const from = new Date(Date.UTC(y, m, 1));
  const to = new Date(Date.UTC(y, m + 1, 1) - 1);
  return { from, to, label: from.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }), key: `${from.getUTCFullYear()}-${String(from.getUTCMonth() + 1).padStart(2, '0')}` };
}

/** Top performing published projects of a month (default: last month) - for the Concepts board. */
async function topPerformers({ organizationId, month, limit = 5, now = new Date() }) {
  const range = monthRange(month, now);
  const projects = await Project.find({ organizationId, publishedAt: { $gte: range.from, $lte: range.to } }, { title: 1, conceptId: 1, client: 1, campaign: 1, publishedAt: 1, type: 1 }).lean();
  if (!projects.length) return { month: range.key, label: range.label, items: [] };
  const { series, simulated } = await loadPostSeries(organizationId, { projectIds: projects.map((p) => p._id), until: now });
  const agg = new Map();
  for (const s of series.values()) {
    const a = agg.get(s.projectId) || { metrics: emptyTotals(), platforms: new Set() };
    addInto(a.metrics, lifetime(s, now.getTime()));
    a.platforms.add(s.platform);
    agg.set(s.projectId, a);
  }
  const concepts = await Concept.find({ approvedProjectId: { $in: projects.map((p) => p._id) } }, { title: 1, approvedProjectId: 1 }).lean();
  const cByProject = new Map(concepts.map((c) => [String(c.approvedProjectId), c]));
  const items = projects
    .map((p) => {
      const a = agg.get(String(p._id)) || { metrics: emptyTotals(), platforms: new Set() };
      const concept = cByProject.get(String(p._id));
      return {
        projectId: p._id,
        title: p.title,
        type: p.type,
        client: p.client || '',
        publishedAt: p.publishedAt,
        platforms: [...a.platforms].filter(Boolean),
        views: a.metrics.views,
        engagementRate: round(rate(a.metrics)),
        concept: concept ? { _id: concept._id, title: concept.title } : null,
      };
    })
    .filter((x) => x.views > 0)
    .sort((a, b) => b.engagementRate - a.engagementRate || b.views - a.views)
    .slice(0, limit);
  return { month: range.key, label: range.label, simulated, items };
}

/**
 * Client performance report for one project (lifetime) or one month (posts
 * published that month, optionally one client). Rendered by the printable
 * report page; JSON so it can also feed a PDF service later.
 */
async function report({ organizationId, projectId, month, client, now = new Date() }) {
  let projects;
  let period;
  if (projectId) {
    const p = await Project.findOne({ _id: projectId, organizationId }).lean();
    if (!p) throw { status: 404, code: 'project_not_found', message: 'Project not found' };
    projects = [p];
    period = { kind: 'project', label: `Lifetime to ${now.toISOString().slice(0, 10)}`, from: p.publishedAt, to: now };
  } else {
    const range = monthRange(month, now);
    const q = { organizationId, publishedAt: { $gte: range.from, $lte: range.to } };
    if (client) q.client = client;
    projects = await Project.find(q).lean();
    period = { kind: 'month', label: range.label, month: range.key, from: range.from, to: range.to };
  }
  const ids = projects.map((p) => p._id);
  const pubs = await Publication.find({ projectId: { $in: ids }, status: 'published' }).sort({ publishedAt: 1 }).lean();
  const channels = await SocialChannel.find({ _id: { $in: pubs.map((p) => p.channelId).filter(Boolean) } }).lean();
  const chById = new Map(channels.map((c) => [String(c._id), c]));
  const { series, simulated } = await loadPostSeries(organizationId, { projectIds: ids, until: now });
  const pTitle = new Map(projects.map((p) => [String(p._id), p]));
  const posts = pubs.map((pub) => {
    const s = series.get(String(pub._id));
    const m = s ? lifetime(s, now.getTime()) : { ...emptyTotals(), ...(pub.metrics || {}) };
    const ch = pub.channelId ? chById.get(String(pub.channelId)) : null;
    return {
      publicationId: pub._id,
      project: (pTitle.get(String(pub.projectId)) || {}).title,
      projectId: pub.projectId,
      platform: (ch && ch.platform) || String(pub.platform).toLowerCase(),
      channel: ch ? ch.name : pub.platform,
      publishedAt: pub.publishedAt,
      postUrl: pub.postUrl,
      metrics: m,
      engagementRate: round(rate(m)),
      simulated: Boolean(pub.metricsSimulated) || pub.provider === 'local',
    };
  });
  const totals = posts.reduce((acc, p) => addInto(acc, p.metrics), emptyTotals());
  const byPlatform = {};
  for (const p of posts) {
    const b = byPlatform[p.platform] || { platform: p.platform, label: platformLabel(p.platform), posts: 0, metrics: emptyTotals() };
    b.posts += 1;
    addInto(b.metrics, p.metrics);
    byPlatform[p.platform] = b;
  }
  const platforms = Object.values(byPlatform).map((b) => ({ ...b, engagementRate: round(rate(b.metrics)) }));
  const best = [...posts].sort((a, b) => b.engagementRate - a.engagementRate)[0] || null;
  const highlights = [];
  if (posts.length) {
    highlights.push(`${posts.length} post${posts.length === 1 ? '' : 's'} across ${platforms.length} platform${platforms.length === 1 ? '' : 's'} reached ${totals.views.toLocaleString('en-IN')} views.`);
    highlights.push(`Overall engagement rate ${(rate(totals) * 100).toFixed(1)}% (${ENGAGEMENT.reduce((a, k) => a + totals[k], 0).toLocaleString('en-IN')} likes, comments, shares and saves).`);
    if (best) highlights.push(`Best performer: "${best.project}" on ${platformLabel(best.platform)} at ${(best.engagementRate * 100).toFixed(1)}% engagement.`);
    if (platforms.length > 1) {
      const top = [...platforms].sort((a, b) => b.metrics.views - a.metrics.views)[0];
      highlights.push(`${top.label} delivered the most reach (${top.metrics.views.toLocaleString('en-IN')} views).`);
    }
  }
  return {
    generatedAt: now,
    period,
    client: client || (projects.length === 1 ? projects[0].client || '' : ''),
    simulated: simulated || posts.some((p) => p.simulated),
    projects: projects.map((p) => ({ _id: p._id, title: p.title, client: p.client || '', campaign: p.campaign || '', publishedAt: p.publishedAt })),
    totals: { ...totals, engagementRate: round(rate(totals)), posts: posts.length },
    platforms,
    posts,
    highlights,
  };
}

module.exports = { summary, heatmap, projectPerformance, topPerformers, report, clampDays, valueAt, monthRange, METRICS };
