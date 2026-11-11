const Project = require('../models/project.model');
const ProjectVersion = require('../models/projectVersion.model');
const Input = require('../models/input.model');
const bus = require('../events/hub');
const storage = require('../storage');
const { normalizeProject } = require('../utils/normalize');
const gates = require('./stageGates.service');

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
  Object.fromEntries(
    Object.entries(TRANSITIONS).map(([from, edges]) => [from, Object.keys(edges)]),
  ),
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

/** The hidden per-org chat container project (web lib/chat.ts). */
const TEAM_CHAT_TITLE = 'Team Chat';

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
  // "Team Chat" is the org's one hidden chat container: creating it again returns the existing one
  if (title === TEAM_CHAT_TITLE) {
    const existing = await Project.findOne({ organizationId, title: TEAM_CHAT_TITLE }).sort({
      createdAt: 1,
    });
    if (existing) return existing;
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
  // Stage gate (409 stage_gate with the missing items): a move into a later
  // stage needs the work of the stage it leaves. No role bypasses it. Checked
  // after the edge's own 400s (no_version / not_approved), before any write.
  const gate = () =>
    gates.assertMove(project, newStatus, { canApprove: allows(permissions, PERM.approve) });
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
    await gate();
    return approveVersion({
      projectId,
      organizationId,
      versionId: latest._id,
      approverId: actorId,
    });
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
  await gate();
  const from = project.status;
  project.status = newStatus;
  await project.save();
  await bus.emitAsync('project.transitioned', { projectId, from, to: newStatus, actorId });
  return project;
}

async function assignProject({ projectId, organizationId, assigneeId, actorId }) {
  const project = await Project.findOne({ _id: projectId, organizationId });
  if (!project) throw { status: 404, code: 'project_not_found', message: 'Project not found' };
  // The assignee must be an active member of this project's organization: no
  // assigning work to someone in another workspace (or to a disabled member).
  const Membership = require('../models/membership.model');
  const member = await Membership.exists({
    userId: assigneeId,
    organizationId,
    disabled: { $ne: true },
  });
  if (!member)
    throw {
      status: 422,
      code: 'assignee_not_member',
      message: 'The assignee must be an active member of this organization',
    };
  project.assignee = assigneeId;
  project.assignedAt = new Date();
  if (project.status === 'IDEA' || project.status === 'APPROVED_CONCEPT') {
    // Only when the concept gate is met; otherwise the owner is set and the
    // project stays in Idea until its concept is picked.
    const g = await gates.evaluate(project, { to: 'ASSIGNED' });
    if (g.ready) project.status = 'ASSIGNED';
  }
  await project.save();
  await bus.emitAsync('project.assigned', { projectId, assigneeId, actorId });
  await project.populate('assignee', 'name email');
  return project;
}

/**
 * Link (or unlink with dealId null) the deal this project delivers. The deal
 * must be in the project's organization and `milestoneKey` one of its
 * milestones. Read-only on the deal.
 */
async function linkDeal({ projectId, organizationId, dealId, milestoneKey }) {
  const project = await Project.findOne({ _id: projectId, organizationId });
  if (!project) throw { status: 404, code: 'project_not_found', message: 'Project not found' };
  if (!dealId) {
    project.dealId = null;
    project.milestoneKey = null;
  } else {
    const { dealService } = require('../modules/deals/service.cts');
    const deal = await dealService()
      .get(String(dealId), String(organizationId))
      .catch(() => null);
    if (!deal) throw { status: 404, code: 'deal_not_found', message: 'Deal not found' };
    const keys = (deal.milestones || []).map((m) => m.key);
    const key = milestoneKey || (keys.length === 1 ? keys[0] : null);
    if (!key || !keys.includes(key)) {
      throw { status: 422, code: 'milestone_required', message: 'Pick one of the deal milestones' };
    }
    project.dealId = String(dealId);
    project.milestoneKey = key;
  }
  await project.save();
  return getProject({ projectId, organizationId });
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
      // Into Review only once the automated checks ran (stage gate); until
      // then the upload stays in Production and the checklist says why.
      const g = await gates.evaluate(project, { to: 'FIRST_DRAFT_SUBMITTED' });
      if (g.ready) project.status = 'FIRST_DRAFT_SUBMITTED';
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
  // Approval is the Review -> Publish step: a project still before Review has
  // to pass the Production -> Review gate first (no jumping a stage).
  if (gates.stageIndex(project.status) < gates.stageIndex('FIRST_DRAFT_SUBMITTED')) {
    const g = await gates.evaluate(project, { to: 'FIRST_DRAFT_SUBMITTED' });
    const missing = g.gated ? g.missing : [];
    throw {
      status: 409,
      code: 'stage_gate',
      message: 'Move the project to Review before approving a version',
      details: missing.length
        ? missing.map(({ key, label, href, action }) => ({ key, label, href, action }))
        : [
            {
              key: 'in_review',
              label: 'Move the project to Review',
              href: `/projects/${projectId}`,
              action: 'Open project',
            },
          ],
    };
  }
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
  linkDeal,
  getVersions,
  addVersion,
  approveVersion,
  checkInputsReady,
  saveVersionFile,
};
