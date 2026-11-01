const Input = require('../models/input.model');
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

async function listInputs({ projectId, organizationId, state, limit = 100, skip = 0 }) {
  await assertProject(projectId, organizationId);
  const q = { organizationId, projectId };
  if (state) q.state = state;
  const [items, total] = await Promise.all([
    Input.find(q).sort({ createdAt: 1 }).skip(skip).limit(limit).populate('owner', 'name email'),
    Input.countDocuments(q),
  ]);
  return { items, total, limit, skip };
}

async function createInput({
  projectId,
  organizationId,
  title,
  description = '',
  owner = null,
  source = '',
  requestedBy,
}) {
  await assertProject(projectId, organizationId);
  const input = new Input({
    organizationId,
    projectId,
    title,
    description,
    owner,
    source,
    requestedBy,
    state: 'requested',
  });
  await input.save();
  await bus.emitAsync('input.requested', { projectId, input });
  return input;
}

async function updateInputState({
  projectId,
  organizationId,
  inputId,
  state,
  assetRef = '',
  actorId,
}) {
  await assertProject(projectId, organizationId);
  const input = await Input.findOne({ _id: inputId, organizationId, projectId });
  if (!input) throw { status: 404, code: 'input_not_found', message: 'Input not found' };
  input.state = state;
  if (state === 'received') {
    input.receivedAt = new Date();
    if (assetRef) input.assetRef = assetRef;
  }
  await input.save();
  await bus.emitAsync('input.updated', { projectId, input, actorId, state });
  return input;
}

module.exports = { listInputs, createInput, updateInputState };
