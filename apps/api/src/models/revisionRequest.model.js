const mongoose = require('mongoose');
const projectOwned = require('./plugins/projectOwned');

const RevisionRequestSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: 'Project',
      index: true,
    },
    revisionNumber: { type: Number, required: true },
    reason: { type: String, required: true, trim: true },
    sourceVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProjectVersion', default: null },
    requester: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    status: {
      type: String,
      enum: ['requested', 'in_progress', 'submitted', 'resolved'],
      default: 'requested',
    },
    source: { type: String, enum: ['manual', 'review_lock'], default: 'manual' },
    scopeItems: [
      {
        commentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Comment', default: null },
        author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        body: { type: String, default: '' },
      },
    ],
    submitter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedVersionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ProjectVersion',
      default: null,
    },
    requestedAt: { type: Date, default: Date.now },
    submittedAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

RevisionRequestSchema.index({ projectId: 1, revisionNumber: 1 }, { unique: true });

// Tenant key (ADR-0015): required organizationId, filled from the Project.
RevisionRequestSchema.plugin(projectOwned, {
  indexes: [{ organizationId: 1, projectId: 1, revisionNumber: -1 }],
});

const RevisionRequest = mongoose.model('RevisionRequest', RevisionRequestSchema);
module.exports = RevisionRequest;
