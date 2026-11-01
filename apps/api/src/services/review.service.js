const Project = require('../models/project.model');
const ProjectVersion = require('../models/projectVersion.model');
const Comment = require('../models/comment.model');
const RevisionRequest = require('../models/revisionRequest.model');
const bus = require('../events/hub');

// Tenant scope (ADR-0015): the project must belong to the caller's org. The
// route already resolved organizationId from the project (modules/access);
// this is the data-seam check so a service is safe on its own too.
async function assertProject(projectId, organizationId) {
  if (!organizationId)
    throw { status: 500, code: 'missing_tenant', message: 'organizationId is required' };
  const project = await Project.findOne({ _id: projectId, organizationId });
  if (!project) throw { status: 404, code: 'project_not_found', message: 'Project not found' };
  return project;
}

async function assertVersion(projectId, organizationId, versionId) {
  const v = await ProjectVersion.findOne({ _id: versionId, organizationId, projectId });
  if (!v) throw { status: 404, code: 'version_not_found', message: 'Version not found' };
  return v;
}

async function nextRevisionNumber(projectId) {
  const last = await RevisionRequest.findOne({ projectId }).sort({ revisionNumber: -1 });
  return last ? last.revisionNumber + 1 : 1;
}

/**
 * Summarize review feedback for a version — groups unresolved comments by
 * author and renders an action-oriented summary. Deterministic, rule-based;
 * designed to be swapped for an LLM summarizer later without changing the API.
 */
async function summarizeReview({ projectId, organizationId, versionId = null }) {
  await assertProject(projectId, organizationId);
  const q = { organizationId, projectId, resolved: false };
  if (versionId) {
    await assertVersion(projectId, organizationId, versionId);
    q.versionId = versionId;
  }
  const comments = await Comment.find(q).sort({ createdAt: 1 }).populate('author', 'name email');

  const byVersion = {};
  for (const c of comments) {
    const key = c.versionId ? c.versionId.toString() : 'general';
    if (!byVersion[key]) byVersion[key] = [];
    byVersion[key].push(c);
  }

  const sections = Object.keys(byVersion)
    .sort()
    .map((key) => ({
      versionId: key === 'general' ? null : key,
      commentCount: byVersion[key].length,
      comments: byVersion[key].map((c) => ({
        commentId: c._id,
        author: c.author ? { id: c.author._id, name: c.author.name } : null,
        body: c.body,
        createdAt: c.createdAt,
      })),
    }));

  const total = comments.length;
  const actionItems = [];
  for (const c of comments) {
    const t = (c.body || '').toLowerCase();
    if (
      /(please|can you|can we|could you|need to|should|fix|change|update|replace|add|remove|keep|swap|tighten|cool|make sure|hold)/.test(
        t,
      )
    ) {
      actionItems.push({
        commentId: c._id,
        versionId: c.versionId,
        body: c.body,
        requestedBy: c.author ? c.author.name : null,
      });
    }
  }

  return {
    projectId,
    versionId: versionId || null,
    totalComments: total,
    unresolvedComments: total,
    actionItems,
    sections,
    generatedBy: 'rule-based-summarizer', // swap for an LLM integration later
  };
}

/**
 * Lock review feedback for a version — Fluit's "lock feedback" step.
 * Converts unresolved comments into the scope of the next revision request
 * and marks the comments as resolved (locked into the scope).
 */
async function lockReview({ projectId, organizationId, versionId, actorId }) {
  const project = await assertProject(projectId, organizationId);
  await assertVersion(projectId, organizationId, versionId);

  const comments = await Comment.find({
    organizationId,
    projectId,
    versionId,
    resolved: false,
  }).sort({ createdAt: 1 });
  if (comments.length === 0) {
    throw {
      status: 400,
      code: 'no_feedback',
      message: 'No unresolved feedback to lock for this version',
    };
  }

  const scopeItems = comments.map((c) => ({ commentId: c._id, author: c.author, body: c.body }));
  const summary = await summarizeReview({ projectId, organizationId, versionId });
  const reason =
    `Review locked on version ${versionId}. ${summary.totalComments} feedback item(s) converted into revision scope.` +
    (summary.actionItems.length
      ? ` Action items: ${summary.actionItems.map((a) => `"${a.body}"`).join('; ')}`
      : '');

  const revision = new RevisionRequest({
    organizationId,
    projectId,
    revisionNumber: await nextRevisionNumber(projectId),
    reason,
    sourceVersionId: versionId,
    requester: actorId,
    status: 'requested',
    source: 'review_lock',
    scopeItems,
  });
  await revision.save();

  // Lock the comments into the scope
  await Comment.updateMany(
    { organizationId, _id: { $in: comments.map((c) => c._id) } },
    { $set: { resolved: true } },
  );

  // Locking feedback is a revision request: move the project into
  // "Revision requested" the same way requestRevision() does.
  project.revisionCount = (project.revisionCount || 0) + 1;
  const from = project.status;
  if (['FIRST_DRAFT_SUBMITTED', 'UNDER_REVIEW', 'REVISION_SUBMITTED'].includes(project.status)) {
    project.status = 'REVISION_REQUESTED';
  }
  await project.save();
  if (from !== project.status) {
    await bus.emitAsync('project.transitioned', { projectId, from, to: project.status, actorId });
  }

  await bus.emitAsync('review.locked', { projectId, versionId, revision, actorId, scopeItems });
  return { revision, lockedCommentCount: scopeItems.length, scopeItems };
}

module.exports = { summarizeReview, lockReview };
