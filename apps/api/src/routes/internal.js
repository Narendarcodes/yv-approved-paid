/**
 * /internal/* - private API for the Python agent + worker
 * (contracts/openapi/internal.yaml). Auth = service JWT minted by Node.
 * orgId ALWAYS comes from the token (req.svc.orgId), never from the request.
 * Block /internal at the public ingress in production; it is for the private network.
 */
const express = require('express');
const mongoose = require('mongoose');
const { requireService } = require('../middleware/serviceAuth');
const {
  Post,
  Asset,
  BrandRule,
  Metric,
  RetentionPoint,
  Insight,
  ReviewComment,
  AgentJob,
} = require('../models/agent');
const { validate } = require('../agent/contracts');
const { emitToOrg } = require('../realtime/socket');

const router = express.Router();
router.use((req, res, next) =>
  require('../config').agent.enabled
    ? next()
    : res
        .status(503)
        .json({ error: { code: 'agent_disabled', message: 'Agent platform disabled' } }),
);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const isOid = (v) => mongoose.isValidObjectId(v) && String(v).length === 24;

const postDTO = (p) => ({
  id: String(p._id),
  orgId: String(p.organizationId),
  platform: p.platform,
  externalId: p.externalId || undefined,
  title: p.title,
  caption: p.caption || '',
  format: p.format || '',
  durationSec: p.durationSec || 0,
  publishedAt: p.publishedAt ? new Date(p.publishedAt).toISOString() : undefined,
  tags: p.tags || [],
  source: p.source || 'manual',
});

async function ownPost(req, res) {
  const id = req.params.postId || req.query.postId || req.body.postId;
  if (!isOid(id)) {
    res.status(400).json({ error: { code: 'invalid_id', message: 'postId required' } });
    return null;
  }
  const post = await Post.findOne({ _id: id, organizationId: req.svc.orgId }).lean();
  if (!post)
    res
      .status(404)
      .json({ error: { code: 'post_not_found', message: 'Post not found in this organization' } });
  return post;
}

/** Latest cumulative value per (post, metric) for the org, optionally one post. */
async function latestMetrics(orgId, postId) {
  const match = { 'meta.organizationId': oid(orgId) };
  if (postId) match['meta.postId'] = oid(postId);
  const rows = await Metric.aggregate([
    { $match: match },
    { $sort: { ts: -1 } },
    {
      $group: {
        _id: { postId: '$meta.postId', metric: '$meta.metric' },
        value: { $first: '$value' },
        ts: { $first: '$ts' },
        source: { $first: '$meta.source' },
      },
    },
    { $sort: { '_id.postId': 1, '_id.metric': 1 } },
  ]);
  return rows.map((r) => ({
    postId: String(r._id.postId),
    metric: r._id.metric,
    value: r.value,
    ts: r.ts.toISOString(),
    source: r.source,
  }));
}

router.get('/whoami', requireService(), (req, res) => res.json({ data: req.svc }));

router.get(
  '/posts',
  requireService('posts:read'),
  wrap(async (req, res) => {
    const q = { organizationId: req.svc.orgId };
    if (req.query.platform) q.platform = String(req.query.platform);
    const posts = await Post.find(q).sort({ publishedAt: -1 }).lean();
    res.json({ data: posts.map(postDTO) });
  }),
);

router.get(
  '/metrics',
  requireService('metrics:read'),
  wrap(async (req, res) => {
    if (req.query.postId && !(await ownPost(req, res))) return;
    res.json({ data: await latestMetrics(req.svc.orgId, req.query.postId) });
  }),
);

router.get(
  '/posts/:postId/retention',
  requireService('metrics:read'),
  wrap(async (req, res) => {
    const post = await ownPost(req, res);
    if (!post) return;
    const pts = await RetentionPoint.find({ organizationId: req.svc.orgId, postId: post._id })
      .sort({ second: 1 })
      .lean();
    res.json({
      data: pts.map((p) => ({
        postId: String(p.postId),
        second: p.second,
        audienceWatchRatio: p.audienceWatchRatio,
        relativeRetentionPerformance: p.relativeRetentionPerformance ?? undefined,
      })),
    });
  }),
);

