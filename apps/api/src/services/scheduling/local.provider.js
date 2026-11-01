/**
 * LocalSchedulerProvider - the built-in fallback used for 'demo' channels and
 * whenever Postiz is not configured. Nothing leaves the server: the scheduler
 * loop publishes due posts itself, the live URL is a demo permalink on the
 * channel's profile, and metrics are simulated (flagged as such) so the
 * analytics sync can be demonstrated end to end without real tokens.
 */
const crypto = require('crypto');
const { profileUrl } = require('../../integrations/postiz/channels');

const name = 'local';

function seedFrom(str) {
  return crypto.createHash('sha1').update(String(str)).digest().readUInt32BE(0);
}

async function createPost({ publication }) {
  return { externalPostId: `local_${publication._id}` };
}

async function cancelPost() {
  /* nothing external to cancel */
}

function demoPostUrl(publication, channel) {
  const base = channel ? profileUrl(channel.platform, channel.handle) : '';
  const slug = String(publication._id).slice(-8);
  if (!base) return `https://demo.yv.local/posts/${slug}`;
  return `${base}${base.endsWith('/') ? '' : '/'}?yv_demo_post=${slug}`;
}

/** Publish now (called by the scheduler for due posts, or "Publish now"). */
async function publish({ publication, channel }) {
  return { postUrl: demoPostUrl(publication, channel), externalPostId: publication.externalPostId || `local_${publication._id}` };
}

/** Local posts only change state through publish(); nothing to poll. */
async function syncPublications() {
  return [];
}

/**
 * Simulated, deterministic metrics that grow with time since publish
 * (approaching a per-post ceiling over ~3 days).
 */
async function fetchMetrics(publication, now = new Date()) {
  const seed = seedFrom(publication._id);
  const hours = Math.max(0, (now - new Date(publication.publishedAt || now)) / 3600000);
  const curve = 1 - Math.exp(-(hours + 2) / 30);
  const ceiling = 4000 + (seed % 16000);
  const views = Math.round(ceiling * curve);
  const likes = Math.round(views * (0.05 + ((seed >>> 4) % 40) / 1000));
  const comments = Math.round(likes * (0.04 + ((seed >>> 8) % 30) / 1000));
  const shares = Math.round(likes * (0.06 + ((seed >>> 12) % 30) / 1000));
  return { metrics: { views, likes, comments, shares }, simulated: true };
}

const DAY = 86400000;
const dayStart = (d) => {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
};
const iso = (d) => dayStart(d).toISOString().slice(0, 10);

/** Per-post simulated cumulative totals at `at` (deterministic per post). */
function simulatedTotals(publication, at) {
  const seed = seedFrom(publication._id);
  const hours = Math.max(0, (at - new Date(publication.publishedAt || at)) / 3600000);
  const curve = 1 - Math.exp(-(hours + 2) / 30);
  const ceiling = 4000 + (seed % 16000);
  const views = Math.round(ceiling * curve);
  const likes = Math.round(views * (0.05 + ((seed >>> 4) % 40) / 1000));
  const comments = Math.round(likes * (0.04 + ((seed >>> 8) % 30) / 1000));
  const shares = Math.round(likes * (0.06 + ((seed >>> 12) % 30) / 1000));
  const saves = Math.round(likes * (0.08 + ((seed >>> 16) % 40) / 1000));
  const out = { Impressions: views, Likes: likes, Comments: comments, Shares: shares, Saves: saves };
  if (String(publication.platform).toLowerCase() === 'youtube') out['Watch time (minutes)'] = Math.round(views * (0.4 + ((seed >>> 20) % 50) / 100));
  return out;
}

/**
 * Simulated post analytics in the Postiz shape: [{ label, data: [{ total, date }] }],
 * one cumulative point per day from the publish day (or `days` back) to `now`.
 * Clearly simulated - the ingestion stores it with simulated: true.
 */
function simulateSeries(publication, now = new Date(), days = 30) {
  const published = new Date(publication.publishedAt || now);
  const start = Math.max(dayStart(published).getTime(), dayStart(now).getTime() - (days - 1) * DAY);
  const series = {};
  for (let t = start; t <= dayStart(now).getTime(); t += DAY) {
    const at = new Date(Math.min(t + DAY - 1, now.getTime()));
    const totals = simulatedTotals(publication, at);
    for (const [label, total] of Object.entries(totals)) {
      (series[label] = series[label] || []).push({ total: String(total), date: iso(t) });
    }
  }
  return Object.entries(series).map(([label, data]) => ({ label, data, percentageChange: 0 }));
}

/** Simulated channel analytics: Followers (running level) + daily Impressions. */
function simulatePlatformSeries(channel, now = new Date(), days = 30) {
  const seed = seedFrom(channel._id);
  const base = 1500 + (seed % 18000);
  const followers = [];
  const impressions = [];
  const created = dayStart(channel.createdAt || now).getTime() - 90 * DAY;
  let level = base;
  for (let t = created; t <= dayStart(now).getTime(); t += DAY) {
    const dow = new Date(t).getUTCDay();
    const gain = 4 + ((seed >>> (dow + 3)) % 25) + (dow === 3 || dow === 5 ? 12 : 0);
    level += gain;
    if (t >= dayStart(now).getTime() - (days - 1) * DAY) {
      followers.push({ total: String(level), date: iso(t) });
      impressions.push({ total: String(Math.round(level * (0.35 + ((seed >>> dow) % 30) / 100))), date: iso(t) });
    }
  }
  return [
    { label: 'Followers', data: followers, percentageChange: 0 },
    { label: 'Impressions', data: impressions, percentageChange: 0 },
  ];
}

module.exports = {
  name,
  createPost,
  cancelPost,
  publish,
  syncPublications,
  fetchMetrics,
  simulateSeries,
  simulatePlatformSeries,
  _demoPostUrl: demoPostUrl,
};
