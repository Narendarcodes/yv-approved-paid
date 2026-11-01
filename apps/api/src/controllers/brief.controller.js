const briefService = require('../services/brief.service');

async function get(req, res, next) {
  try {
    const { id } = req.params;
    const brief = await briefService.getBrief({ projectId: id, organizationId: req.ctx.orgId });
    res.json({ data: brief });
  } catch (err) {
    next(err);
  }
}

async function upsert(req, res, next) {
  try {
    const { id } = req.params;
    const brief = await briefService.upsertBrief({
      projectId: id,
      organizationId: req.ctx.orgId,
      submittedBy: req.user._id,
      fields: req.body,
    });
    res.json({ data: brief });
  } catch (err) {
    next(err);
  }
}

module.exports = { get, upsert };
