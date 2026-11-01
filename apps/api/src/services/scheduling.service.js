/**
 * Social scheduling & publishing (PRD §17).
 *
 * The Content Project is the source of truth. This service owns:
 *   - connected channels (demo or Postiz-linked)
 *   - scheduling an Approved project's final asset to one or more channels
 *   - syncing publish state, live URL and metrics back onto the project
 *     (APPROVED -> SCHEDULED on scheduling, -> PUBLISHED on first publish)
 *   - the manual fallback (mark a post published with its URL by hand)
 *
 * Actual posting goes through the provider adapter in ./scheduling/.
 */
const mongoose = require('mongoose');
const Project = require('../models/project.model');
const ProjectVersion = require('../models/projectVersion.model');
const Publication = require('../models/publication.model');
const SocialChannel = require('../models/socialChannel.model');
const bus = require('../events/hub');
const adapter = require('./scheduling');
const postizClient = require('../integrations/postiz/client');
const {
  PLATFORM_KEYS,
  POSTIZ_IDENTIFIERS,
  platformLabel,
  platformFromPostizIdentifier,
} = require('../integrations/postiz/channels');
const platformSettings = require('../integrations/postiz/settings');
const config = require('../config');
const logger = require('../utils/logger');

const SCHEDULABLE = ['APPROVED', 'SCHEDULED'];

function notFound(code, message) {
  return { status: 404, code, message };
}

function badRequest(code, message) {
  return { status: 400, code, message };
}

function isId(v) {
  return mongoose.Types.ObjectId.isValid(String(v || ''));
}

/* ------------------------------ status ------------------------------ */

function getStatus() {
  return {
    mode: adapter.mode(),
    postizConfigured: adapter.postizEnabled(),
    platforms: PLATFORM_KEYS.map((key) => ({ key, label: platformLabel(key) })),
    // Register in Postiz as <api origin>/api/v1/webhooks/postiz/<POSTIZ_WEBHOOK_SECRET>
    // (Postiz sends no auth header; see routes/webhooks.js). Secret not echoed.
    webhookPath: '/api/v1/webhooks/postiz/<POSTIZ_WEBHOOK_SECRET>',
  };
}

/* ----------------------------- channels ----------------------------- */

async function listChannels(organizationId) {
  return SocialChannel.find({ organizationId, status: { $in: ['connected', 'expired'] } }).sort({
    platform: 1,
    createdAt: 1,
  });
}

async function connectDemoChannel({ organizationId, platform, name, handle, actorId }) {
  if (!PLATFORM_KEYS.includes(platform))
    throw badRequest('validation_error', `Unsupported platform: ${platform}`);
  const cleanHandle = String(handle || '')
    .replace(/^@/, '')
    .trim();
  const existing = await SocialChannel.findOne({
    organizationId,
    platform,
    handle: cleanHandle,
    mode: 'demo',
  });
  if (existing) {
    existing.status = 'connected';
    if (name) existing.name = name;
    await existing.save();
    return existing;
  }
  return SocialChannel.create({
    organizationId,
    platform,
    name: name || (cleanHandle ? `@${cleanHandle}` : `${platformLabel(platform)} (demo)`),
    handle: cleanHandle,
    mode: 'demo',
    connectedBy: actorId || null,
  });
}

/** Postiz integrations available to link (only when Postiz is configured). */
async function listPostizIntegrations() {
  const integrations = await postizClient.listIntegrations();
  return integrations.map((i) => {
    const ident = i.providerIdentifier || i.identifier || '';
    const expired = Boolean(i.refreshNeeded || i.inBetweenSteps);
    return {
      id: i.id,
      name: i.name || ident,
      picture: i.picture || '',
      providerIdentifier: ident,
      platform: platformFromPostizIdentifier(ident),
      disabled: Boolean(i.disabled || expired),
    };
  });
}

/** Link every supported Postiz integration as a channel (idempotent). */
async function importPostizChannels({ organizationId, actorId }) {
  const integrations = await listPostizIntegrations();
  const out = [];
  for (const i of integrations) {
    if (!i.platform) continue;
    let ch = await SocialChannel.findOne({ organizationId, mode: 'postiz', externalId: i.id });
    if (!ch) {
      ch = new SocialChannel({
        organizationId,
        mode: 'postiz',
        externalId: i.id,
        connectedBy: actorId || null,
      });
    }
    ch.platform = i.platform;
    ch.name = i.name;
    ch.picture = i.picture;
    ch.postizIdentifier = i.providerIdentifier;
    ch.status = i.disabled ? 'expired' : 'connected';
    ch.statusReason = i.disabled ? 'This account is disabled in Postiz' : '';
    ch.lastCheckedAt = new Date();
    await ch.save();
    out.push(ch);
  }
  return out;
}

/** Default Postiz provider identifier per yv. platform for the OAuth connect. */
const CONNECT_IDENTIFIER = {
  instagram: 'instagram-standalone',
  youtube: 'youtube',
  linkedin: 'linkedin-page',
  x: 'x',
};

