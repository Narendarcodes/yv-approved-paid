/**
 * Agent-platform collections (ARCHITECTURE.md §Data). Every document carries
 * organizationId; /internal routes always filter by the service token's orgId.
 */
const mongoose = require('mongoose');
const { Schema } = mongoose;
const OID = Schema.Types.ObjectId;
const model = (name, schema) => mongoose.models[name] || mongoose.model(name, schema);

const Post = model(
  'Post',
  new Schema(
    {
      organizationId: { type: OID, ref: 'Organization', required: true, index: true },
      projectId: { type: OID, ref: 'Project', default: null },
      publicationId: { type: OID, ref: 'Publication', default: null },
      platform: { type: String, enum: ['youtube', 'instagram', 'x', 'linkedin'], required: true },
      externalId: { type: String, default: '' },
      title: { type: String, required: true },
      caption: { type: String, default: '' },
      format: { type: String, default: '' }, // reel | short | long | carousel
      durationSec: { type: Number, default: 0 },
      publishedAt: { type: Date, default: null },
      tags: [String],
      source: { type: String, default: 'manual' },
    },
    { timestamps: true }
  )
);

const Asset = model(
  'Asset',
  new Schema(
    {
      organizationId: { type: OID, ref: 'Organization', required: true, index: true },
      postId: { type: OID, ref: 'Post', index: true },
      kind: { type: String, enum: ['video', 'audio', 'image', 'doc'], default: 'video' },
      storageKey: { type: String, default: '' }, // s3://bucket/key (MinIO locally)
      transcript: [{ _id: false, start: Number, end: Number, text: String }],
      transcriptEngine: { type: String, default: '' },
      sceneCuts: [{ _id: false, second: Number, label: String }],
    },
    { timestamps: true }
  )
);

const BrandRule = model(
  'BrandRule',
  new Schema(
    {
      organizationId: { type: OID, ref: 'Organization', required: true, index: true },
      title: { type: String, required: true },
      body: { type: String, required: true },
      kind: { type: String, enum: ['voice', 'visual', 'do', 'dont', 'audience', 'resource', 'purpose'], default: 'do' },
      sourceUrl: { type: String, default: '' },
    },
    { timestamps: true }
  )
);

// MongoDB native time-series collection: one doc per (post, metric, ts).
const Metric = model(
  'Metric',
  new Schema(
    {
      ts: { type: Date, required: true },
      meta: {
        organizationId: { type: OID, required: true },
        postId: { type: OID, required: true },
        metric: { type: String, required: true },
        source: { type: String, default: 'fixture' },
      },
      value: { type: Number, required: true },
    },
    { timeseries: { timeField: 'ts', metaField: 'meta', granularity: 'hours' }, versionKey: false }
  )
);

const RetentionPoint = model(
  'RetentionPoint',
  new Schema(
    {
      organizationId: { type: OID, required: true, index: true },
      postId: { type: OID, ref: 'Post', required: true, index: true },
      second: { type: Number, required: true },
      audienceWatchRatio: { type: Number, required: true },
      relativeRetentionPerformance: { type: Number, default: null },
    },
    { versionKey: false }
  )
);

const Insight = model(
  'Insight',
  new Schema(
    {
      organizationId: { type: OID, required: true, index: true },
      postId: { type: OID, ref: 'Post', required: true },
      kind: { type: String, required: true },
      summary: { type: String, required: true },
      atSecond: Number,
      spokenText: String,
      onScreen: String,
      liftVsBaseline: Number,
      citations: [{ _id: false, postId: String, metric: String, value: Schema.Types.Mixed, note: String }],
      dataLimits: [String],
      jobId: String,
      createdBy: { type: String, default: 'agent' },
    },
    { timestamps: true }
  )
);

const ReviewComment = model(
  'ReviewComment',
  new Schema(
    {
      organizationId: { type: OID, required: true, index: true },
      postId: { type: OID, ref: 'Post', required: true, index: true },
      author: { type: String, required: true },
      role: { type: String, default: 'reviewer' },
      body: { type: String, required: true },
      timecodeSec: { type: Number, default: null },
    },
    { timestamps: true }
  )
);

module.exports = { Post, Asset, BrandRule, Metric, RetentionPoint, Insight, ReviewComment, AgentJob: require('./agentJob.model') };
