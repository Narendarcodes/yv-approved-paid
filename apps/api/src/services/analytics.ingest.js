/**
 * Analytics ingestion (Phase 2, ADR 0009).
 *
 * For every published post: GET /analytics/post/:postId?date=7|30|90 (Postiz)
 * or a simulated series (demo mode), stored as one PerformanceMetric row per
 * metric per day. Cadence: hourly for the first 48h after publish, then daily,
 * stopping after 90 days. For every connected channel: platform analytics
 * (GET /analytics/:integrationId) once a day; follower levels also produce a
 * derived followersGained per day.
 */
const Publication = require('../models/publication.model');
const SocialChannel = require('../models/socialChannel.model');
const PerformanceMetric = require('../models/performanceMetric.model');
const adapter = require('./scheduling');
const postizClient = require('../integrations/postiz/client');
const { normalizeLabel } = require('./scheduling/postiz.provider');
const logger = require('../utils/logger');

const HOUR = 3600000;
const DAY = 24 * HOUR;
const MAX_AGE_DAYS = 90;
// Platform-level series that are levels (running totals), not per-day flows.
const CUMULATIVE_PLATFORM = new Set(['followers']);

function dayOf(dateStr) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function windowFor(publishedAt, now) {
  const age = Math.ceil((now - new Date(publishedAt || now)) / DAY) + 1;
  if (age <= 7) return 7;
  if (age <= 30) return 30;
  return 90;
}

/** Is this publication due for an ingestion run at `now`? */
function isDue(pub, now = new Date()) {
  if (pub.status !== 'published' || !pub.publishedAt) return false;
  const age = now - new Date(pub.publishedAt);
  if (age > MAX_AGE_DAYS * DAY) return false;
  if (!pub.analyticsSyncedAt) return true;
  const since = now - new Date(pub.analyticsSyncedAt);
  return age < 48 * HOUR ? since >= HOUR : since >= DAY;
}

async function upsertRows(rows) {
  if (!rows.length) return 0;
  const ops = rows.map((r) => ({
    updateOne: {
      filter:
        r.scope === 'platform'
          ? { scope: 'platform', channelId: r.channelId, metric: r.metric, date: r.date }
          : { scope: 'post', publicationId: r.publicationId, metric: r.metric, date: r.date },
      update: { $set: { ...r, recordedAt: new Date() } },
      upsert: true,
    },
  }));
  await PerformanceMetric.bulkWrite(ops, { ordered: false });
  return rows.length;
}

function toPoints(s, now = new Date()) {
  // a point without a date is read as "as of today"
  return s.data
    .map((d) => ({ date: d.date ? dayOf(d.date) : dayOf(new Date(now).toISOString()), value: Number(d.total) }))
    .filter((d) => d.date && Number.isFinite(d.value))
    .sort((a, b) => a.date - b.date);
}

/** Ingest one published post. Returns { rows, simulated }. */
async function ingestPublication(pub, now = new Date()) {
  if (pub.status !== 'published' || pub.provider === 'manual') return { rows: 0, simulated: false };
  const provider = adapter.providerFor(pub);
  const days = windowFor(pub.publishedAt, now);
  let series;
  let simulated = false;
  if (provider.name === 'postiz') {
    if (!adapter.postizEnabled() || !pub.externalPostId) return { rows: 0, simulated: false };
    series = await postizClient.getPostAnalytics(pub.externalPostId, days);
  } else {
    series = adapter.localProvider.simulateSeries(pub, now, days);
    simulated = true;
  }
  const channel = pub.channelId ? await SocialChannel.findById(pub.channelId, { platform: 1 }) : null;
  const platform = (channel && channel.platform) || String(pub.platform || '').toLowerCase();
  const rows = [];
  const latest = {};
  for (const s of series || []) {
    const label = String(s.label || '').trim();
    if (!label || !Array.isArray(s.data)) continue;
    const metric = normalizeLabel(label) || `raw:${label.toLowerCase()}`;
    const points = toPoints(s, now);
    for (const p of points) {
      rows.push({
        organizationId: pub.organizationId,
        projectId: pub.projectId,
        publicationId: pub._id,
        channelId: pub.channelId,
        platform,
        scope: 'post',
        rawLabel: label,
        metric,
        value: p.value,
        date: p.date,
        cumulative: true,
        simulated,
        source: simulated ? 'simulated' : 'postiz',
      });
    }
    if (points.length && !metric.startsWith('raw:')) latest[metric] = points[points.length - 1].value;
  }
  const n = await upsertRows(rows);
  if (Object.keys(latest).length) {
    pub.metrics = latest;
    pub.markModified('metrics');
    pub.metricsSimulated = simulated;
    pub.lastSyncedAt = now;
  }
  pub.analyticsSyncedAt = now;
  await pub.save();
  return { rows: n, simulated };
}