router.get(
  '/posts/:postId/media',
  requireService('posts:read'),
  wrap(async (req, res) => {
    const post = await ownPost(req, res);
    if (!post) return;
    const a = await Asset.findOne({
      organizationId: req.svc.orgId,
      postId: post._id,
      kind: { $in: ['video', 'audio'] },
    }).lean();
    res.json({
      data: a
        ? {
            assetId: String(a._id),
            storageKey: a.storageKey,
            transcript: a.transcript || [],
            transcriptEngine: a.transcriptEngine || '',
            sceneCuts: a.sceneCuts || [],
          }
        : null,
    });
  }),
);

router.put(
  '/posts/:postId/media',
  requireService('assets:write'),
  wrap(async (req, res) => {
    const post = await ownPost(req, res);
    if (!post) return;
    const set = {};
    if (Array.isArray(req.body.transcript)) {
      for (const seg of req.body.transcript) {
        const v = validate('TranscriptSegment', seg);
        if (!v.ok)
          return res
            .status(400)
            .json({ error: { code: 'contract_violation', message: v.errors.join('; ') } });
      }
      set.transcript = req.body.transcript;
      set.transcriptEngine = String(req.body.transcriptEngine || '');
    }
    if (Array.isArray(req.body.sceneCuts)) set.sceneCuts = req.body.sceneCuts;
    const a = await Asset.findOneAndUpdate(
      { organizationId: req.svc.orgId, postId: post._id, kind: { $in: ['video', 'audio'] } },
      { $set: set },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    res.json({
      data: {
        assetId: String(a._id),
        segments: (a.transcript || []).length,
        sceneCuts: (a.sceneCuts || []).length,
      },
    });
  }),
);

router.get(
  '/brand/rules',
  requireService('brand:read'),
  wrap(async (req, res) => {
    const rules = await BrandRule.find({ organizationId: req.svc.orgId })
      .sort({ createdAt: 1 })
      .lean();
    res.json({
      data: rules.map((r) => ({
        id: String(r._id),
        title: r.title,
        body: r.body,
        kind: r.kind,
        sourceUrl: r.sourceUrl || undefined,
      })),
    });
  }),
);

router.get(
  '/review-comments',
  requireService('reviews:read'),
  wrap(async (req, res) => {
    const post = await ownPost(req, res);
    if (!post) return;
    const cs = await ReviewComment.find({ organizationId: req.svc.orgId, postId: post._id })
      .sort({ createdAt: 1 })
      .lean();
    res.json({
      data: cs.map((c) => ({
        id: String(c._id),
        postId: String(c.postId),
        author: c.author,
        role: c.role,
        body: c.body,
        timecodeSec: c.timecodeSec ?? undefined,
        createdAt: c.createdAt.toISOString(),
      })),
    });
  }),
);

router.post(
  '/insights',
  requireService('insights:write'),
  wrap(async (req, res) => {
    const v = validate('Insight', req.body);
    if (!v.ok)
      return res
        .status(400)
        .json({ error: { code: 'contract_violation', message: v.errors.join('; ') } });
    const post = await ownPost(req, res);
    if (!post) return;
    const doc = await Insight.create({
      ...req.body,
      organizationId: req.svc.orgId,
      postId: post._id,
    });
    emitToOrg(req.svc.orgId, 'insight:new', {
      id: String(doc._id),
      postId: String(post._id),
      kind: doc.kind,
      summary: doc.summary,
    });
    res.status(201).json({ data: { id: String(doc._id) } });
  }),
);

router.post(
  '/jobs/:jobId/result',
  requireService('jobs:write'),
  wrap(async (req, res) => {
    const body = { ...req.body, jobId: req.params.jobId };
    const v = validate('JobResult', body);
    if (!v.ok)
      return res
        .status(400)
        .json({ error: { code: 'contract_violation', message: v.errors.join('; ') } });
    const job = await AgentJob.findOne({ jobId: req.params.jobId, organizationId: req.svc.orgId });
    if (!job)
      return res.status(404).json({ error: { code: 'job_not_found', message: 'Job not found' } });
    job.status = body.status;
    job.result = body.result || null;
    job.error = body.error || '';
    job.attempts = body.attempts || job.attempts;
    await job.save();
    emitToOrg(req.svc.orgId, 'job:update', {
      jobId: job.jobId,
      type: job.type,
      status: job.status,
      result: job.result,
      error: job.error,
    });
    res.json({ data: { ok: true } });
  }),
);

module.exports = router;
module.exports.latestMetrics = latestMetrics;
module.exports.postDTO = postDTO;
