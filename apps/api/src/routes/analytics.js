const express = require('express');
const router = express.Router();
const analytics = require('../services/analytics.service');
const ingest = require('../services/analytics.ingest');
const { authenticate, requireOrg, requirePermission } = require('../middleware/auth');

// Mounted at /organizations. Reading needs project.view; forcing an
// ingestion run needs project.schedule.
const base = '/:organizationId/analytics';
const view = [authenticate, requireOrg('organizationId'), requirePermission('project.view')];
const manage = [authenticate, requireOrg('organizationId'), requirePermission('project.schedule')];

const wrap = (fn) => async (req, res, next) => {
  try {
    res.json({ data: await fn(req) });
  } catch (err) {
    next(err);
  }
};
const org = (req) => req.params.organizationId;

router.get(`${base}/summary`, ...view, wrap((req) => analytics.summary({ organizationId: org(req), days: req.query.days })));
router.get(`${base}/heatmap`, ...view, wrap((req) => analytics.heatmap({ organizationId: org(req) })));
router.get(`${base}/top-performers`, ...view, wrap((req) => analytics.topPerformers({ organizationId: org(req), month: req.query.month, limit: Math.min(20, parseInt(req.query.limit, 10) || 5) })));
router.get(
  `${base}/projects/:projectId/performance`,
  ...view,
  wrap((req) => analytics.projectPerformance({ organizationId: org(req), projectId: req.params.projectId, days: req.query.days }))
);
router.get(
  `${base}/report`,
  ...view,
  wrap((req) => analytics.report({ organizationId: org(req), projectId: req.query.projectId, month: req.query.month, client: req.query.client }))
);
// Dashboard pipeline (stage strip, blocked-on-whom, going live today, last week's best)
router.get('/:organizationId/pipeline', ...view, wrap((req) => require('../services/pipeline.service').pipeline({ organizationId: req.params.organizationId })));
router.post(`${base}/ingest`, ...manage, wrap(() => ingest.runIngestion(new Date())));

module.exports = router;
