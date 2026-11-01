/**
 * Redis Streams job bridge. Node XADDs versioned job envelopes
 * (contracts/schemas/JobEnvelope.json) to `yv:jobs`; the Python worker
 * consumes them in a consumer group, retries, dead-letters, and POSTs results
 * back to /internal/jobs/:id/result.
 */
const crypto = require('crypto');
const config = require('../config');
const { mintServiceToken } = require('./serviceToken');
const { validate } = require('./contracts');
const AgentJob = require('../models/agent/agentJob.model');

const JOB_SCOPES = {
  'insights.analyze_post.v1': ['posts:read', 'metrics:read', 'brand:read', 'insights:write', 'jobs:write'],
  'ingest.transcribe.v1': ['posts:read', 'assets:write', 'jobs:write'],
  'review.digest.v1': ['posts:read', 'reviews:read', 'brand:read', 'insights:write', 'jobs:write'],
  'brand.index.v1': ['brand:read', 'jobs:write'],
};

let client = null;
function getRedis() {
  if (!client) {
    const Redis = require('ioredis');
    client = new Redis(config.agent.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false });
  }
  return client;
}
function setRedis(c) {
  client = c;
}

async function enqueue(type, { orgId, userId, payload }) {
  const scopes = JOB_SCOPES[type];
  if (!scopes) throw Object.assign(new Error(`unknown job type ${type}`), { status: 400 });
  const jobId = crypto.randomUUID();
  const envelope = {
    jobId,
    type,
    orgId: String(orgId),
    userId: String(userId),
    payload: payload || {},
    attempt: 0,
    createdAt: new Date().toISOString(),
    serviceToken: mintServiceToken({ orgId, userId, scopes, ttlSec: config.agent.jobTokenTtlSec }),
  };
  const v = validate('JobEnvelope', envelope);
  if (!v.ok) throw new Error(`invalid job envelope: ${v.errors.join('; ')}`);
  await AgentJob.create({ jobId, type, organizationId: orgId, userId, payload: envelope.payload, status: 'queued' });
  const streamId = await getRedis().xadd(config.agent.jobsStream, '*', 'type', type, 'envelope', JSON.stringify(envelope));
  return { jobId, streamId, type };
}

async function close() {
  if (client) {
    await client.quit().catch(() => {});
    client = null;
  }
}

module.exports = { enqueue, getRedis, setRedis, close, JOB_SCOPES };
