/**
 * Concepts: propose / list / approve / decline.
 * All routes require auth + org membership; approve additionally creates the
 * real project so an approved concept flows straight into the pipeline.
 *
 * Deciding a concept (ADR-0019):
 *   approve / decline        need concept.review (reviewers; admins via '*')
 *   approve your OWN concept also needs concept.approve_own (admins only), so
 *                            a reviewer cannot propose-and-approve their way
 *                            to a project; a one-admin org is never blocked
 *   decline                  any open concept, including your own (withdraw)
 */
const express = require('express');
// mergeParams: the :organizationId lives on the MOUNT path in app.js, not on
// this router - without it req.params.organizationId is undefined here.
const router = express.Router({ mergeParams: true });
const Concept = require('../models/concept.model');
const Project = require('../models/project.model');
const Brief = require('../models/brief.model');
const bus = require('../events/hub');
const { authenticate, requireOrg } = require('../middleware/auth');
const { also, allows } = require('../modules/access/index.cts');
const logger = require('../utils/logger');

router.use(authenticate, requireOrg('organizationId'));

/** GET /organizations/:organizationId/concepts - open + decided, newest first. */
router.get('/', async (req, res, next) => {
  try {
    const concepts = await Concept.find({ organizationId: req.params.organizationId })
      .sort({ createdAt: -1 })
      .populate('proposer', 'name email')
      .lean();
    res.json({
      data: concepts.map((c) => ({
        id: String(c._id),
        title: c.title,
        description: c.description,
        type: c.type,
        status: c.status,
        proposer: c.proposer ? String(c.proposer._id || c.proposer) : null,
        proposerName: c.proposer && typeof c.proposer === 'object' ? c.proposer.name : null,
        approvedProjectId: c.approvedProjectId ? String(c.approvedProjectId) : null,
        createdAt: c.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** POST /organizations/:organizationId/concepts - propose a new idea. */
router.post('/', async (req, res, next) => {
  try {
    const { title, description, type } = req.body || {};
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: { message: 'Title is required' } });
    }
    if (!description || !String(description).trim()) {
      return res.status(400).json({ error: { message: 'Description is required' } });
    }
    const concept = await Concept.create({
      organizationId: req.params.organizationId,
      title: String(title).trim().slice(0, 140),
      description: String(description).trim().slice(0, 2000),
      type: ['New Concept', 'Experiment', 'Revision'].includes(type) ? type : 'New Concept',
      proposer: req.user._id,
    });
    res.status(201).json({ data: { id: String(concept._id), status: concept.status } });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /concepts/:conceptId/approve - convert a concept into a project in one
 * step: mark it approved, create the project (linked back via conceptId,
 * status "Concept approved") and pre-fill its creative brief from the concept
 * plus anything sent in the body:
 *   { brief: { goal, targetAudience, videoType, deliverables[], deadline,
 *              references[], brandGuidelines, specialInstructions },
 *     client, campaign }
 */
router.patch('/:conceptId/approve', also('concept.review'), async (req, res, next) => {
  try {
    const concept = await Concept.findOne({
      _id: req.params.conceptId,
      organizationId: req.params.organizationId,
    });
    if (!concept) return res.status(404).json({ error: { message: 'Concept not found' } });
    if (concept.status !== 'IDEA') {
      return res
        .status(409)
        .json({ error: { message: `Concept already ${concept.status.toLowerCase()}` } });
    }
    if (
      String(concept.proposer) === String(req.user._id) &&
      !allows(req.ctx.permissions, 'concept.approve_own')
    ) {
      return res.status(403).json({
        error: {
          code: 'self_approval_forbidden',
          message: 'Someone other than the proposer has to approve this concept',
        },
      });
    }
    const body = req.body || {};
    const b = body.brief && typeof body.brief === 'object' ? body.brief : {};
    const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const list = (v, max) =>
      Array.isArray(v)
        ? v
            .map((x) => str(x, max))
            .filter(Boolean)
            .slice(0, 30)
        : [];
    const deadline = b.deadline ? new Date(b.deadline) : null;
    if (deadline && Number.isNaN(deadline.getTime())) {
      return res
        .status(400)
        .json({
          error: { code: 'validation_error', message: 'brief.deadline is not a valid date' },
        });
    }
    const project = await Project.create({
      organizationId: concept.organizationId,
      title: concept.title,
      description: concept.description,
      type: concept.type,
      status: 'APPROVED_CONCEPT',
      creator: req.user._id,
      conceptId: concept._id,
      client: str(body.client, 200),
      campaign: str(body.campaign, 200),
    });
    const brief = await Brief.create({
      organizationId: concept.organizationId,
      projectId: project._id,
      goal: str(b.goal, 5000) || concept.description,
      targetAudience: str(b.targetAudience, 2000),
      videoType: str(b.videoType, 200) || concept.type,
      references: list(b.references, 2000),
      deliverables: list(b.deliverables, 500),
      deadline,
      brandGuidelines: str(b.brandGuidelines, 10000),
      specialInstructions: str(b.specialInstructions, 10000),
      submittedBy: req.user._id,
    });
    concept.status = 'APPROVED';
    concept.approvedProjectId = project._id;
    await concept.save();
    await bus
      .emitAsync('project.created', { projectId: project._id, actorId: req.user._id, project })
      .catch(() => {});
    logger.info(
      { conceptId: String(concept._id), projectId: String(project._id) },
      'concept approved -> project + brief created',
    );
    res.json({
      data: {
        id: String(concept._id),
        status: concept.status,
        projectId: String(project._id),
        briefId: String(brief._id),
      },
    });
  } catch (err) {
    next(err);
  }
});

/** PATCH /concepts/:conceptId/decline - mark declined (kept for record). */
router.patch('/:conceptId/decline', also('concept.review'), async (req, res, next) => {
  try {
    // Only open ideas can be declined: an approved concept already has a project.
    const concept = await Concept.findOneAndUpdate(
      { _id: req.params.conceptId, organizationId: req.params.organizationId, status: 'IDEA' },
      { status: 'DECLINED' },
      { new: true },
    );
    if (!concept) {
      const exists = await Concept.findOne({
        _id: req.params.conceptId,
        organizationId: req.params.organizationId,
      }).select('status');
      if (exists) {
        return res
          .status(409)
          .json({ error: { message: `Concept already ${exists.status.toLowerCase()}` } });
      }
      return res.status(404).json({ error: { message: 'Concept not found' } });
    }
    res.json({ data: { id: String(concept._id), status: concept.status } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
