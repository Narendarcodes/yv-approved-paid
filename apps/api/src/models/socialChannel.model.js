const mongoose = require('mongoose');

/**
 * A social account the organization publishes to.
 * mode 'demo'   - handled by the built-in local scheduler (no real tokens)
 * mode 'postiz' - linked to a Postiz integration (externalId = integration id)
 */
const SocialChannelSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'Organization', index: true },
    platform: { type: String, required: true, enum: ['instagram', 'youtube', 'linkedin', 'x'] },
    name: { type: String, required: true, trim: true },
    handle: { type: String, default: '', trim: true },
    picture: { type: String, default: '' },
    mode: { type: String, enum: ['demo', 'postiz'], default: 'demo' },
    externalId: { type: String, default: '' },
    postizIdentifier: { type: String, default: '' },
    // connected | expired (token refresh needed / disabled in Postiz -> Reconnect) | disconnected
    status: { type: String, enum: ['connected', 'expired', 'disconnected'], default: 'connected' },
    statusReason: { type: String, default: '' },
    lastCheckedAt: { type: Date, default: null },
    analyticsSyncedAt: { type: Date, default: null }, // last platform-analytics ingestion (daily)
    connectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

SocialChannelSchema.index({ organizationId: 1, status: 1 });

module.exports = mongoose.model('SocialChannel', SocialChannelSchema);
