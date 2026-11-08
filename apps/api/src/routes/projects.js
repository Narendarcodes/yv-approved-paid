const express = require('express');
const multer = require('multer');
const router = express.Router();
const projectController = require('../controllers/project.controller');
const inputController = require('../controllers/input.controller');
const commentController = require('../controllers/comment.controller');
const revisionController = require('../controllers/revision.controller');
const publicationController = require('../controllers/publication.controller');
const metricsController = require('../controllers/metrics.controller');
const activityController = require('../controllers/activity.controller');
const taskController = require('../controllers/task.controller');
const briefController = require('../controllers/brief.controller');
const reviewController = require('../controllers/review.controller');
const chatController = require('../controllers/chat.controller');
const { authenticate } = require('../middleware/auth');
const { can } = require('../modules/access/index.cts');

// Access (ADR-0015): every /:id route resolves the org from the PROJECT itself;
// organizationId in the query/body is ignored there. Create/list use it only to
// select one of the caller's own memberships. Non-members get 404.
const PROJECT = { from: 'project' };
const SELECT = { from: 'select' };
const fileStreamController = require('../controllers/fileStream.controller');
const { validate } = require('../middleware/validate');
const {
  createProjectSchema,
  transitionSchema,
  assignSchema,
  dealLinkSchema,
  addVersionSchema,
  approveSchema,
  scheduleSchema,
  commentSchema,
  revisionSchema,
  revisionUpdateSchema,
  publicationSchema,
  metricSchema,
  inputSchema,
  inputUpdateSchema,
} = require('../validators/project.validator');
const { taskSchema, taskUpdateSchema, taskStatusSchema } = require('../validators/task.validator');
const { briefSchema } = require('../validators/brief.validator');
const { reviewLockSchema, reviewSummarizeSchema } = require('../validators/review.validator');
const { channelSchema, messageSchema } = require('../validators/chat.validator');

// in-memory multer: buffers file in memory, then handed to storage adapter
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB cap
});

// --- Project CRUD ---
router.post(
  '/',
  authenticate,
  can('project.create', SELECT),
  validate(createProjectSchema),
  projectController.create,
);
router.get('/', authenticate, can('project.view', SELECT), projectController.list);
router.get('/:id', authenticate, can('project.view', PROJECT), projectController.get);

// --- Workflow ---
// Membership only here: each lifecycle edge needs its own permission, checked
// in projectService.transitionProject against the TRANSITIONS table (ADR-0019).
router.post(
  '/:id/transition',
  authenticate,
  can(null, PROJECT),
  validate(transitionSchema),
  projectController.transition,
);
// Stage gates: the checklist for the next move, and the deal link it reads.
router.get('/:id/gate', authenticate, can('project.view', PROJECT), projectController.gate);
router.put(
  '/:id/deal',
  authenticate,
  can('project.transition', PROJECT),
  validate(dealLinkSchema),
  projectController.linkDeal,
);
router.post(
  '/:id/assign',
  authenticate,
  can('project.assign', PROJECT),
  validate(assignSchema),
  projectController.assign,
);
router.post(
  '/:id/approve',
  authenticate,
  can('project.approve', PROJECT),
  validate(approveSchema),
  projectController.approve,
);
router.post(
  '/:id/schedule',
  authenticate,
  can('project.schedule', PROJECT),
  validate(scheduleSchema),
  projectController.schedule,
);

// --- Versions ---
router.get(
  '/:id/versions',
  authenticate,
  can('project.view', PROJECT),
  projectController.getVersions,
);
router.post(
  '/:id/versions',
  authenticate,
  can('project.upload_version', PROJECT),
  validate(addVersionSchema),
  projectController.addVersion,
);
router.post(
  '/:id/versions/:versionId/files',
  authenticate,
  can('project.upload_version', PROJECT),
  upload.single('file'),
  projectController.uploadFile,
);
// Stream/download a stored version file (Range-aware for video seeking).
router.get(
  '/:id/versions/:versionId/files/:fileId',
  authenticate,
  can(null, PROJECT),
  fileStreamController.streamVersionFile,
);

