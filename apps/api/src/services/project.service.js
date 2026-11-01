const Project = require('../models/project.model');
const ProjectVersion = require('../models/projectVersion.model');
const Input = require('../models/input.model');
const bus = require('../events/hub');
const storage = require('../storage');
const { normalizeProject } = require('../utils/normalize');

const { allows } = require('../modules/access/index.cts');

/**
 * The project lifecycle: every edge `from -> to` and the permission it needs.
 * This table is the single source of truth for POST /projects/:id/transition
 * (see docs/adr/0019-workflow-permissions.md). The route itself only checks
 * membership; transitionProject() checks the edge's permission here.
 *
 *   permission               who may take the edge (modules/access permissions)
 *   approvesLatestVersion    taking the edge records approval of the newest
 *                            uploaded version, exactly like POST /:id/approve
 *   requiresApprovedVersion  refused until the project has an approved version
 *
 * Work-in-progress edges need project.transition (editors). Review, approval,
 * scheduling and publishing edges need the same permission as their dedicated
 * routes, so the generic endpoint can never be a way around them.
 */
const PERM = Object.freeze({
  work: 'project.transition',
  concept: 'concept.review',
  revise: 'project.revision',
  approve: 'project.approve',
  schedule: 'project.schedule',
  publish: 'project.publish',
});
const work = Object.freeze({ permission: PERM.work });
const approve = Object.freeze({ permission: PERM.approve, approvesLatestVersion: true });

const TRANSITIONS = Object.freeze({
  IDEA: { APPROVED_CONCEPT: { permission: PERM.concept }, ASSIGNED: work, CANCELLED: work },
  APPROVED_CONCEPT: { ASSIGNED: work, CANCELLED: work },
  ASSIGNED: { WAITING_FOR_INPUTS: work, IN_PROGRESS: work, CANCELLED: work },
  WAITING_FOR_INPUTS: { INPUTS_READY: work, CANCELLED: work },
  INPUTS_READY: { IN_PROGRESS: work, CANCELLED: work },
  IN_PROGRESS: { FIRST_DRAFT_SUBMITTED: work, CANCELLED: work },
  FIRST_DRAFT_SUBMITTED: { UNDER_REVIEW: work, REVISION_REQUESTED: { permission: PERM.revise } },
  UNDER_REVIEW: { REVISION_REQUESTED: { permission: PERM.revise }, APPROVED: approve },
  REVISION_REQUESTED: { REVISION_IN_PROGRESS: work },
  REVISION_IN_PROGRESS: { REVISION_SUBMITTED: work },
  REVISION_SUBMITTED: { UNDER_REVIEW: work, APPROVED: approve },
  APPROVED: { SCHEDULED: { permission: PERM.schedule, requiresApprovedVersion: true } },
  SCHEDULED: { PUBLISHED: { permission: PERM.publish, requiresApprovedVersion: true } },
  PUBLISHED: { CLOSED: work },
  CANCELLED: { CLOSED: work },
  CLOSED: {},
});

/** Legacy shape kept for callers that only need the targets: { from: [to, ...] }. */
const ALLOWED_TRANSITIONS = Object.freeze(
  Object.fromEntries(Object.entries(TRANSITIONS).map(([from, edges]) => [from, Object.keys(edges)])),
);

/** The rule for one edge, or null when the move is not in the lifecycle. */
function transitionRule(from, to) {
  const edges = TRANSITIONS[from];
  return (edges && Object.prototype.hasOwnProperty.call(edges, to) && edges[to]) || null;
}

const VALID_TYPES = ['concept', 'experiment', 'revision', 'production', 'content'];

async function getProject({ projectId, organizationId }) {
  const project = await Project.findOne({ _id: projectId, organizationId })
    .populate('creator', 'name email')
    .populate('assignee', 'name email');
  if (!project) throw { status: 404, code: 'project_not_found', message: 'Project not found' };
  const out = normalizeProject(project);
  // Human label of the locked version (e.g. "v3") for the project header.
  if (project.approvedVersionId) {
    const v = await ProjectVersion.findOne({
      _id: project.approvedVersionId,
      organizationId,
    }).select('versionNumber');
    if (v) out.approvedVersion = `v${v.versionNumber}`;
  }
  return out;
}

