const commentService = require('../services/comment.service');

async function list(req, res, next) {
  try {
    const { id } = req.params;
    const { versionId } = req.query;
    const comments = await commentService.listComments({
      projectId: id,
      organizationId: req.ctx.orgId,
      versionId,
    });
    res.json({ data: comments });
  } catch (err) {
    next(err);
  }
}

async function add(req, res, next) {
  try {
    const { id } = req.params;
    const { versionId, parentId, body, timecode } = req.body;
    const comment = await commentService.addComment({
      projectId: id,
      organizationId: req.ctx.orgId,
      versionId: versionId || null,
      parentId: parentId || null,
      author: req.user._id,
      body,
      timecode: typeof timecode === 'number' ? timecode : null,
    });
    res.status(201).json({ data: comment });
  } catch (err) {
    next(err);
  }
}

async function resolve(req, res, next) {
  try {
    const { id, commentId } = req.params;
    const { resolved } = req.body;
    const comment = await commentService.resolveComment({
      projectId: id,
      organizationId: req.ctx.orgId,
      commentId,
      resolved: resolved !== undefined ? resolved : true,
    });
    res.json({ data: comment });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, add, resolve };
