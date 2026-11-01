const mongoose = require('mongoose');

/**
 * Performance time series (Phase 2 analytics, see docs/adr/0009-analytics-ingestion.md).
 *
 * One row = one metric, for one post (scope 'post') or one channel
 * (scope 'platform'), on one day (`date`, UTC midnight).
 *   rawLabel    - the label exactly as the source reported it (e.g. "Impressions")
 *   metric      - normalized key: views | likes | comments | shares | saves |
 *                 watchTime | followers | followersGained | reach, or
 *                 "raw:<label>" when we have no mapping
 *   cumulative  - true when value is a running total as of `date` (post
 *                 metrics, follower counts); false for per-day flows
 *   simulated   - demo-mode data (generated, never real) - always labelled in UI
 *   source      - postiz | simulated | manual
 *
 * Legacy rows (manual entry, pre-Phase-2 syncs) have no `date`; they are read
 * as cumulative snapshots at `recordedAt`.
 */
const PerformanceMetricSchema = new mongoose.Schema(
  {
    organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null, index: true },
    publicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Publication', default: null },
    channelId: { type: mongoose.Schema.Types.ObjectId, ref: 'SocialChannel', default: null },
    platform: { type: String, default: '' }, // yv. platform key (instagram|youtube|linkedin|x)
    scope: { type: String, enum: ['post', 'platform'], default: 'post' },
    rawLabel: { type: String, default: '' },
    metric: { type: String, required: true, trim: true },
    value: { type: Number, required: true },
    date: { type: Date, default: null },
    cumulative: { type: Boolean, default: true },
    simulated: { type: Boolean, default: false },
    source: { type: String, default: 'manual' },
    unit: { type: String, default: '' },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    recordedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

PerformanceMetricSchema.index({ projectId: 1, recordedAt: -1 });
PerformanceMetricSchema.index({ organizationId: 1, scope: 1, date: 1 });
PerformanceMetricSchema.index({ publicationId: 1, metric: 1, date: 1 });
PerformanceMetricSchema.index({ channelId: 1, scope: 1, metric: 1, date: 1 });

const PerformanceMetric = mongoose.model('PerformanceMetric', PerformanceMetricSchema);
module.exports = PerformanceMetric;
