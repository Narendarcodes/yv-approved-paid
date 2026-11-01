const mongoose = require('mongoose');
const projectOwned = require('./plugins/projectOwned');

const CommentSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: 'Project',
      index: true,
    },
    versionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProjectVersion', default: null },
    author: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Comment', default: null },
    body: { type: String, required: true, trim: true, maxlength: 10000 },
    resolved: { type: Boolean, default: false },
    // Optional playhead position (seconds) for frame-anchored video feedback
    timecode: { type: Number, min: 0, default: null },
  },
  { timestamps: true },
);

CommentSchema.index({ projectId: 1, versionId: 1, createdAt: 1 });

// Tenant key (ADR-0015): required organizationId, filled from the Project.
CommentSchema.plugin(projectOwned, {
  indexes: [{ organizationId: 1, projectId: 1, versionId: 1, createdAt: 1 }],
});

const Comment = mongoose.model('Comment', CommentSchema);
module.exports = Comment;
