const Publication = require('../models/publication.model');
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

async function scheduleProject({ projectId, organizationId, scheduledAt, actorId }) {
  const project = await assertProject(projectId, organizationId);
  if (!project.approvedVersionId) {
    throw {
      status: 400,
      code: 'not_approved',
      message: 'Cannot schedule a project without an approved version',
    };
  }
  project.scheduledAt = new Date(scheduledAt);
  if (project.status === 'APPROVED') {
    project.status = 'SCHEDULED';
  }
  await project.save();
  await bus.emitAsync('project.scheduled', {
    projectId,
    scheduledAt: project.scheduledAt,
    actorId,
  });
  return project;
}

async function listPublications({ projectId, organizationId, limit = 100, skip = 0 }) {
  await assertProject(projectId, organizationId);
  const [items, total] = await Promise.all([
    Publication.find({ projectId }).sort({ publishedAt: -1 }).skip(skip).limit(limit),
    Publication.countDocuments({ projectId }),
  ]);
  return { items, total, limit, skip };
}

/**
 * Manual "record a publication" (the pre-scheduler fallback). While the
 * project has posts waiting in the scheduler it must not create a second,
 * duplicate publication: a matching scheduled/failed post on the same
 * platform is marked published instead, and otherwise the request is refused
 * with a pointer to the calendar.
 */
async function recordPublication({
  projectId,
  organizationId,
  platform,
  postUrl = '',
  postId = '',
  publishedBy,
}) {
  const project = await assertProject(projectId, organizationId);
  if (!project.approvedVersionId) {
    throw {
      status: 400,
      code: 'not_approved',
      message: 'Cannot publish without an approved version',
    };
  }
  const pending = await Publication.find({ projectId, status: { $in: ['scheduled', 'failed'] } });
  if (pending.length) {
    const match = pending.find(
      (p) => String(p.platform).toLowerCase() === String(platform || '').toLowerCase(),
    );
    if (match) {
      // lazy require: scheduling.service requires this module's models only, no cycle at load time
      const scheduling = require('./scheduling.service');
      return scheduling.markPublishedManually({
        organizationId: project.organizationId,
        publicationId: match._id,
        postUrl,
        actorId: publishedBy,
      });
    }
    throw {
      status: 409,
      code: 'has_scheduled_posts',
      message: `This project has ${pending.length} post(s) in the publishing calendar. Mark those published from the calendar instead.`,
    };
  }
  const pub = new Publication({
    projectId,
    organizationId: project.organizationId,
    platform,
    postUrl,
    postId,
    publishedBy,
    provider: 'manual',
    status: 'published',
    publishedAt: new Date(),
  });
  await pub.save();
  project.publishedAt = new Date();
  if (['APPROVED', 'SCHEDULED'].includes(project.status)) {
    project.status = 'PUBLISHED';
  }
  await project.save();
  await bus.emitAsync('project.published', { projectId, publication: pub, publishedBy });
  return pub;
}

async function getApprovedVersion(projectId, organizationId) {
  const project = await assertProject(projectId, organizationId);
  if (!project.approvedVersionId) return null;
  return ProjectVersion.findById(project.approvedVersionId);
}

module.exports = { scheduleProject, listPublications, recordPublication, getApprovedVersion };
