const mongoose = require('mongoose');
const projectOwned = require('./plugins/projectOwned');

const ActivityEventSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: 'Project',
      index: true,
    },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    action: { type: String, required: true }, // e.g. created, transitioned, version_uploaded, comment_added, revision_requested, approved, scheduled, published, metric_recorded
    entityType: { type: String, default: '' },
    entityId: { type: mongoose.Schema.Types.ObjectId, default: null },
    metadata: { type: Object, default: {} },
  },
  { timestamps: true },
);

ActivityEventSchema.index({ projectId: 1, createdAt: -1 });

// Tenant key (ADR-0015): required organizationId, filled from the Project.
ActivityEventSchema.plugin(projectOwned, {
  indexes: [
    { organizationId: 1, createdAt: -1 },
    { organizationId: 1, projectId: 1, createdAt: -1 },
  ],
});

const ActivityEvent = mongoose.model('ActivityEvent', ActivityEventSchema);
module.exports = ActivityEvent;