/** Ingest one channel's platform analytics (followers, impressions...). */
async function ingestChannel(channel, now = new Date(), days = 30) {
  let series;
  let simulated = false;
  if (channel.mode === 'postiz') {
    if (!adapter.postizEnabled() || !channel.externalId) return { rows: 0 };
    series = await postizClient.getPlatformAnalytics(channel.externalId, days);
  } else {
    series = adapter.localProvider.simulatePlatformSeries(channel, now, days);
    simulated = true;
  }
  const rows = [];
  const hasGained = (series || []).some((s) => normalizeLabel(s.label) === 'followersGained');
  for (const s of series || []) {
    const label = String(s.label || '').trim();
    if (!label || !Array.isArray(s.data)) continue;
    const metric = normalizeLabel(label) || `raw:${label.toLowerCase()}`;
    const points = toPoints(s, now);
    const base = {
      organizationId: channel.organizationId,
      channelId: channel._id,
      platform: channel.platform,
      scope: 'platform',
      simulated,
      source: simulated ? 'simulated' : 'postiz',
    };
    points.forEach((p, i) => {
      rows.push({ ...base, rawLabel: label, metric, value: p.value, date: p.date, cumulative: CUMULATIVE_PLATFORM.has(metric) });
      // derive followers gained per day from the follower level
      if (metric === 'followers' && !hasGained && i > 0) {
        rows.push({ ...base, rawLabel: `${label} (derived)`, metric: 'followersGained', value: Math.max(0, p.value - points[i - 1].value), date: p.date, cumulative: false });
      }
    });
  }
  const n = await upsertRows(rows);
  channel.analyticsSyncedAt = now;
  await channel.save();
  return { rows: n, simulated };
}

/** One ingestion pass: due posts + channels not synced in the last day. */
async function runIngestion(now = new Date(), { limit = 50 } = {}) {
  const summary = { posts: 0, channels: 0, rows: 0, errors: 0 };
  const providers = adapter.postizEnabled() ? ['local', 'postiz'] : ['local'];
  const candidates = await Publication.find({
    status: 'published',
    provider: { $in: providers },
    publishedAt: { $gte: new Date(now.getTime() - MAX_AGE_DAYS * DAY) },
    $or: [{ analyticsSyncedAt: null }, { analyticsSyncedAt: { $lte: new Date(now.getTime() - HOUR) } }],
  })
    .sort({ analyticsSyncedAt: 1 })
    .limit(limit * 4);
  for (const pub of candidates.filter((p) => isDue(p, now)).slice(0, limit)) {
    try {
      const r = await ingestPublication(pub, now);
      summary.posts += 1;
      summary.rows += r.rows;
    } catch (err) {
      summary.errors += 1;
      logger.warn({ err, publicationId: pub._id }, 'post analytics ingestion failed');
    }
  }
  const modes = adapter.postizEnabled() ? ['demo', 'postiz'] : ['demo'];
  const channels = await SocialChannel.find({
    status: 'connected',
    mode: { $in: modes },
    $or: [{ analyticsSyncedAt: null }, { analyticsSyncedAt: { $lte: new Date(now.getTime() - DAY) } }],
  }).limit(limit);
  for (const ch of channels) {
    try {
      const r = await ingestChannel(ch, now);
      summary.channels += 1;
      summary.rows += r.rows;
    } catch (err) {
      summary.errors += 1;
      logger.warn({ err, channelId: ch._id }, 'platform analytics ingestion failed');
    }
  }
  return summary;
}

module.exports = { ingestPublication, ingestChannel, runIngestion, isDue, windowFor };
