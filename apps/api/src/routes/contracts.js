const express = require('express');
const router = express.Router();
const contractController = require('../controllers/contract.controller');
const {
  authenticate,
  requireOrg,
  requirePermission,
  requireReadScope,
} = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const {
  contractSchema,
  contractUpdateSchema,
  contractSignSchema,
} = require('../validators/contract.validator');

// --- Contracts (client agreements + e-sign lifecycle) ---
// Reads: contract.manage sees the org; contract.view (crew) only contracts they created. Writes: contract.manage.
const read = requireReadScope('contract.manage', 'contract.view');
router.get(
  '/:organizationId/contracts',
  authenticate,
  requireOrg('organizationId'),
  read,
  contractController.list,
);
router.post(
  '/:organizationId/contracts',
  authenticate,
  requireOrg('organizationId'),
  requirePermission('contract.manage'),
  validate(contractSchema),
  contractController.create,
);
router.get(
  '/:organizationId/contracts/:contractId',
  authenticate,
  requireOrg('organizationId'),
  read,
  contractController.get,
);
router.patch(
  '/:organizationId/contracts/:contractId',
  authenticate,
  requireOrg('organizationId'),
  requirePermission('contract.manage'),
  validate(contractUpdateSchema),
  contractController.update,
);
router.post(
  '/:organizationId/contracts/:contractId/send',
  authenticate,
  requireOrg('organizationId'),
  requirePermission('contract.manage'),
  contractController.send,
);
router.post(
  '/:organizationId/contracts/:contractId/view',
  authenticate,
  requireOrg('organizationId'),
  requirePermission('contract.manage'),
  contractController.markViewed,
);
router.post(
  '/:organizationId/contracts/:contractId/sign',
  authenticate,
  requireOrg('organizationId'),
  requirePermission('contract.manage'),
  validate(contractSignSchema),
  contractController.sign,
);

module.exports = router;
