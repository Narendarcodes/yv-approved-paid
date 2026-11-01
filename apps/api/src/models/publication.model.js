const mongoose = require('mongoose');

/**
 * One post of a Content Project on one channel. The project stays the source
 * of truth; publications mirror what the publishing provider (local scheduler
 * or Postiz) reports back: state, live URL, metrics.
 *
 * Manually recorded posts (the fallback) are created directly as 'published'
 * with provider 'manual'.
 */
const PublicationSchema = new mongoose.Schema(
  {
    projectId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'Project', index: true },
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
    platform: { type: String, required: true, trim: true },
    postUrl: { type: String, default: '' },
    postId: { type: String, default: '' },
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    publishedAt: { type: Date, default: Date.now },
    // --- scheduling ---
    status: {
      type: String,
      enum: ['scheduled', 'published', 'failed', 'cancelled'],
      default: 'published',
    },
    provider: { type: String, enum: ['manual', 'local', 'postiz'], default: 'manual' },
    channelId: { type: mongoose.Schema.Types.ObjectId, ref: 'SocialChannel', default: null },
    caption: { type: String, default: '' },
    scheduledFor: { type: Date, default: null },
    versionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ProjectVersion', default: null },
    fileId: { type: mongoose.Schema.Types.ObjectId, default: null },
    externalPostId: { type: String, default: '' }, // Postiz post id or local id
    failureReason: { type: String, default: '' },
    failedAt: { type: Date, default: null },
    retryCount: { type: Number, default: 0 },
    // validated per-platform composer settings (yv. shape, see integrations/postiz/settings.js)
    settings: { type: Object, default: {} },
    scheduledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    metrics: { type: Object, default: {} }, // { views, likes, comments, shares, ... }
    metricsSimulated: { type: Boolean, default: false },
    lastSyncedAt: { type: Date, default: null },
    analyticsSyncedAt: { type: Date, default: null }, // last analytics ingestion (hourly <48h, then daily)
  },
  { timestamps: true }
);

PublicationSchema.index({ projectId: 1, publishedAt: -1 });
PublicationSchema.index({ status: 1, scheduledFor: 1 });
PublicationSchema.index({ externalPostId: 1 }, { sparse: true });

const Publication = mongoose.model('Publication', PublicationSchema);
module.exports = Publication;