/**
 * Start connecting (or reconnecting) a channel.
 *  - Postiz mode: returns { mode: 'postiz', url } - the Postiz Connect Channel
 *    OAuth URL (GET /social/:identifier, ?refresh=<integrationId> to
 *    re-authorise an expired channel). The browser opens it; afterwards the
 *    client calls completeConnect() which imports the new integration.
 *  - Demo mode: simulates the OAuth round-trip and returns the connected
 *    demo channel straight away ({ mode: 'demo', simulated: true, channel }).
 */
async function startConnect({
  organizationId,
  platform,
  identifier,
  channelId,
  handle,
  name,
  actorId,
}) {
  let existing = null;
  if (channelId) {
    if (!isId(channelId)) throw notFound('channel_not_found', 'Channel not found');
    existing = await SocialChannel.findOne({ _id: channelId, organizationId });
    if (!existing) throw notFound('channel_not_found', 'Channel not found');
    platform = existing.platform;
  }
  if (!PLATFORM_KEYS.includes(platform))
    throw badRequest('validation_error', `Unsupported platform: ${platform}`);
  if (existing && existing.mode === 'postiz' && adapter.postizEnabled()) {
    const ident = existing.postizIdentifier || CONNECT_IDENTIFIER[platform];
    const url = await postizClient.getConnectUrl(ident, { refresh: existing.externalId });
    return { mode: 'postiz', url, reconnect: true, channelId: existing._id };
  }
  if (!existing && adapter.postizEnabled()) {
    const ident =
      identifier && POSTIZ_IDENTIFIERS[identifier] === platform
        ? identifier
        : CONNECT_IDENTIFIER[platform];
    const url = await postizClient.getConnectUrl(ident);
    return { mode: 'postiz', url, reconnect: false };
  }
  // demo: simulated OAuth
  if (existing) {
    existing.status = 'connected';
    existing.statusReason = '';
    existing.lastCheckedAt = new Date();
    await existing.save();
    return { mode: 'demo', simulated: true, reconnect: true, channel: existing };
  }
  const channel = await connectDemoChannel({ organizationId, platform, handle, name, actorId });
  return { mode: 'demo', simulated: true, reconnect: false, channel };
}

/** After the OAuth window closes: pull integrations from Postiz and refresh channel health. */
async function completeConnect({ organizationId, actorId }) {
  if (!adapter.postizEnabled())
    return { mode: 'demo', channels: await listChannels(organizationId) };
  await importPostizChannels({ organizationId, actorId });
  await refreshChannelHealth(organizationId);
  return { mode: 'postiz', channels: await listChannels(organizationId) };
}

/**
 * Mark Postiz-linked channels expired/connected from GET /integrations:
 * missing -> expired ("removed in Postiz"), disabled -> expired,
 * refreshNeeded/inBetweenSteps -> expired ("authorisation expired").
 */
async function refreshChannelHealth(organizationId) {
  if (!adapter.postizEnabled()) return { checked: 0, expired: 0 };
  const channels = await SocialChannel.find({
    organizationId,
    mode: 'postiz',
    status: { $in: ['connected', 'expired'] },
  });
  if (!channels.length) return { checked: 0, expired: 0 };
  const integrations = await postizClient.listIntegrations();
  const byId = new Map(integrations.map((i) => [String(i.id), i]));
  let expired = 0;
  for (const ch of channels) {
    const i = byId.get(String(ch.externalId));
    let reason = '';
    if (!i) reason = 'This account was removed from Postiz';
    else if (i.refreshNeeded || i.inBetweenSteps)
      reason = 'Authorisation expired - reconnect to keep publishing';
    else if (i.disabled) reason = 'This account is disabled in Postiz';
    ch.status = reason ? 'expired' : 'connected';
    ch.statusReason = reason;
    ch.lastCheckedAt = new Date();
    if (i && i.picture) ch.picture = i.picture;
    await ch.save();
    if (reason) expired += 1;
  }
  return { checked: channels.length, expired };
}

/** GET /is-connected + channel health, for the Channels page "Check connection". */
async function checkConnection(organizationId) {
  if (!adapter.postizEnabled())
    return { mode: 'demo', apiKeyValid: null, ...(await refreshChannelHealth(organizationId)) };
  const apiKeyValid = await postizClient.isConnected().catch(() => false);
  const health = apiKeyValid
    ? await refreshChannelHealth(organizationId)
    : { checked: 0, expired: 0 };
  return { mode: 'postiz', apiKeyValid, ...health };
}

async function disconnectChannel({ organizationId, channelId }) {
  if (!isId(channelId)) throw notFound('channel_not_found', 'Channel not found');
  const ch = await SocialChannel.findOne({ _id: channelId, organizationId });
  if (!ch) throw notFound('channel_not_found', 'Channel not found');
  const pending = await Publication.countDocuments({ channelId: ch._id, status: 'scheduled' });
  if (pending) {
    throw {
      status: 409,
      code: 'channel_has_scheduled_posts',
      message: `Cancel the ${pending} scheduled post(s) on this channel first`,
    };
  }
  ch.status = 'disconnected';
  await ch.save();
  return ch;
}

