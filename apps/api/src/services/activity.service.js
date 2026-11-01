const ActivityEvent = require('../models/activityEvent.model');

async function recordActivity({
  projectId,
  organizationId = null,
  actor,
  action,
  entityType = '',
  entityId = null,
  metadata = {},
}) {
  // organizationId is filled from the Project by the projectOwned plugin when
  // the event bus did not carry it.
  const ev = new ActivityEvent({ projectId, actor, action, entityType, entityId, metadata });
  if (organizationId) ev.organizationId = organizationId;
  await ev.save();
  return ev;
}

async function listActivity({ projectId, organizationId, limit = 100, skip = 0 }) {
  if (!organizationId)
    throw { status: 500, code: 'missing_tenant', message: 'organizationId is required' };
  return ActivityEvent.find({ organizationId, projectId })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('actor', 'name email');
}

/**
 * Org-wide feed: newest events across every project in the organization.
 * Used by the dashboard "Recent activity" card (real events, not
 * notifications). Membership is enforced by the route's requireOrg.
 */
async function listOrgActivity({ organizationId, limit = 20, skip = 0 }) {
  // Uses the { organizationId, createdAt } index directly (ADR-0015 backfill).
  return ActivityEvent.find({ organizationId })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('actor', 'name email')
    .populate('projectId', 'title');
}

module.exports = { recordActivity, listActivity, listOrgActivity };