// --- Inputs ---
router.get('/:id/inputs', authenticate, can('project.view', PROJECT), inputController.list);
router.post(
  '/:id/inputs',
  authenticate,
  can('project.transition', PROJECT),
  validate(inputSchema),
  inputController.create,
);
router.patch(
  '/:id/inputs/:inputId',
  authenticate,
  can('project.transition', PROJECT),
  validate(inputUpdateSchema),
  inputController.update,
);

// --- Comments ---
router.get('/:id/comments', authenticate, can('project.view', PROJECT), commentController.list);
router.post(
  '/:id/comments',
  authenticate,
  can('project.comment', PROJECT),
  validate(commentSchema),
  commentController.add,
);
router.patch(
  '/:id/comments/:commentId',
  authenticate,
  can('project.comment', PROJECT),
  commentController.resolve,
);

// --- Revisions ---
router.get('/:id/revisions', authenticate, can('project.view', PROJECT), revisionController.list);
router.post(
  '/:id/revisions',
  authenticate,
  can('project.revision', PROJECT),
  validate(revisionSchema),
  revisionController.request,
);
router.patch(
  '/:id/revisions/:revisionId',
  authenticate,
  can('project.revision', PROJECT),
  validate(revisionUpdateSchema),
  revisionController.update,
);

// --- Publications ---
router.get(
  '/:id/publications',
  authenticate,
  can('project.view', PROJECT),
  publicationController.list,
);
router.post(
  '/:id/publications',
  authenticate,
  can('project.publish', PROJECT),
  validate(publicationSchema),
  publicationController.record,
);

// --- Metrics ---
router.get('/:id/metrics', authenticate, can('project.view', PROJECT), metricsController.list);
router.post(
  '/:id/metrics',
  authenticate,
  can('project.metrics', PROJECT),
  validate(metricSchema),
  metricsController.record,
);

// --- Tasks (kanban) ---
router.get('/:id/tasks', authenticate, can('project.view', PROJECT), taskController.list);
router.post(
  '/:id/tasks',
  authenticate,
  can('task.create', PROJECT),
  validate(taskSchema),
  taskController.create,
);
router.get('/:id/tasks/:taskId', authenticate, can('project.view', PROJECT), taskController.get);
router.patch(
  '/:id/tasks/:taskId',
  authenticate,
  can('task.update', PROJECT),
  validate(taskUpdateSchema),
  taskController.update,
);
router.delete(
  '/:id/tasks/:taskId',
  authenticate,
  can('task.update', PROJECT),
  taskController.remove,
);
router.post(
  '/:id/tasks/:taskId/status',
  authenticate,
  can('task.update', PROJECT),
  validate(taskStatusSchema),
  taskController.setStatus,
);

// --- Brief ---
router.get('/:id/brief', authenticate, can('project.view', PROJECT), briefController.get);
router.put(
  '/:id/brief',
  authenticate,
  can('brief.manage', PROJECT),
  validate(briefSchema),
  briefController.upsert,
);

// --- Reviews (feedback lock + summary) ---
router.post(
  '/:id/reviews/summarize',
  authenticate,
  can('project.view', PROJECT),
  validate(reviewSummarizeSchema),
  reviewController.summarize,
);
router.post(
  '/:id/reviews/lock',
  authenticate,
  can('project.revision', PROJECT),
  validate(reviewLockSchema),
  reviewController.lock,
);

// --- Chat ---
router.get(
  '/:id/channels',
  authenticate,
  can('project.view', PROJECT),
  chatController.listChannels,
);
router.post(
  '/:id/channels',
  authenticate,
  can('chat.post', PROJECT),
  validate(channelSchema),
  chatController.createChannel,
);
router.get(
  '/:id/channels/:channelId/messages',
  authenticate,
  can('project.view', PROJECT),
  chatController.listMessages,
);
router.post(
  '/:id/channels/:channelId/messages',
  authenticate,
  can('chat.post', PROJECT),
  validate(messageSchema),
  chatController.postMessage,
);

// --- Activity ---
router.get('/:id/activity', authenticate, can('project.view', PROJECT), activityController.list);

module.exports = router;
