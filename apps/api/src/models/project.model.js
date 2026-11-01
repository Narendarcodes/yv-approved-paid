const mongoose = require('mongoose');

const ProjectSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'Organization', index: true },
    title: { type: String, required: true, trim: true },
    type: { type: String, default: 'content' },
    description: { type: String, default: '' },
    status: { type: String, required: true, default: 'IDEA' },
    creator: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    assignee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    assignedAt: { type: Date, default: null },
    approvedVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProjectVersion', default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    scheduledAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
    revisionCount: { type: Number, default: 0 },
    // optional grouping for analytics rollups and client reports
    client: { type: String, default: '', trim: true },
    campaign: { type: String, default: '', trim: true },
    // Multi-channel publishing progress (non-cancelled posts). While some
    // posts are live and others still pending the project stays SCHEDULED
    // and the UI shows "Partially published (published/total)".
    publishProgress: {
      published: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },
    // Concept this project was created from (Concepts -> Project conversion).
    conceptId: { type: mongoose.Schema.Types.ObjectId, ref: 'Concept', default: null },
  },
  { timestamps: true }
);

// Dashboard query patterns: status, assignee, scheduled date, org boundary
ProjectSchema.index({ organizationId: 1, status: 1 });
ProjectSchema.index({ organizationId: 1, assignee: 1, status: 1 });
ProjectSchema.index({ organizationId: 1, scheduledAt: 1 });

const Project = mongoose.model('Project', ProjectSchema);
module.exports = Project;
