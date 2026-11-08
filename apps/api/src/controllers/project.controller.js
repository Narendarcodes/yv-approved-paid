const projectService = require('../services/project.service');
const publicationService = require('../services/publication.service');
const stageGates = require('../services/stageGates.service');
const { allows } = require('../modules/access/index.cts');

async function create(req, res, next) {
  try {
    const { title, description, type, client, campaign } = req.body;
    const organizationId = req.ctx.orgId; // a membership the caller holds
    const project = await projectService.createProject({
      organizationId,
      title,
      description,
      type,
      client,
      campaign,
      creatorId: req.user._id,
    });
    res.status(201).json({ data: project });
  } catch (err) {
    next(err);
  }
}

async function list(req, res, next) {
  try {
    const organizationId = req.ctx.orgId; // a membership the caller holds
    const { status, assignee, search, limit, skip, sort } = req.query;
    const result = await projectService.listProjects({
      organizationId,
      status,
      assignee,
      search,
      limit: parseInt(limit, 10) || 50,
      skip: parseInt(skip, 10) || 0,
      sort,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
}

async function get(req, res, next) {
  try {
    const { id } = req.params;
    const organizationId = req.ctx.orgId; // from the project, never the request
    const project = await projectService.getProject({ projectId: id, organizationId });
    res.json({ data: project });
  } catch (err) {
    next(err);
  }
}

async function transition(req, res, next) {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const organizationId = req.ctx.orgId; // from the project, never the request
    const project = await projectService.transitionProject({
      projectId: id,
      organizationId,
      newStatus: status,
      actorId: req.user._id,
      permissions: req.ctx.permissions, // the edge's permission is checked in the service
    });
    res.json({ data: project });
  } catch (err) {
    next(err);
  }
}

async function assign(req, res, next) {
  try {
    const { id } = req.params;
    const { assigneeId } = req.body;
    const organizationId = req.ctx.orgId; // from the project, never the request
    const project = await projectService.assignProject({
      projectId: id,
      organizationId,
      assigneeId,
      actorId: req.user._id,
    });
    res.json({ data: project });
  } catch (err) {
    next(err);
  }
}

/** GET /projects/:id/gate - what the next move needs, as this caller sees it. */
async function gate(req, res, next) {
  try {
    const data = await stageGates.gateFor({
      projectId: req.params.id,
      organizationId: req.ctx.orgId,
      canApprove: allows(req.ctx.permissions || [], 'project.approve'),
    });
    res.json({ data });
  } catch (err) {
    next(err);
  }
}

/** PUT /projects/:id/deal - link (or unlink) the deal this project delivers. */
async function linkDeal(req, res, next) {
  try {
    const project = await projectService.linkDeal({
      projectId: req.params.id,
      organizationId: req.ctx.orgId,
      dealId: req.body.dealId || null,
      milestoneKey: req.body.milestoneKey || null,
    });
    res.json({ data: project });
  } catch (err) {
    next(err);
  }
}

async function getVersions(req, res, next) {
  try {
    const { id } = req.params;
    const organizationId = req.ctx.orgId; // from the project, never the request
    const { limit, skip } = req.query;
    const result = await projectService.getVersions({
      projectId: id,
      organizationId,
      limit: parseInt(limit, 10) || 100,
      skip: parseInt(skip, 10) || 0,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
}

async function addVersion(req, res, next) {
  try {
    const { id } = req.params;
    const organizationId = req.ctx.orgId; // from the project, never the request
    const { metadata, changeSummary } = req.body;
    const pv = await projectService.addVersion({
      projectId: id,
      organizationId,
      uploaderId: req.user._id,
      metadata,
      changeSummary,
    });
    res.status(201).json({ data: pv });
  } catch (err) {
    next(err);
  }
}

async function approve(req, res, next) {
  try {
    const { id } = req.params;
    const { versionId } = req.body;
    const organizationId = req.ctx.orgId; // from the project, never the request
    const project = await projectService.approveVersion({
      projectId: id,
      organizationId,
      versionId,
      approverId: req.user._id,
    });
    res.json({ data: project });
  } catch (err) {
    next(err);
  }
}

async function schedule(req, res, next) {
  try {
    const { id } = req.params;
    const { scheduledAt } = req.body;
    const organizationId = req.ctx.orgId; // from the project, never the request
    const project = await publicationService.scheduleProject({
      projectId: id,
      organizationId,
      scheduledAt,
      actorId: req.user._id,
    });
    res.json({ data: project });
  } catch (err) {
    next(err);
  }
}

async function uploadFile(req, res, next) {
  try {
    const { id, versionId } = req.params;
    const organizationId = req.ctx.orgId; // from the project, never the request
    if (!req.file)
      return res.status(400).json({ error: { code: 'no_file', message: 'No file provided' } });
    const version = await projectService.saveVersionFile({
      projectId: id,
      organizationId,
      versionId,
      fileBuffer: req.file.buffer,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      uploaderId: req.user._id,
    });
    res.status(201).json({ data: version });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  create,
  list,
  get,
  transition,
  assign,
  gate,
  linkDeal,
  getVersions,
  addVersion,
  approve,
  schedule,
  uploadFile,
};
