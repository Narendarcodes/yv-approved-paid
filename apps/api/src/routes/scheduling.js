const express = require('express');
const router = express.Router();
const c = require('../controllers/scheduling.controller');
const { authenticate, requireOrg, requirePermission } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const v = require('../validators/scheduling.validator');

// Mounted at /organizations. Reading needs project.view; changing channels or
// posts needs project.schedule (admins + publishers by default).
const base = '/:organizationId/scheduling';
const view = [authenticate, requireOrg('organizationId'), requirePermission('project.view')];
const manage = [authenticate, requireOrg('organizationId'), requirePermission('project.schedule')];

router.get(`${base}/status`, ...view, c.status);

router.get(`${base}/channels`, ...view, c.listChannels);
router.post(`${base}/channels/connect`, ...manage, validate(v.startConnectSchema), c.startConnect);
router.post(`${base}/channels/connect/complete`, ...manage, c.completeConnect);
router.post(`${base}/channels/check`, ...manage, c.checkConnection);
router.post(`${base}/channels/:channelId/reconnect`, ...manage, c.reconnect);
router.get(`${base}/suggest-time`, ...view, c.suggestTime);
router.post(`${base}/channels`, ...manage, validate(v.connectChannelSchema), c.connectChannel);
router.delete(`${base}/channels/:channelId`, ...manage, c.disconnectChannel);
router.get(`${base}/postiz/integrations`, ...manage, c.listPostizIntegrations);
router.post(`${base}/postiz/import`, ...manage, c.importPostizChannels);

router.get(`${base}/eligible-projects`, ...view, c.eligible);

router.get(`${base}/posts`, ...view, c.listPosts);
router.post(`${base}/posts`, ...manage, validate(v.schedulePostSchema), c.schedule);
router.patch(`${base}/posts/:postId`, ...manage, validate(v.rescheduleSchema), c.reschedule);
router.post(`${base}/posts/:postId/cancel`, ...manage, c.cancel);
router.post(`${base}/posts/:postId/publish-now`, ...manage, c.publishNow);
router.post(`${base}/posts/:postId/mark-published`, ...manage, validate(v.markPublishedSchema), c.markPublished);
router.post(`${base}/posts/:postId/sync`, ...manage, c.syncMetrics);
router.post(`${base}/posts/:postId/retry`, ...manage, validate(v.retrySchema), c.retry);

module.exports = router;
