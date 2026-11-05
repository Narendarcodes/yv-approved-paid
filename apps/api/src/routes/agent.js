/**
 * Browser-facing agent API (mounted at /organizations). Permission checks live
 * HERE (Node only); the agent receives a service token scoped to the org.
 *   POST /:organizationId/agent/chat                 -> SSE proxy to the agent
 *   POST /:organizationId/agent/posts/:postId/analyze|transcribe|review-digest -> Redis Streams job
 *   POST /:organizationId/agent/brand/reindex
 *   GET  /:organizationId/agent/posts | insights | jobs/:jobId
 */
const express = require('express');
const { Readable } = require('stream');
const config = require('../config');
const { authenticate, requireOrg, requirePermission } = require('../middleware/auth');
const { mintServiceToken, READ_SCOPES } = require('../agent/serviceToken');
const streams = require('../agent/streams');
const { Post, Insight, AgentJob } = require('../models/agent');
const { latestMetrics, postDTO } = require('./internal');
const logger = require('../utils/logger');

const router = express.Router();
router.use('/:organizationId/agent', (req, res, next) =>
  config.agent.enabled ? next() : res.status(503).json({ error: { code: 'agent_disabled', message: 'Agent platform is not configured (set SERVICE_JWT_SECRET)' } })
);
const base = '/:organizationId/agent';
const view = [authenticate, requireOrg('organizationId'), requirePermission('project.view')];
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

/**
 * A short, readable error for a failed agent response. A proxy in front of the
 * agent (Render's 502/503 page while it cold-starts) answers with a whole HTML
 * document; the browser must never get that dumped into the chat.
 */
function agentErrorMessage(status, text) {
  const raw = String(text || '').trim();
  const code = status ? ` (HTTP ${status})` : '';
  if (/^<|<html|<!doctype|<body/i.test(raw)) {
    return status === 429
      ? `The agent is busy right now${code}. Try again in a moment.`
      : `The agent service is waking up or unavailable${code}. Try again in a minute.`;
  }
  try {
    const j = JSON.parse(raw);
    const m = (j && (j.error?.message || j.detail || j.message || (typeof j.error === 'string' && j.error))) || '';
    if (typeof m === 'string' && m.trim()) return m.trim().replace(/\s+/g, ' ').slice(0, 300);
  } catch {
    /* not JSON */
  }
  const plain = raw.replace(/\s+/g, ' ').slice(0, 300);
  return plain || `The agent service returned an error${code}.`;
}

router.post(
  `${base}/chat`,
  ...view,
  wrap(async (req, res) => {
    const message = String(req.body.message || '').trim();
    if (!message) return res.status(400).json({ error: { code: 'validation_error', message: 'message is required' } });
    if (message.length > 4000) return res.status(400).json({ error: { code: 'validation_error', message: 'message too long' } });
    const orgId = req.params.organizationId;
    const token = mintServiceToken({ orgId, userId: req.user._id, scopes: READ_SCOPES, ttlSec: config.agent.chatTokenTtlSec });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.agent.chatTimeoutMs);
    res.on('close', () => ac.abort());
    let upstream;
    try {
      upstream = await fetch(`${config.agent.url}/v1/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${token}` },
        body: JSON.stringify({ message, postId: req.body.postId || null, history: Array.isArray(req.body.history) ? req.body.history.slice(-6) : [] }),
        signal: ac.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      logger.warn({ err: err.message }, 'agent unreachable');
      return res.status(502).json({ error: { code: 'agent_unavailable', message: 'Agent service unavailable' } });
    }
    if (!upstream.ok || !upstream.body) {
      clearTimeout(timer);
      const text = await upstream.text().catch(() => '');
      return res
        .status(upstream.status === 429 ? 429 : 502)
        .json({ error: { code: 'agent_error', message: agentErrorMessage(upstream.status, text) } });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.flushHeaders?.();
    const body = Readable.fromWeb(upstream.body);
    body.on('error', () => res.end());
    body.on('end', () => clearTimeout(timer));
    body.pipe(res);
  })
);

function jobRoute(path, type, payloadFn) {
  router.post(
    `${base}${path}`,
    ...view,
    wrap(async (req, res) => {
      if (req.params.postId) {
        const post = await Post.findOne({ _id: req.params.postId, organizationId: req.params.organizationId }).select('_id').lean();
        if (!post) return res.status(404).json({ error: { code: 'post_not_found', message: 'Post not found' } });
      }
      const job = await streams.enqueue(type, { orgId: req.params.organizationId, userId: req.user._id, payload: payloadFn(req) });
      res.status(202).json({ data: job });
    })
  );
}
jobRoute('/posts/:postId/analyze', 'insights.analyze_post.v1', (req) => ({ postId: req.params.postId }));
jobRoute('/posts/:postId/transcribe', 'ingest.transcribe.v1', (req) => ({ postId: req.params.postId, language: req.body.language || 'auto' }));
jobRoute('/posts/:postId/review-digest', 'review.digest.v1', (req) => ({ postId: req.params.postId }));
jobRoute('/brand/reindex', 'brand.index.v1', () => ({}));

router.get(
  `${base}/posts`,
  ...view,
  wrap(async (req, res) => {
    const orgId = req.params.organizationId;
    const [posts, metrics] = await Promise.all([Post.find({ organizationId: orgId }).sort({ publishedAt: -1 }).lean(), latestMetrics(orgId)]);
    const byPost = {};
    for (const m of metrics) (byPost[m.postId] = byPost[m.postId] || {})[m.metric] = m.value;
    res.json({ data: posts.map((p) => ({ ...postDTO(p), metrics: byPost[String(p._id)] || {} })) });
  })
);

router.get(
  `${base}/insights`,
  ...view,
  wrap(async (req, res) => {
    const q = { organizationId: req.params.organizationId };
    if (req.query.postId) q.postId = req.query.postId;
    const items = await Insight.find(q).sort({ createdAt: -1 }).limit(50).lean();
    res.json({ data: items.map((i) => ({ ...i, id: String(i._id), postId: String(i.postId) })) });
  })
);

router.get(
  `${base}/jobs/:jobId`,
  ...view,
  wrap(async (req, res) => {
    const job = await AgentJob.findOne({ jobId: req.params.jobId, organizationId: req.params.organizationId }).lean();
    if (!job) return res.status(404).json({ error: { code: 'job_not_found', message: 'Job not found' } });
    res.json({ data: { jobId: job.jobId, type: job.type, status: job.status, result: job.result, error: job.error, attempts: job.attempts } });
  })
);

module.exports = router;
module.exports.agentErrorMessage = agentErrorMessage;