/* ------------------------- eligible projects ------------------------- */

/** Approved (or already scheduled) projects with their final asset files. */
async function listEligibleProjects(organizationId) {
  const projects = await Project.find({
    organizationId,
    status: { $in: SCHEDULABLE },
    approvedVersionId: { $ne: null },
  }).sort({
    approvedAt: -1,
    updatedAt: -1,
  });
  const versions = await ProjectVersion.find({
    _id: { $in: projects.map((p) => p.approvedVersionId) },
  });
  const byId = new Map(versions.map((v) => [String(v._id), v]));
  return projects.map((p) => {
    const v = byId.get(String(p.approvedVersionId));
    return {
      _id: p._id,
      title: p.title,
      description: p.description,
      status: p.status,
      scheduledAt: p.scheduledAt,
      approvedVersion: v
        ? {
            _id: v._id,
            versionNumber: v.versionNumber,
            label: `v${v.versionNumber}`,
            changeSummary: v.changeSummary,
            files: (v.files || []).map((f) => ({
              _id: f._id,
              filename: f.filename,
              mimeType: f.mimeType,
              size: f.size,
            })),
          }
        : null,
    };
  });
}

/* ------------------------------ posts ------------------------------ */

async function orgProjectIds(organizationId) {
  const projects = await Project.find({ organizationId }, { _id: 1 });
  return projects.map((p) => p._id);
}

async function hydrate(pubs) {
  const list = Array.isArray(pubs) ? pubs : [pubs];
  const projectIds = [...new Set(list.map((p) => String(p.projectId)))];
  const channelIds = [...new Set(list.filter((p) => p.channelId).map((p) => String(p.channelId)))];
  const versionIds = [...new Set(list.filter((p) => p.versionId).map((p) => String(p.versionId)))];
  const [projects, channels, versions] = await Promise.all([
    Project.find({ _id: { $in: projectIds } }, { title: 1, status: 1, publishProgress: 1 }),
    SocialChannel.find({ _id: { $in: channelIds } }),
    ProjectVersion.find({ _id: { $in: versionIds } }, { files: 1 }),
  ]);
  const pById = new Map(projects.map((p) => [String(p._id), p]));
  const cById = new Map(channels.map((c) => [String(c._id), c]));
  const fileMeta = new Map();
  for (const v of versions)
    for (const f of v.files || [])
      fileMeta.set(String(f._id), { _id: f._id, filename: f.filename, mimeType: f.mimeType });
  const out = list.map((pub) => {
    const o = pub.toObject ? pub.toObject() : pub;
    const project = pById.get(String(o.projectId));
    const channel = o.channelId ? cById.get(String(o.channelId)) : null;
    return {
      ...o,
      project: project
        ? {
            _id: project._id,
            title: project.title,
            status: project.status,
            publishProgress: project.publishProgress,
          }
        : null,
      file: o.fileId ? fileMeta.get(String(o.fileId)) || null : null,
      channel: channel
        ? {
            _id: channel._id,
            platform: channel.platform,
            name: channel.name,
            handle: channel.handle,
            mode: channel.mode,
          }
        : null,
    };
  });
  return Array.isArray(pubs) ? out : out[0];
}

/**
 * Calendar feed: publications of the org's projects whose scheduled or
 * published time falls in [from, to). Cancelled posts are hidden by default.
 */
async function listPosts({ organizationId, from, to, projectId, includeCancelled = false }) {
  // A projectId filter must still be one of THIS org's projects (ADR-0015).
  let ids = await orgProjectIds(organizationId);
  if (projectId) ids = ids.filter((id) => String(id) === String(projectId));
  const q = { projectId: { $in: ids } };
  if (!includeCancelled) q.status = { $ne: 'cancelled' };
  if (from || to) {
    const range = {};
    if (from) range.$gte = new Date(from);
    if (to) range.$lt = new Date(to);
    q.$or = [{ scheduledFor: range }, { scheduledFor: null, publishedAt: range }];
  }
  const pubs = await Publication.find(q).sort({ scheduledFor: 1, publishedAt: 1 }).limit(500);
  return hydrate(pubs);
}

async function loadOrgPublication(organizationId, publicationId) {
  if (!isId(publicationId)) throw notFound('publication_not_found', 'Post not found');
  const pub = await Publication.findById(publicationId);
  if (!pub) throw notFound('publication_not_found', 'Post not found');
  const project = await Project.findById(pub.projectId);
  if (!project || String(project.organizationId) !== String(organizationId)) {
    throw notFound('publication_not_found', 'Post not found');
  }
  return { pub, project };
}

/* -------------------------- project sync -------------------------- */

/**
 * Re-derive the project's lifecycle fields from its publications.
 *   every live post published      -> PUBLISHED, publishedAt = first publish
 *   some published, some pending   -> stays SCHEDULED ("Partially published n/m")
 *   any scheduled                  -> SCHEDULED (from APPROVED), scheduledAt = earliest pending
 *   none (after a cancel)          -> back to APPROVED, scheduledAt cleared
 * Failed posts count as pending: they need a retry, so they block PUBLISHED.
 */
