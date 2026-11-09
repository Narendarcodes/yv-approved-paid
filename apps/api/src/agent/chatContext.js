/**
 * The org data Node pushes WITH each Brand Brain chat call (POST /v1/chat `context`).
 *
 * The deployed agent is the lean deals service on its own Render instance: it cannot reach
 * Node's private /internal listener (loopback only), so instead of calling back it reads this
 * bundle. Built here, after the route's permission checks, for the caller's org only, and
 * bounded so one chat stays a small request. Retention curves and transcripts are not sent.
 * The full agent (app.main) ignores the field and keeps reading through /internal.
 */
const { Post, BrandRule, ReviewComment } = require('../models/agent');
const { latestMetrics, postDTO } = require('../routes/internal');

const LIMITS = { brandRules: 200, posts: 50, reviewComments: 300 };

async function buildChatContext(orgId) {
  const [rules, posts] = await Promise.all([
    BrandRule.find({ organizationId: orgId }).sort({ createdAt: 1 }).limit(LIMITS.brandRules).lean(),
    Post.find({ organizationId: orgId }).sort({ publishedAt: -1 }).limit(LIMITS.posts).lean(),
  ]);
  const postIds = posts.map((p) => p._id);
  const ids = new Set(postIds.map(String));
  const [metrics, comments] = await Promise.all([
    postIds.length ? latestMetrics(orgId) : [],
    postIds.length
      ? ReviewComment.find({ organizationId: orgId, postId: { $in: postIds } })
          .sort({ createdAt: -1 })
          .limit(LIMITS.reviewComments)
          .lean()
      : [],
  ]);
  return {
    brandRules: rules.map((r) => ({
      id: String(r._id),
      title: r.title,
      body: r.body,
      kind: r.kind,
      sourceUrl: r.sourceUrl || undefined,
    })),
    posts: posts.map(postDTO),
    metrics: metrics.filter((m) => ids.has(m.postId)),
    reviewComments: comments.reverse().map((c) => ({
      id: String(c._id),
      postId: String(c.postId),
      author: c.author,
      role: c.role,
      body: c.body,
      timecodeSec: c.timecodeSec ?? undefined,
      createdAt: c.createdAt ? new Date(c.createdAt).toISOString() : undefined,
    })),
  };
}

module.exports = { buildChatContext, LIMITS };
