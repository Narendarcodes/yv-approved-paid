const Brief = require('../models/brief.model');
const Project = require('../models/project.model');
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

async function getBrief({ projectId, organizationId }) {
  await assertProject(projectId, organizationId);
  const brief = await Brief.findOne({ organizationId, projectId });
  return brief || { projectId, exists: false };
}

async function upsertBrief({ projectId, organizationId, submittedBy, fields }) {
  await assertProject(projectId, organizationId);
  const existing = await Brief.findOne({ organizationId, projectId });
  if (existing) {
    Object.assign(existing, fields);
    await existing.save();
    await bus.emitAsync('brief.updated', { projectId, brief: existing, actorId: submittedBy });
    return existing;
  }
  const brief = new Brief({ ...fields, organizationId, projectId, submittedBy });
  await brief.save();
  await bus.emitAsync('brief.created', { projectId, brief, actorId: submittedBy });
  return brief;
}

module.exports = { getBrief, upsertBrief };