async function syncProjectState(
  projectId,
  { actorId = null, publication = null, allowRevert = false } = {},
) {
  const project = await Project.findById(projectId);
  if (!project) return null;
  const pubs = await Publication.find({
    projectId,
    status: { $in: ['scheduled', 'published', 'failed'] },
  });
  const published = pubs.filter((p) => p.status === 'published');
  const scheduled = pubs.filter((p) => p.status === 'scheduled' && p.scheduledFor);
  const failed = pubs.filter((p) => p.status === 'failed');
  const before = project.status;
  const allDone = published.length > 0 && !scheduled.length && !failed.length;

  project.publishProgress = { published: published.length, total: pubs.length };
  if (published.length) {
    const first = published.reduce((a, b) =>
      new Date(a.publishedAt) <= new Date(b.publishedAt) ? a : b,
    );
    if (!project.publishedAt) project.publishedAt = first.publishedAt;
  }
  if (allDone) {
    if (SCHEDULABLE.includes(project.status)) project.status = 'PUBLISHED';
  } else if (published.length) {
    // partial: keep (or put) the project in SCHEDULED until the rest go live
    if (project.status === 'APPROVED') project.status = 'SCHEDULED';
  }
  if (scheduled.length) {
    project.scheduledAt = new Date(
      Math.min(...scheduled.map((p) => new Date(p.scheduledFor).getTime())),
    );
    if (project.status === 'APPROVED') project.status = 'SCHEDULED';
  } else if (!published.length && allowRevert && project.status === 'SCHEDULED' && !failed.length) {
    project.status = 'APPROVED';
    project.scheduledAt = null;
  }
  await project.save();

  if (before !== 'SCHEDULED' && project.status === 'SCHEDULED') {
    await bus.emitAsync('project.scheduled', {
      projectId: project._id,
      scheduledAt: project.scheduledAt,
      actorId,
    });
  }
  if (before !== 'PUBLISHED' && project.status === 'PUBLISHED') {
    await bus.emitAsync('project.published', {
      projectId: project._id,
      publication: publication || published[0],
      publishedBy: actorId,
    });
  }
  return project;
}

/* ---------------------------- schedule ---------------------------- */

async function schedulePost({
  organizationId,
  projectId,
  channelIds,
  caption,
  scheduledAt,
  fileId,
  settings,
  actorId,
}) {
  if (!isId(projectId)) throw notFound('project_not_found', 'Project not found');
  const project = await Project.findById(projectId);
  if (!project || String(project.organizationId) !== String(organizationId))
    throw notFound('project_not_found', 'Project not found');
  if (!project.approvedVersionId || !SCHEDULABLE.includes(project.status)) {
    throw badRequest('not_approved', 'Only Approved projects can be scheduled');
  }
  const when = new Date(scheduledAt);
  if (Number.isNaN(when.getTime()))
    throw badRequest('validation_error', 'scheduledAt is not a valid date');
  if (when.getTime() < Date.now() - 60000)
    throw badRequest('validation_error', 'Pick a time in the future');

  const ids = [...new Set((channelIds || []).map(String))];
  if (!ids.length || !ids.every(isId))
    throw badRequest('validation_error', 'Pick at least one channel');
  const channels = await SocialChannel.find({
    _id: { $in: ids },
    organizationId,
    status: { $in: ['connected', 'expired'] },
  });
  if (channels.length !== ids.length)
    throw badRequest('channel_not_found', 'One or more channels are not connected');
  const expiredCh = channels.find((c) => c.status === 'expired');
  if (expiredCh)
    throw {
      status: 409,
      code: 'channel_expired',
      message: `${expiredCh.name} needs to be reconnected before scheduling`,
    };

  const version = await ProjectVersion.findById(project.approvedVersionId);
  const files = (version && version.files) || [];
  const file = fileId ? files.find((f) => String(f._id) === String(fileId)) : files[0];
  if (fileId && !file)
    throw badRequest('validation_error', 'That file is not part of the approved version');

  // per-platform settings are validated before anything is created
  const validSettings = platformSettings.validateAll(
    channels.map((c) => c.platform),
    settings || {},
    { caption: caption || '', file, files, projectTitle: project.title },
  );

  const created = [];
  for (const channel of channels) {
    const provider = adapter.providerFor(channel);
    const pub = new Publication({
      projectId: project._id,
      organizationId,
      platform: platformLabel(channel.platform),
      channelId: channel._id,
      provider: provider.name,
      status: 'scheduled',
      caption: caption || '',
      scheduledFor: when,
      versionId: version ? version._id : null,
      fileId: file ? file._id : null,
      scheduledBy: actorId || null,
      publishedAt: null,
      settings: validSettings[channel.platform] || {},
    });
    try {
      const { externalPostId } = await provider.createPost({
        publication: pub,
        channel,
        project,
        version,
        file,
      });
      pub.externalPostId = externalPostId || '';
      pub.postId = externalPostId || '';
    } catch (err) {
      pub.status = 'failed';
      pub.failureReason = err.message || String(err);
      pub.failedAt = new Date();
    }
    await pub.save();
    created.push(pub);
  }

  const failed = created.filter((p) => p.status === 'failed');
  if (failed.length === created.length) {
    throw {
      status: 502,
      code: 'schedule_failed',
      message: failed[0].failureReason || 'Could not schedule the post',
    };
  }
  await syncProjectState(project._id, { actorId });
  return hydrate(created);
}

