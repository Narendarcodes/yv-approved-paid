const Joi = require('joi');

const objectId = Joi.string().hex().length(24);

const connectChannelSchema = Joi.object({
  platform: Joi.string().valid('instagram', 'youtube', 'linkedin', 'x').required(),
  name: Joi.string().trim().max(120).allow(''),
  handle: Joi.string().trim().max(120).allow(''),
});

const startConnectSchema = Joi.object({
  platform: Joi.string().valid('instagram', 'youtube', 'linkedin', 'x').required(),
  identifier: Joi.string().valid('instagram', 'instagram-standalone', 'youtube', 'linkedin', 'linkedin-page', 'x').allow(''),
  name: Joi.string().trim().max(120).allow(''),
  handle: Joi.string().trim().max(120).allow(''),
});

const platformSettingsSchema = Joi.object({
  instagram: Joi.object({
    format: Joi.string().valid('post', 'reel', 'story'),
    collaborators: Joi.array().items(Joi.string().trim().max(60)).max(10),
  }).unknown(false),
  youtube: Joi.object({
    title: Joi.string().allow('').max(200),
    visibility: Joi.string().valid('public', 'unlisted', 'private'),
    madeForKids: Joi.boolean(),
    tags: Joi.array().items(Joi.string().trim().max(100)).max(50),
    thumbnailFileId: objectId.allow(null, ''),
  }).unknown(false),
  x: Joi.object({
    whoCanReply: Joi.string().valid('everyone', 'following', 'mentionedUsers', 'subscribers', 'verified'),
  }).unknown(false),
  linkedin: Joi.object({
    carousel: Joi.boolean(),
    carouselName: Joi.string().allow('').max(200),
  }).unknown(false),
});

const retrySchema = Joi.object({
  scheduledAt: Joi.date().iso().allow(null),
});

const schedulePostSchema = Joi.object({
  settings: platformSettingsSchema.default({}),
  projectId: objectId.required(),
  channelIds: Joi.array().items(objectId).min(1).max(10).required(),
  caption: Joi.string().max(5000).allow('').default(''),
  scheduledAt: Joi.date().iso().required(),
  fileId: objectId.allow(null, ''),
});

const rescheduleSchema = Joi.object({
  scheduledAt: Joi.date().iso().required(),
});

const markPublishedSchema = Joi.object({
  postUrl: Joi.string().uri({ scheme: ['http', 'https'] }).required(),
});

module.exports = { startConnectSchema, retrySchema, platformSettingsSchema, connectChannelSchema, schedulePostSchema, rescheduleSchema, markPublishedSchema };