async function listProjects({
  organizationId,
  status,
  assignee,
  search,
  limit = 50,
  skip = 0,
  sort = '-createdAt',
}) {
  const q = { organizationId };
  if (status) q.status = status;
  if (assignee) q.assignee = assignee;
  if (search) q.title = { $regex: search, $options: 'i' };
  const [items, total] = await Promise.all([
    Project.find(q)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate('creator', 'name email')
      .populate('assignee', 'name email'),
    Project.countDocuments(q),
  ]);
  return { items: items.map(normalizeProject), total, limit, skip };
}

async function createProject({
  organizationId,
  title,
  description,
  creatorId,
  type = 'content',
  client = '',
  campaign = '',
  conceptId = null,
}) {
  if (!VALID_TYPES.includes(type)) {
    throw {
      status: 400,
      code: 'invalid_type',
      message: `Project type must be one of: ${VALID_TYPES.join(', ')}`,
    };
  }
  const project = new Project({
    organizationId,
    title,
    description,
    creator: creatorId,
    type,
    client,
    campaign,
    conceptId,
  });
  await project.save();
  await bus.emitAsync('project.created', { projectId: project._id, actorId: creatorId, project });
  return project;
}

/**
 * Move a project along one edge of TRANSITIONS. `permissions` are the caller's
 * permissions in the project's org (req.ctx.permissions); they are required so
 * no caller can skip the edge check by accident.
 */
async function transitionProject({ projectId, organizationId, newStatus, actorId, permissions }) {
  if (!Array.isArray(permissions)) {
    throw { status: 500, code: 'access_unresolved', message: 'Caller permissions are required' };
  }
  const project = await Project.findOne({ _id: projectId, organizationId });
  if (!project) throw { status: 404, code: 'project_not_found', message: 'Project not found' };
  const rule = transitionRule(project.status, newStatus);
  if (!rule) {
    throw {
      status: 400,
      code: 'invalid_transition',
      message: `Cannot transition from ${project.status} to ${newStatus}`,
    };
  }
  if (!allows(permissions, rule.permission)) {
    throw {
      status: 403,
      code: 'forbidden',
      message: `Moving a project to ${newStatus} needs the ${rule.permission} permission`,
    };
  }
  if (rule.approvesLatestVersion) {
    // Same operation as POST /:id/approve, on the newest uploaded version.
    const latest = await ProjectVersion.findOne({ organizationId, projectId })
      .sort({ versionNumber: -1 })
      .select('_id');
    if (!latest) {
      throw {
        status: 400,
        code: 'no_version',
        message: 'Upload a version before approving the project',
      };
    }
    return approveVersion({ projectId, organizationId, versionId: latest._id, approverId: actorId });
  }
  if (rule.requiresApprovedVersion) {
    const approved =
      project.approvedVersionId &&
      (await ProjectVersion.exists({ _id: project.approvedVersionId, organizationId, projectId }));
    if (!approved) {
      throw {
        status: 400,
        code: 'not_approved',
        message: `Cannot move a project to ${newStatus} without an approved version`,
      };
    }
  }
  const from = project.status;
  project.status = newStatus;
  await project.save();
  await bus.emitAsync('project.transitioned', { projectId, from, to: newStatus, actorId });
  return project;
}

async function assignProject({ projectId, organizationId, assigneeId, actorId }) {
  const project = await Project.findOne({ _id: projectId, organizationId });
  if (!project) throw { status: 404, code: 'project_not_found', message: 'Project not found' };
  project.assignee = assigneeId;
  project.assignedAt = new Date();
  if (project.status === 'IDEA' || project.status === 'APPROVED_CONCEPT') {
    project.status = 'ASSIGNED';
  }
  await project.save();
  await bus.emitAsync('project.assigned', { projectId, assigneeId, actorId });
  return project;
}

