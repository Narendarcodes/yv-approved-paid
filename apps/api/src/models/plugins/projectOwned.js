/**
 * Mongoose plugin for documents that belong to a Project (ADR-0015).
 *
 * Adds a REQUIRED `organizationId` (the owning Project's org) and fills it on
 * validate when a caller only set `projectId`, so every write path (services,
 * event listeners, seeds) stores the tenant key even before it passes it
 * explicitly. Services still filter reads by organizationId themselves.
 *
 * Indexing: pass compound indexes that START with organizationId; they also
 * serve organizationId-only queries (index prefix).
 */
const mongoose = require('mongoose');

function projectOwned(schema, { indexes = [] } = {}) {
  schema.add({
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true },
  });
  for (const spec of indexes) schema.index(spec);

  schema.pre('validate', async function fillOrganization() {
    if (this.organizationId || !this.projectId) return;
    const Project = mongoose.model('Project');
    const p = await Project.findById(this.projectId).select('organizationId').lean();
    if (p) this.organizationId = p.organizationId;
  });
}

module.exports = projectOwned;
