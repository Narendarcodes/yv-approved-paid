const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const { authenticate, requireOrg, requirePermission } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { updateProfileSchema } = require('../validators/user.validator');
const { updateMemberSchema } = require('../validators/org.validator');

router.get('/me', authenticate, userController.me);
router.get('/me/organizations', authenticate, userController.myOrganizations);
router.patch('/me', authenticate, validate(updateProfileSchema), userController.updateMe);
// Profile photo upload/remove — multer is inside controller module
router.patch(
  '/me/photo',
  authenticate,
  userController.upload.single('file'),
  userController.uploadPhoto,
);
router.delete('/me/photo', authenticate, userController.removePhoto);
// Avatar file: self or a user sharing an org with the caller; else 404.
router.get('/:userId/photo', authenticate, userController.photo);
router.get(
  '/organizations/:organizationId/members',
  authenticate,
  requireOrg('organizationId'),
  requirePermission('manage_members'),
  userController.listMembers,
);
router.patch(
  '/organizations/:organizationId/members/:memberUserId',
  authenticate,
  requireOrg('organizationId'),
  requirePermission('manage_members'),
  validate(updateMemberSchema),
  userController.updateMember,
);

module.exports = router;
