const PerformanceMetric = require('../models/performanceMetric.model');
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

async function listMetrics({ projectId, organizationId, limit = 100, skip = 0 }) {
  await assertProject(projectId, organizationId);
  const [items, total] = await Promise.all([
    PerformanceMetric.find({ projectId }).sort({ recordedAt: -1 }).skip(skip).limit(limit),
    PerformanceMetric.countDocuments({ projectId }),
  ]);
  return { items, total, limit, skip };
}

async function recordMetric({
  projectId,
  organizationId,
  publicationId = null,
  metric,
  value,
  unit = '',
  recordedBy,
}) {
  const project = await assertProject(projectId, organizationId);
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  const m = new PerformanceMetric({
    organizationId: project.organizationId,
    projectId,
    publicationId,
    metric,
    value,
    unit,
    recordedBy,
    scope: 'post',
    date,
    cumulative: true,
    source: 'manual',
  });
  await m.save();
  await bus.emitAsync('metric.recorded', { projectId, metric: m, recordedBy });
  return m;
}

module.exports = { listMetrics, recordMetric };