/* ------------------------- state transitions ------------------------- */

async function markPublished(
  pub,
  { postUrl = '', externalPostId = '', actorId = null, publishedAt = new Date() } = {},
) {
  if (pub.status === 'published' && (pub.postUrl || !postUrl)) return pub; // idempotent
  pub.status = 'published';
  pub.publishedAt = publishedAt;
  if (postUrl) pub.postUrl = postUrl;
  if (externalPostId) {
    pub.externalPostId = externalPostId;
    pub.postId = externalPostId;
  }
  pub.failureReason = '';
  if (actorId) pub.publishedBy = actorId;
  await pub.save();
  await syncProjectState(pub.projectId, { actorId, publication: pub });
  return pub;
}

async function markFailed(pub, reason) {
  pub.status = 'failed';
  pub.failureReason = reason || 'Publishing failed';
  pub.failedAt = new Date();
  await pub.save();
  await bus
    .emitAsync('publication.failed', {
      projectId: pub.projectId,
      publication: pub,
      reason: pub.failureReason,
    })
    .catch(() => {});
  await syncProjectState(pub.projectId, { allowRevert: true });
  return pub;
}

async function cancelPost({ organizationId, publicationId, actorId }) {
  const { pub } = await loadOrgPublication(organizationId, publicationId);
  if (!['scheduled', 'failed'].includes(pub.status)) {
    throw {
      status: 409,
      code: 'not_scheduled',
      message: 'Only scheduled or failed posts can be cancelled',
    };
  }
  await adapter
    .providerFor(pub)
    .cancelPost({ publication: pub })
    .catch((err) => {
      if (pub.status === 'scheduled') throw err;
    });
  pub.status = 'cancelled';
  await pub.save();
  await syncProjectState(pub.projectId, { actorId, allowRevert: true });
  return hydrate(pub);
}

async function reschedulePost({ organizationId, publicationId, scheduledAt, actorId }) {
  const { pub, project } = await loadOrgPublication(organizationId, publicationId);
  if (pub.status !== 'scheduled')
    throw { status: 409, code: 'not_scheduled', message: 'Only scheduled posts can be moved' };
  const when = new Date(scheduledAt);
  if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() - 60000)
    throw badRequest('validation_error', 'Pick a time in the future');
  const provider = adapter.providerFor(pub);
  if (provider.name === 'postiz') {
    const channel = await SocialChannel.findById(pub.channelId);
    const version = pub.versionId ? await ProjectVersion.findById(pub.versionId) : null;
    const file =
      version && pub.fileId
        ? (version.files || []).find((f) => String(f._id) === String(pub.fileId))
        : null;
    await provider.cancelPost({ publication: pub });
    pub.scheduledFor = when;
    const { externalPostId } = await provider.createPost({
      publication: pub,
      channel,
      project,
      version,
      file,
    });
    pub.externalPostId = externalPostId || '';
    pub.postId = externalPostId || '';
  } else {
    pub.scheduledFor = when;
  }
  await pub.save();
  await syncProjectState(pub.projectId, { actorId });
  return hydrate(pub);
}

async function publishNow({ organizationId, publicationId, actorId }) {
  const { pub, project } = await loadOrgPublication(organizationId, publicationId);
  if (!['scheduled', 'failed'].includes(pub.status))
    throw { status: 409, code: 'not_scheduled', message: 'This post is not waiting to publish' };
  const channel = pub.channelId ? await SocialChannel.findById(pub.channelId) : null;
  const provider = adapter.providerFor(pub);
  const version = pub.versionId ? await ProjectVersion.findById(pub.versionId) : null;
  const file =
    version && pub.fileId
      ? (version.files || []).find((f) => String(f._id) === String(pub.fileId))
      : null;
  const result = await provider.publish({ publication: pub, channel, project, version, file });
  if (result.pending) {
    // Postiz posts asynchronously; state arrives by webhook/poll.
    pub.status = 'scheduled';
    pub.scheduledFor = new Date();
    pub.externalPostId = result.externalPostId || pub.externalPostId;
    pub.failureReason = '';
    await pub.save();
    return hydrate(pub);
  }
  await markPublished(pub, {
    postUrl: result.postUrl,
    externalPostId: result.externalPostId,
    actorId,
  });
  await syncMetricsFor(pub).catch(() => {});
  return hydrate(await Publication.findById(pub._id));
}