async function getVersions({ projectId, organizationId, limit = 100, skip = 0 }) {
  await getProject({ projectId, organizationId });
  const [items, total] = await Promise.all([
    ProjectVersion.find({ organizationId, projectId })
      .sort({ versionNumber: -1 })
      .skip(skip)
      .limit(limit)
      .populate('uploader', 'name email'),
    ProjectVersion.countDocuments({ organizationId, projectId }),
  ]);
  return { items, total, limit, skip };
}

async function addVersion({
  projectId,
  organizationId,
  uploaderId,
  metadata = {},
  changeSummary = '',
  files = [],
}) {
  await getProject({ projectId, organizationId });
  const last = await ProjectVersion.findOne({ organizationId, projectId })
    .sort({ versionNumber: -1 })
    .limit(1);
  const next = last ? last.versionNumber + 1 : 1;
  const pv = new ProjectVersion({
    organizationId,
    projectId,
    versionNumber: next,
    uploader: uploaderId,
    metadata,
    changeSummary,
    files,
  });
  await pv.save();

  const project = await Project.findOne({ _id: projectId, organizationId });
  if (project) {
    const before = project.status;
    if (project.status === 'IN_PROGRESS') {
      project.status = 'FIRST_DRAFT_SUBMITTED';
    } else if (project.status === 'REVISION_IN_PROGRESS') {
      project.status = 'REVISION_SUBMITTED';
    }
    if (project.status !== before) await project.save();
  }

  await bus.emitAsync('version.uploaded', { projectId, version: pv, uploaderId });
  return pv;
}

async function approveVersion({ projectId, organizationId, versionId, approverId }) {
  const project = await Project.findOne({ _id: projectId, organizationId });
  if (!project) throw { status: 404, code: 'project_not_found', message: 'Project not found' };
  const version = await ProjectVersion.findOne({ _id: versionId, organizationId, projectId });
  if (!version) throw { status: 404, code: 'version_not_found', message: 'Version not found' };
  project.approvedVersionId = version._id;
  project.approvedBy = approverId;
  project.approvedAt = new Date();
  project.status = 'APPROVED';
  await project.save();
  await bus.emitAsync('project.approved', { projectId, versionId, approverId });
  return project;
}

async function checkInputsReady(projectId) {
  const project = await Project.findById(projectId);
  if (!project) return;
  const [requested, total] = await Promise.all([
    Input.countDocuments({ projectId, state: { $ne: 'received' } }),
    Input.countDocuments({ projectId }),
  ]);
  if (total > 0 && requested === 0) {
    if (project.status === 'WAITING_FOR_INPUTS') {
      project.status = 'INPUTS_READY';
      await project.save();
      await bus.emitAsync('project.transitioned', {
        projectId,
        from: 'WAITING_FOR_INPUTS',
        to: 'INPUTS_READY',
        actorId: null,
      });
    }
  }
}

async function saveVersionFile({
  projectId,
  organizationId,
  versionId,
  fileBuffer,
  filename,
  mimeType,
  uploaderId,
}) {
  if (!organizationId)
    throw { status: 500, code: 'missing_tenant', message: 'organizationId is required' };
  const version = await ProjectVersion.findOne({ _id: versionId, organizationId, projectId });
  if (!version) throw { status: 404, code: 'version_not_found', message: 'Version not found' };
  const { storageRef, size } = await storage.saveFile(fileBuffer, { filename, mimeType });
  version.files.push({ filename, mimeType, size, storageRef, uploadedBy: uploaderId });
  await version.save();
  return version;
}

module.exports = {
  TRANSITIONS,
  ALLOWED_TRANSITIONS,
  transitionRule,
  VALID_TYPES,
  getProject,
  listProjects,
  createProject,
  transitionProject,
  assignProject,
  getVersions,
  addVersion,
  approveVersion,
  checkInputsReady,
  saveVersionFile,
};
