/**
 * PostizProvider - publishes through a Postiz instance via its public API.
 * Postiz owns the actual posting; we learn about results through the webhook
 * (POST /api/v1/webhooks/postiz) and, as a safety net, by reconciling against
 * GET /posts (syncPublications).
 *
 * Media is uploaded once per approved file and the returned { id, path } is
 * cached on the ProjectVersion file (never base64-inlined: Postiz caps the
 * /posts body at 50MB).
 */
const client = require('../../integrations/postiz/client');
const { toPostizSettings, buildSettings } = require('../../integrations/postiz/settings');
const ProjectVersion = require('../../models/projectVersion.model');
const storage = require('../../storage');

const name = 'postiz';

/** Upload a version file to Postiz once; reuse the cached path afterwards. */
async function ensureMedia(version, file, opts = {}) {
  if (!file) return null;
  if (file.postizMedia && file.postizMedia.path) return { id: file.postizMedia.id || file.postizMedia.path, path: file.postizMedia.path };
  if (!file.storageRef) return null;
  const buffer = await storage.getFile(file.storageRef);
  const uploaded = await client.uploadFile({ buffer, filename: file.filename, mimeType: file.mimeType }, opts);
  if (!uploaded || !uploaded.path) return null;
  const media = { id: String(uploaded.id || uploaded.path), path: uploaded.path, uploadedAt: new Date() };
  file.postizMedia = media;
  if (version && version._id && file._id) {
    await ProjectVersion.updateOne({ _id: version._id, 'files._id': file._id }, { $set: { 'files.$.postizMedia': media } });
  }
  return { id: media.id, path: media.path };
}

function buildPayload({ type, date, channel, caption, settings, image }) {
  return {
    type,
    date: new Date(date).toISOString(),
    shortLink: false,
    tags: [],
    posts: [
      {
        integration: { id: channel.externalId },
        value: [{ content: caption || '', image: image || [] }],
        settings,
      },
    ],
  };
}