/**
 * Retry a failed post. With `scheduledAt` it is re-queued for that time;
 * otherwise it goes out now (or at its original time if that is still ahead).
 */
async function retryPost({ organizationId, publicationId, scheduledAt, actorId }) {
  const { pub, project } = await loadOrgPublication(organizationId, publicationId);
  if (pub.status !== 'failed')
    throw { status: 409, code: 'not_failed', message: 'Only failed posts can be retried' };
  const channel = pub.channelId ? await SocialChannel.findById(pub.channelId) : null;
  if (!channel || channel.status === 'disconnected')
    throw badRequest('channel_not_found', 'The channel for this post is no longer connected');
  if (channel.status === 'expired')
    throw {
      status: 409,
      code: 'channel_expired',
      message: `${channel.name} needs to be reconnected first`,
    };
  let when = scheduledAt ? new Date(scheduledAt) : null;
  if (when && (Number.isNaN(when.getTime()) || when.getTime() < Date.now() - 60000))
    throw badRequest('validation_error', 'Pick a time in the future');
  if (!when) {
    const original = pub.scheduledFor ? new Date(pub.scheduledFor) : null;
    when = original && original.getTime() > Date.now() + 60000 ? original : new Date();
  }
  const provider = adapter.providerFor(pub);
  const version = pub.versionId ? await ProjectVersion.findById(pub.versionId) : null;
  const file =
    version && pub.fileId
      ? (version.files || []).find((f) => String(f._id) === String(pub.fileId))
      : null;
  pub.retryCount = (pub.retryCount || 0) + 1;
  pub.scheduledFor = when;
  pub.status = 'scheduled';
  pub.failureReason = '';
  pub.failedAt = null;
  try {
    if (provider.name === 'postiz') {
      await provider.cancelPost({ publication: pub }).catch(() => {});
      const now = when.getTime() <= Date.now() + 60000;
      const { externalPostId } = await provider.createPost({
        publication: pub,
        channel,
        project,
        version,
        file,
        type: now ? 'now' : 'schedule',
      });
      pub.externalPostId = externalPostId || '';
      pub.postId = externalPostId || '';
    }
  } catch (err) {
    pub.status = 'failed';
    pub.failureReason = err.message || String(err);
    pub.failedAt = new Date();
    await pub.save();
    throw {
      status: err.status && err.status < 500 ? err.status : 502,
      code: 'retry_failed',
      message: pub.failureReason,
    };
  }
  await pub.save();
  await syncProjectState(pub.projectId, { actorId });
  return hydrate(pub);
}

/** Manual fallback: someone posted by hand (or the provider is down) - record the live URL. */
async function markPublishedManually({ organizationId, publicationId, postUrl, actorId }) {
  const { pub } = await loadOrgPublication(organizationId, publicationId);
  if (!['scheduled', 'failed', 'published'].includes(pub.status)) {
    throw {
      status: 409,
      code: 'not_scheduled',
      message: 'Cancelled posts cannot be marked as published',
    };
  }
  if (pub.status === 'scheduled') {
    await adapter
      .providerFor(pub)
      .cancelPost({ publication: pub })
      .catch(() => {});
  }
  if (pub.status === 'published') {
    pub.postUrl = postUrl;
    await pub.save();
    return hydrate(pub);
  }
  pub.provider = 'manual';
  await markPublished(pub, { postUrl, actorId });
  return hydrate(pub);
}

/* ------------------------------ metrics ------------------------------ */

/** Pull this post's analytics now (series into PerformanceMetric, latest onto pub.metrics). */
async function syncMetricsFor(pub, now = new Date()) {
  if (pub.status !== 'published') return pub;
  const provider = adapter.providerFor(pub);
  if (provider.name !== 'local' && provider.name !== 'postiz') return pub;
  await require('./analytics.ingest').ingestPublication(pub, now);
  return pub;
}

async function syncMetrics({ organizationId, publicationId }) {
  const { pub } = await loadOrgPublication(organizationId, publicationId);
  if (pub.status !== 'published')
    throw {
      status: 409,
      code: 'not_published',
      message: 'Metrics are available once the post is live',
    };
  if (pub.provider === 'manual') {
    throw {
      status: 409,
      code: 'manual_post',
      message: 'This post was recorded by hand - add its metrics on the project',
    };
  }
  await syncMetricsFor(pub);
  return hydrate(pub);
}

/* --------------------------- scheduler tick --------------------------- */

/**
 * One scheduler pass:
 *  - local posts that are due are published
 *  - Postiz posts are polled (safety net when the webhook is not wired)
 *  - published posts get metrics refreshed at most every 10 minutes
 */
