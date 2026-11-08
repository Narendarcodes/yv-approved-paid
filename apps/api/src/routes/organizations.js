const express = require('express');
const router = express.Router();
const controller = require('../controllers/org.controller');
const activityController = require('../controllers/activity.controller');
const { authenticate, requireOrg, requirePermission } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { createOrgSchema, updateMemberSchema } = require('../validators/org.validator');
const Organization = require('../models/organization.model');
const { BrandRule } = require('../models/agent');

// Public availability check so the signup wizard can route users to sign-in
// BEFORE they build the rest of the form (no auth needed - slug/name only).
router.get('/availability', controller.checkAvailability);

// Org-wide activity feed (dashboard "Recent activity") — events across all org projects
router.get(
  '/:organizationId/activity',
  authenticate,
  requireOrg('organizationId'),
  requirePermission('project.view'),
  activityController.listOrg,
);

// Brand Brain's brand memory (read-only): the brand rules the agent answers from, and a
// sample conversation when the org has one (the demo seeds it). Not behind the agent switch,
// so the page can show what the assistant knows even while the agent is offline.
router.get(
  '/:organizationId/brand-memory',
  authenticate,
  requireOrg('organizationId'),
  requirePermission('project.view'),
  async (req, res, next) => {
    try {
      const orgId = req.params.organizationId;
      const [rules, org] = await Promise.all([
        BrandRule.find({ organizationId: orgId }).sort({ createdAt: 1, _id: 1 }).lean(),
        Organization.findById(orgId).select('settings').lean(),
      ]);
      const sample = Array.isArray(org?.settings?.brandBrainSample)
        ? org.settings.brandBrainSample
        : [];
      res.json({
        data: {
          rules: rules.map((r) => ({
            id: String(r._id),
            kind: r.kind,
            title: r.title,
            body: r.body,
          })),
          sample: sample
            .filter((t) => t && typeof t.q === 'string' && typeof t.a === 'string')
            .slice(0, 6)
            .map((t) => ({
              q: t.q,
              a: t.a,
              cites: Array.isArray(t.cites) ? t.cites.map(String).slice(0, 6) : [],
            })),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

router.post('/', authenticate, validate(createOrgSchema), controller.createOrg);
router.get('/', authenticate, controller.listOrgs);
router.post(
  '/:organizationId/members',
  authenticate,
  requireOrg('organizationId'),
  requirePermission('manage_members'),
  controller.addMember,
);
router.get(
  '/:organizationId/members',
  authenticate,
  requireOrg('organizationId'),
  requirePermission('project.view'),
  controller.listMembers,
);
router.patch(
  '/:organizationId/members/:memberUserId',
  authenticate,
  requireOrg('organizationId'),
  requirePermission('manage_members'),
  validate(updateMemberSchema),
  controller.updateMember,
);

module.exports = router;
