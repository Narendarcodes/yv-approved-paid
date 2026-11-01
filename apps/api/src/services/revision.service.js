const RevisionRequest = require('../models/revisionRequest.model');
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

async function nextRevisionNumber(projectId) {
  // revisionNumber is unique per project ({projectId, revisionNumber}); the
  // caller already proved the project is in its org.
  const last = await RevisionRequest.findOne({ projectId }).sort({ revisionNumber: -1 }).limit(1);
  return last ? last.revisionNumber + 1 : 1;
}

async function listRevisions({ projectId, organizationId, limit = 100, skip = 0 }) {
  await assertProject(projectId, organizationId);
  const [items, total] = await Promise.all([
    RevisionRequest.find({ organizationId, projectId })
      .sort({ revisionNumber: -1 })
      .skip(skip)
      .limit(limit),
    RevisionRequest.countDocuments({ organizationId, projectId }),
  ]);
  return { items, total, limit, skip };
}

async function requestRevision({
  projectId,
  organizationId,
  sourceVersionId = null,
  reason,
  requester,
}) {
  const project = await assertProject(projectId, organizationId);
  if (sourceVersionId) {
    const v = await ProjectVersion.findOne({ _id: sourceVersionId, organizationId, projectId });
    if (!v) throw { status: 404, code: 'version_not_found', message: 'Source version not found' };
  }
  const revisionNumber = await nextRevisionNumber(projectId);
  const rr = new RevisionRequest({
    organizationId,
    projectId,
    revisionNumber,
    sourceVersionId,
    reason,
    requester,
    status: 'requested',
  });
  await rr.save();

  // Always count the revision, even when the status doesn't change
  // (previously the save only happened inside the status branch, so the
  // increment was lost for projects outside a reviewable state).
  project.revisionCount = (project.revisionCount || 0) + 1;
  // Only move to REVISION_REQUESTED if currently in a reviewable state
  if (['FIRST_DRAFT_SUBMITTED', 'UNDER_REVIEW', 'REVISION_SUBMITTED'].includes(project.status)) {
    project.status = 'REVISION_REQUESTED';
  }
  await project.save();
  await bus.emitAsync('revision.requested', { projectId, revision: rr, requester });
  return rr;
}

async function updateRevision({
  revisionId,
  projectId,
  organizationId,
  status,
  submitter = null,
  resolvedVersionId = null,
}) {
  const project = await assertProject(projectId, organizationId);
  const rr = await RevisionRequest.findOne({ _id: revisionId, organizationId, projectId });
  if (!rr) throw { status: 404, code: 'revision_not_found', message: 'Revision request not found' };

  if (status === 'in_progress') {
    rr.status = 'in_progress';
    if (project && ['REVISION_REQUESTED'].includes(project.status)) {
      project.status = 'REVISION_IN_PROGRESS';
      await project.save();
    }
  } else if (status === 'submitted') {
    rr.status = 'submitted';
    rr.submitter = submitter;
    rr.submittedAt = new Date();
    if (resolvedVersionId) rr.resolvedVersionId = resolvedVersionId;
    if (project && ['REVISION_IN_PROGRESS'].includes(project.status)) {
      project.status = 'REVISION_SUBMITTED';
      await project.save();
    }
  } else if (status === 'resolved') {
    rr.status = 'resolved';
    rr.resolvedAt = new Date();
    if (resolvedVersionId) rr.resolvedVersionId = resolvedVersionId;
  } else {
    throw { status: 400, code: 'invalid_revision_status', message: 'Invalid revision status' };
  }

  await rr.save();
  await bus.emitAsync('revision.updated', { projectId, revision: rr, status, submitter });
  return rr;
}

module.exports = { listRevisions, requestRevision, updateRevision };
