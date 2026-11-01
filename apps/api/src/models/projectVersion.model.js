const mongoose = require('mongoose');
const projectOwned = require('./plugins/projectOwned');

const FileSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true },
    mimeType: { type: String, default: 'application/octet-stream' },
    size: { type: Number, default: 0 },
    storageRef: { type: String, default: '' },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Postiz media cache: the file is uploaded once and the returned
    // { id, path } is reused by every post / retry / reschedule.
    postizMedia: {
      id: { type: String, default: '' },
      path: { type: String, default: '' },
      uploadedAt: { type: Date, default: null },
    },
  },
  { _id: true },
);

const ProjectVersionSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      ref: 'Project',
      index: true,
    },
    versionNumber: { type: Number, required: true },
    uploader: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    metadata: { type: Object, default: {} },
    changeSummary: { type: String, default: '' },
    files: { type: [FileSchema], default: [] },
  },
  { timestamps: true },
);

ProjectVersionSchema.index({ projectId: 1, versionNumber: 1 }, { unique: true });

// Tenant key (ADR-0015): required organizationId, filled from the Project.
ProjectVersionSchema.plugin(projectOwned, {
  indexes: [{ organizationId: 1, projectId: 1, versionNumber: -1 }],
});

const ProjectVersion = mongoose.model('ProjectVersion', ProjectVersionSchema);
module.exports = ProjectVersion;
