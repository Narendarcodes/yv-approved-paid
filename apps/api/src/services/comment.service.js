const Comment = require('../models/comment.model');
const Project = require('../models/project.model');
const ProjectVersion = require('../models/projectVersion.model');
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

async function listComments({
  projectId,
  organizationId,
  versionId = null,
  limit = 200,
  skip = 0,
}) {
  await assertProject(projectId, organizationId);
  const q = { organizationId, projectId };
  if (versionId) q.versionId = versionId;
  return Comment.find(q)
    .sort({ createdAt: 1 })
    .skip(skip)
    .limit(limit)
    .populate('author', 'name email');
}

async function addComment({
  projectId,
  organizationId,
  versionId = null,
  parentId = null,
  author,
  body,
  timecode = null,
}) {
  await assertProject(projectId, organizationId);
  if (versionId) {
    const v = await ProjectVersion.findOne({ _id: versionId, organizationId, projectId });
    if (!v) throw { status: 404, code: 'version_not_found', message: 'Version not found' };
  }
  if (parentId) {
    const p = await Comment.findOne({ _id: parentId, organizationId, projectId });
    if (!p) throw { status: 404, code: 'parent_not_found', message: 'Parent comment not found' };
  }
  const comment = new Comment({
    organizationId,
    projectId,
    versionId,
    parentId,
    author,
    body,
    timecode,
  });
  await comment.save();
  await bus.emitAsync('comment.added', { projectId, comment, author });
  return comment;
}

async function resolveComment({ projectId, organizationId, commentId, resolved = true }) {
  await assertProject(projectId, organizationId);
  const comment = await Comment.findOne({ _id: commentId, organizationId, projectId });
  if (!comment) throw { status: 404, code: 'comment_not_found', message: 'Comment not found' };
  comment.resolved = resolved;
  await comment.save();
  return comment;
}

module.exports = { listComments, addComment, resolveComment };