async function runDue(now = new Date()) {
  const summary = { published: 0, failed: 0, synced: 0 };
  const due = await Publication.find({
    status: 'scheduled',
    provider: 'local',
    scheduledFor: { $lte: now },
  }).limit(100);
  for (const pub of due) {
    try {
      const channel = pub.channelId ? await SocialChannel.findById(pub.channelId) : null;
      const result = await adapter.localProvider.publish({ publication: pub, channel });
      await markPublished(pub, {
        postUrl: result.postUrl,
        externalPostId: result.externalPostId,
        publishedAt: now,
      });
      await syncMetricsFor(pub, now);
      summary.published += 1;
    } catch (err) {
      await markFailed(pub, err.message || String(err));
      summary.failed += 1;
    }
  }

  if (adapter.postizEnabled()) {
    try {
      const r = await reconcilePostiz(now);
      summary.published += r.published;
      summary.failed += r.failed;
    } catch (err) {
      logger.warn({ err }, 'postiz reconcile failed; will retry next tick');
    }
  }

  return summary;
}

let lastFullReconcile = 0;

/**
 * Two-way sync with Postiz (safety net next to the webhook).
 *  - every tick: posts that are due (or overdue) are checked
 *  - every POSTIZ_RECONCILE_MS: every scheduled Postiz post is checked, and
 *    channel health refreshed (expired tokens -> "Reconnect")
 * A post can never silently stay "Scheduled": ERROR -> failed with the
 * platform's reason; deleted in Postiz -> failed; still queued long after its
 * time -> failed ("not confirmed"). Date changed in Postiz -> moved here too.
 */
async function reconcilePostiz(now = new Date(), { force = false } = {}) {
  const out = { published: 0, failed: 0, moved: 0 };
  const full = force || Date.now() - lastFullReconcile >= config.postiz.reconcileMs;
  const q = { status: 'scheduled', provider: 'postiz' };
  if (!full) q.scheduledFor = { $lte: new Date(now.getTime() + 60000) };
  const pending = await Publication.find(q).limit(500);
  if (full) lastFullReconcile = Date.now();
  if (pending.length) {
    const updates = await adapter.postizProvider.syncPublications(pending);
    const touched = new Set();
    for (const u of updates) {
      touched.add(String(u.publication._id));
      if (u.state === 'published') {
        await markPublished(u.publication, { postUrl: u.postUrl });
        out.published += 1;
      } else if (u.state === 'failed' || u.state === 'missing') {
        await markFailed(u.publication, u.error);
        out.failed += 1;
      } else if (u.state === 'moved') {
        u.publication.scheduledFor = u.scheduledFor;
        await u.publication.save();
        await syncProjectState(u.publication.projectId);
        out.moved += 1;
      }
    }
    const cutoff = now.getTime() - config.postiz.confirmTimeoutMin * 60000;
    for (const pub of pending) {
      if (touched.has(String(pub._id))) continue;
      if (pub.scheduledFor && new Date(pub.scheduledFor).getTime() < cutoff) {
        await markFailed(
          pub,
          `Postiz has not confirmed this post ${config.postiz.confirmTimeoutMin} minutes after its time - check the channel, then retry`,
        );
        out.failed += 1;
      }
    }
  }
  if (full) {
    const orgIds = await SocialChannel.distinct('organizationId', {
      mode: 'postiz',
      status: { $in: ['connected', 'expired'] },
    });
    for (const orgId of orgIds) {
      await refreshChannelHealth(orgId).catch((err) =>
        logger.warn({ err }, 'channel health check failed'),
      );
    }
  }
  return out;
}

/* ------------------------- suggest best time ------------------------- */

// Platform defaults (team-local time) used when there is no posting history yet.
const DEFAULT_SLOTS = {
  instagram: { weekday: null, hour: 19, why: 'Instagram evenings (7 pm) are typically strongest' },
  youtube: {
    weekday: null,
    hour: 17,
    why: 'YouTube uploads do best a few hours before evening viewing (5 pm)',
  },
  linkedin: { weekday: 2, hour: 9, why: 'LinkedIn posts land best on weekday mornings (Tue 9 am)' },
  x: { weekday: null, hour: 12, why: 'X engagement peaks around lunchtime (12 pm)' },
};

/** Best weekday/hour from the org's own published posts (engagement rate), or null. */
async function bestSlotFromHistory(organizationId, platforms) {
  const { localParts } = require('../utils/tz');
  const labels = platforms.map(platformLabel);
  const pubs = await Publication.find({
    organizationId,
    status: 'published',
    platform: { $in: labels },
    publishedAt: { $gte: new Date(Date.now() - 180 * 86400000) },
  }).limit(1000);
  const buckets = new Map();
  for (const p of pubs) {
    const m = p.metrics || {};
    if (!m.views) continue;
    const rate = ((m.likes || 0) + (m.comments || 0) + (m.shares || 0) + (m.saves || 0)) / m.views;
    const { weekday, hour } = localParts(p.publishedAt, config.timezone);
    const key = `${weekday}:${hour}`;
    const b = buckets.get(key) || { weekday, hour, n: 0, sum: 0 };
    b.n += 1;
    b.sum += rate;
    buckets.set(key, b);
  }
  const ranked = [...buckets.values()]
    .filter((b) => b.n >= 2)
    .sort((a, b) => b.sum / b.n - a.sum / a.n);
  return ranked[0] ? { ...ranked[0], rate: ranked[0].sum / ranked[0].n } : null;
}

