const scheduling = require('../services/scheduling.service');

const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (err) {
    next(err);
  }
};

const org = (req) => req.params.organizationId;
const actor = (req) => req.user._id;

module.exports = {
  status: wrap(async (req, res) => res.json({ data: scheduling.getStatus() })),
  listChannels: wrap(async (req, res) => res.json({ data: await scheduling.listChannels(org(req)) })),
  connectChannel: wrap(async (req, res) => {
    const ch = await scheduling.connectDemoChannel({ organizationId: org(req), ...req.body, actorId: actor(req) });
    res.status(201).json({ data: ch });
  }),
  startConnect: wrap(async (req, res) =>
    res.json({ data: await scheduling.startConnect({ organizationId: org(req), ...req.body, actorId: actor(req) }) })
  ),
  reconnect: wrap(async (req, res) =>
    res.json({ data: await scheduling.startConnect({ organizationId: org(req), channelId: req.params.channelId, actorId: actor(req) }) })
  ),
  completeConnect: wrap(async (req, res) =>
    res.json({ data: await scheduling.completeConnect({ organizationId: org(req), actorId: actor(req) }) })
  ),
  checkConnection: wrap(async (req, res) => res.json({ data: await scheduling.checkConnection(org(req)) })),
  suggestTime: wrap(async (req, res) => {
    const channelIds = String(req.query.channelIds || '').split(',').filter(Boolean);
    res.json({ data: await scheduling.suggestTime({ organizationId: org(req), channelIds, after: req.query.after }) });
  }),
  retry: wrap(async (req, res) =>
    res.json({
      data: await scheduling.retryPost({
        organizationId: org(req),
        publicationId: req.params.postId,
        scheduledAt: req.body && req.body.scheduledAt,
        actorId: actor(req),
      }),
    })
  ),
  listPostizIntegrations: wrap(async (req, res) => res.json({ data: await scheduling.listPostizIntegrations() })),
  importPostizChannels: wrap(async (req, res) =>
    res.json({ data: await scheduling.importPostizChannels({ organizationId: org(req), actorId: actor(req) }) })
  ),
  disconnectChannel: wrap(async (req, res) =>
    res.json({ data: await scheduling.disconnectChannel({ organizationId: org(req), channelId: req.params.channelId }) })
  ),
  eligible: wrap(async (req, res) => res.json({ data: await scheduling.listEligibleProjects(org(req)) })),
  listPosts: wrap(async (req, res) => {
    const { from, to, projectId } = req.query;
    res.json({ data: await scheduling.listPosts({ organizationId: org(req), from, to, projectId }) });
  }),
  schedule: wrap(async (req, res) => {
    const posts = await scheduling.schedulePost({ organizationId: org(req), ...req.body, actorId: actor(req) });
    res.status(201).json({ data: posts });
  }),
  reschedule: wrap(async (req, res) =>
    res.json({
      data: await scheduling.reschedulePost({
        organizationId: org(req),
        publicationId: req.params.postId,
        scheduledAt: req.body.scheduledAt,
        actorId: actor(req),
      }),
    })
  ),
  cancel: wrap(async (req, res) =>
    res.json({ data: await scheduling.cancelPost({ organizationId: org(req), publicationId: req.params.postId, actorId: actor(req) }) })
  ),
  publishNow: wrap(async (req, res) =>
    res.json({ data: await scheduling.publishNow({ organizationId: org(req), publicationId: req.params.postId, actorId: actor(req) }) })
  ),
  markPublished: wrap(async (req, res) =>
    res.json({
      data: await scheduling.markPublishedManually({
        organizationId: org(req),
        publicationId: req.params.postId,
        postUrl: req.body.postUrl,
        actorId: actor(req),
      }),
    })
  ),
  syncMetrics: wrap(async (req, res) =>
    res.json({ data: await scheduling.syncMetrics({ organizationId: org(req), publicationId: req.params.postId }) })
  ),
};
