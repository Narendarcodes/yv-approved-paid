const express = require('express');
const router = express.Router();
const controller = require('../controllers/auth.controller');
const { validate } = require('../middleware/validate');
const {
  registerSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
} = require('../validators/auth.validator');
const { authenticate } = require('../middleware/auth');
const { buildAuthLimits } = require('../middleware/authRateLimit');

// Brute-force limits (Phase 1 item 9): per IP before validation, per account
// after it (the validated body carries the email).
const limits = buildAuthLimits();
router.limits = limits; // exposed for tests (store reset)

router.post(
  '/register',
  limits.registerIp,
  validate(registerSchema),
  limits.registerAccount,
  controller.register,
);
router.post('/login', limits.loginIp, validate(loginSchema), limits.loginAccount, controller.login);
// One-tap judge login: 404 unless DEMO_MODE=1; per-IP limit; same cookie session + CSRF as /login.
router.post('/demo-login', controller.demoGate, limits.demoIp, controller.demoLogin);
router.post(
  '/refresh',
  limits.refreshIp,
  validate(refreshSchema),
  limits.refreshAccount,
  controller.refresh,
);
router.post('/logout', validate(logoutSchema), controller.logout);
router.get('/me', authenticate, controller.me);
router.get('/csrf', authenticate, controller.csrf);

module.exports = router;