async function createPost({ publication, channel, project, version, file, type = 'schedule' }, opts = {}) {
  if (!channel || !channel.externalId) {
    throw { status: 400, code: 'channel_not_linked', message: 'This channel is not linked to a Postiz integration' };
  }
  if (channel.status === 'expired') {
    throw { status: 409, code: 'channel_expired', message: `${channel.name} needs to be reconnected before it can publish` };
  }
  const yvSettings = (publication.settings && Object.keys(publication.settings).length && publication.settings) || null;
  const files = (version && version.files) || [];
  let image = [];
  if (channel.platform === 'linkedin' && yvSettings && yvSettings.carousel) {
    for (const f of files.filter((x) => /^image\//.test(x.mimeType || ''))) {
      const m = await ensureMedia(version, f, opts);
      if (m) image.push(m);
    }
  } else {
    const m = await ensureMedia(version, file, opts);
    if (m) image = [m];
  }
  let thumbnail = null;
  if (channel.platform === 'youtube' && yvSettings && yvSettings.thumbnailFileId) {
    const thumbFile = files.find((f) => String(f._id) === String(yvSettings.thumbnailFileId));
    thumbnail = await ensureMedia(version, thumbFile, opts);
  }
  const settings = yvSettings
    ? toPostizSettings(channel.platform, yvSettings, { postizIdentifier: channel.postizIdentifier || undefined, thumbnail })
    : buildSettings(channel.platform, { title: project && project.title, postizIdentifier: channel.postizIdentifier || undefined, file });
  const payload = buildPayload({
    type,
    date: publication.scheduledFor || new Date(),
    channel,
    caption: publication.caption,
    settings,
    image,
  });
  const result = await client.createPost(payload, opts);
  const first = (result || []).find((r) => !r.integration || r.integration === channel.externalId) || (result || [])[0] || {};
  return { externalPostId: first.postId || first.id || '' };
}

async function cancelPost({ publication }, opts = {}) {
  if (publication.externalPostId) await client.deletePost(publication.externalPostId, opts);
}

async function publish({ publication, channel, project, version, file }, opts = {}) {
  // Ask Postiz to post right away; the result arrives via webhook/poll.
  if (publication.externalPostId) await client.deletePost(publication.externalPostId, opts);
  const { externalPostId } = await createPost({ publication, channel, project, version, file, type: 'now' }, opts);
  return { externalPostId, pending: true };
}

/**
 * Reconcile our posts against Postiz (GET /posts over their window).
 * Returns [{ publication, state, postUrl, error, scheduledFor }] where state is
 *   published | failed | missing (deleted in Postiz) | moved (date changed in Postiz)
 */
async function syncPublications(publications, opts = {}) {
  const withIds = publications.filter((p) => p.externalPostId);
  if (!withIds.length) return [];
  const times = withIds.map((p) => new Date(p.scheduledFor || p.createdAt).getTime());
  const startDate = new Date(Math.min(...times) - 7 * 86400000);
  const endDate = new Date(Math.max(...times, Date.now()) + 7 * 86400000);
  const posts = await client.listPosts({ startDate, endDate }, opts);
  const byId = new Map(posts.map((p) => [String(p.id), p]));
  const updates = [];
  for (const pub of withIds) {
    const post = byId.get(String(pub.externalPostId));
    if (!post) {
      if (pub.status === 'scheduled') updates.push({ publication: pub, state: 'missing', error: 'The post no longer exists in Postiz' });
      continue;
    }
    const state = String(post.state || '').toUpperCase();
    if (state === 'PUBLISHED') updates.push({ publication: pub, state: 'published', postUrl: post.releaseURL || '' });
    else if (state === 'ERROR') updates.push({ publication: pub, state: 'failed', error: post.error || 'Postiz reported an error' });
    else if (state === 'QUEUE' && post.publishDate && pub.scheduledFor) {
      const d = new Date(post.publishDate);
      if (!Number.isNaN(d.getTime()) && Math.abs(d - new Date(pub.scheduledFor)) > 60000) {
        updates.push({ publication: pub, state: 'moved', scheduledFor: d });
      }
    }
  }
  return updates;
}

/** Map a Postiz analytics label onto a normalized metric key. */
const LABEL_TO_METRIC = {
  impressions: 'views',
  views: 'views',
  'video views': 'views',
  plays: 'views',
  reach: 'reach',
  likes: 'likes',
  reactions: 'likes',
  favorites: 'likes',
  comments: 'comments',
  replies: 'comments',
  shares: 'shares',
  reposts: 'shares',
  retweets: 'shares',
  saves: 'saves',
  saved: 'saves',
  bookmarks: 'saves',
  'watch time': 'watchTime',
  'estimated minutes watched': 'watchTime',
  'watch time (minutes)': 'watchTime',
  followers: 'followers',
  'new followers': 'followersGained',
  'followers gained': 'followersGained',
  'subscribers gained': 'followersGained',
  subscribers: 'followers',
};

function normalizeLabel(label) {
  return LABEL_TO_METRIC[String(label || '').trim().toLowerCase()] || null;
}

/** GET /analytics/post/:id -> { views, likes, ... } using each series' latest total. */
async function fetchMetrics(publication, _now, opts = {}) {
  if (!publication.externalPostId) return { metrics: {}, simulated: false };
  const series = await client.getPostAnalytics(publication.externalPostId, 30, opts);
  const metrics = {};
  for (const s of series) {
    const key = normalizeLabel(s.label);
    if (!key || !Array.isArray(s.data) || !s.data.length) continue;
    const latest = Number(s.data[s.data.length - 1].total);
    if (Number.isFinite(latest)) metrics[key] = latest;
  }
  return { metrics, simulated: false };
}

module.exports = {
  name,
  createPost,
  cancelPost,
  publish,
  syncPublications,
  fetchMetrics,
  ensureMedia,
  normalizeLabel,
  LABEL_TO_METRIC,
  _buildPayload: buildPayload,
};
