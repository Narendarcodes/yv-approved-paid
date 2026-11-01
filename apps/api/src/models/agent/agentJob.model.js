const mongoose = require('mongoose');

/** Tracks an async agent job enqueued on Redis Streams (status mirrors worker results). */
const AgentJobSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, unique: true },
    type: { type: String, required: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    payload: { type: Object, default: {} },
    status: { type: String, enum: ['queued', 'succeeded', 'failed', 'dead_lettered'], default: 'queued' },
    result: { type: Object, default: null },
    error: { type: String, default: '' },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.models.AgentJob || mongoose.model('AgentJob', AgentJobSchema);