/**
 * Suggest when to post to the given channels.
 *  Postiz channels: GET /find-slot/:integrationId each; the latest of the
 *    per-channel slots is the first time all of them are free.
 *  Demo channels: heuristic - the best weekday/hour from our own history
 *    (>= 2 posts in the bucket), else the platform default.
 */
async function suggestTime({ organizationId, channelIds, after }) {
  const { nextLocalSlot } = require('../utils/tz');
  const ids = [...new Set((channelIds || []).map(String))].filter(isId);
  if (!ids.length) throw badRequest('validation_error', 'Pick at least one channel');
  const channels = await SocialChannel.find({ _id: { $in: ids }, organizationId });
  if (!channels.length) throw badRequest('channel_not_found', 'Channel not found');
  const from = after ? new Date(after) : new Date(Date.now() + 30 * 60000);
  const perChannel = [];
  const postizChannels = adapter.postizEnabled()
    ? channels.filter((c) => c.mode === 'postiz' && c.externalId)
    : [];
  for (const ch of postizChannels) {
    const slot = await postizClient.findSlot(ch.externalId).catch(() => null);
    if (slot)
      perChannel.push({ channelId: ch._id, platform: ch.platform, at: slot, source: 'postiz' });
  }
  const others = channels.filter((c) => !postizChannels.includes(c));
  let reason = '';
  let source = postizChannels.length ? 'postiz' : 'heuristic';
  if (others.length) {
    const platforms = [...new Set(others.map((c) => c.platform))];
    const best = await bestSlotFromHistory(organizationId, platforms);
    let at;
    if (best) {
      at = nextLocalSlot({ weekday: best.weekday, hour: best.hour }, from, config.timezone);
      const { WEEKDAYS } = require('../utils/tz');
      reason = `Your ${platforms.map(platformLabel).join(' + ')} posts published ${WEEKDAYS[best.weekday]} around ${best.hour}:00 earned the best engagement (${(best.rate * 100).toFixed(1)}% over ${best.n} posts)`;
      source = postizChannels.length ? 'mixed' : 'history';
    } else {
      const d = DEFAULT_SLOTS[platforms[0]] || DEFAULT_SLOTS.instagram;
      at = nextLocalSlot({ weekday: d.weekday, hour: d.hour }, from, config.timezone);
      reason = d.why;
    }
    for (const ch of others)
      perChannel.push({
        channelId: ch._id,
        platform: ch.platform,
        at,
        source: best ? 'history' : 'heuristic',
      });
  }
  if (!reason && perChannel.length) reason = 'Next free slot in your Postiz posting schedule';
  const times = perChannel.map((p) => new Date(p.at).getTime()).filter(Number.isFinite);
  const suggestedAt = times.length
    ? new Date(Math.max(...times))
    : nextLocalSlot({ hour: 19 }, from, config.timezone);
  return { suggestedAt, source, reason, timezone: config.timezone, perChannel };
}

/* ------------------------------ webhook ------------------------------ */

/**
 * Postiz webhook (lenient about shape): a single object, an array, or
 * { posts | data: [...] }; each item carries the post id (id | postId |
 * post_id) and optionally the live URL (releaseURL | postUrl | url) and state.
 */
async function handlePostizWebhook(payload) {
  const items = Array.isArray(payload)
    ? payload
    : (payload && (payload.posts || payload.data)) || [payload];
  let updated = 0;
  for (const raw of items) {
    const item = raw && raw.post && typeof raw.post === 'object' ? { ...raw, ...raw.post } : raw;
    if (!item || typeof item !== 'object') continue;
    const id = String(item.postId || item.id || item.post_id || '');
    if (!id) continue;
    const pub = await Publication.findOne({ externalPostId: id, provider: 'postiz' });
    if (!pub) continue;
    const state = String(item.state || item.status || 'PUBLISHED').toUpperCase();
    if (state === 'ERROR' || state === 'FAILED') {
      if (pub.status !== 'failed') {
        await markFailed(pub, item.error || 'Postiz reported an error');
        updated += 1;
      }
      continue;
    }
    if (state !== 'PUBLISHED') continue;
    const postUrl = item.releaseURL || item.releaseUrl || item.postUrl || item.url || '';
    if (pub.status === 'published' && (pub.postUrl || !postUrl)) continue;
    await markPublished(pub, { postUrl });
    updated += 1;
  }
  return { updated };
}

module.exports = {
  getStatus,
  listChannels,
  connectDemoChannel,
  listPostizIntegrations,
  importPostizChannels,
  disconnectChannel,
  listEligibleProjects,
  listPosts,
  schedulePost,
  reschedulePost,
  cancelPost,
  publishNow,
  markPublishedManually,
  retryPost,
  startConnect,
  completeConnect,
  refreshChannelHealth,
  checkConnection,
  reconcilePostiz,
  suggestTime,
  syncMetrics,
  syncMetricsFor,
  syncProjectState,
  markPublished,
  markFailed,
  runDue,
  handlePostizWebhook,
};
