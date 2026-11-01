const Channel = require('../models/channel.model');
const ChatMessage = require('../models/chatMessage.model');
const Project = require('../models/project.model');
const bus = require('../events/hub');

// Tenant scope (ADR-0015): the project must belong to the caller's org. The
// route already resolved organizationId from the project (modules/access);
// this is the data-seam check so a service is safe on its own too.
async function assertProject(projectId, organizationId) {
  if (!organizationId)
    throw { status: 500, code: 'missing_tenant', message: 'organizationId is required' };
  const project = await Project.findOne({ _id: projectId, organizationId });
  if (!project) throw { status: 404, code: 'project_not_found', message: 'Project not found' };
  return project;
}

async function assertChannel(projectId, organizationId, channelId) {
  const channel = await Channel.findOne({ _id: channelId, organizationId, projectId });
  if (!channel) throw { status: 404, code: 'channel_not_found', message: 'Channel not found' };
  return channel;
}

async function listChannels({ projectId, organizationId }) {
  await assertProject(projectId, organizationId);
  return Channel.find({ organizationId, projectId }).sort({ createdAt: 1 });
}

async function createChannel({
  projectId,
  organizationId,
  name,
  type = 'channel',
  members = [],
  createdBy,
}) {
  await assertProject(projectId, organizationId);
  const channel = new Channel({ organizationId, projectId, name, type, members, createdBy });
  await channel.save();
  await bus.emitAsync('channel.created', { projectId, channel, actorId: createdBy });
  return channel;
}

async function listMessages({
  projectId,
  organizationId,
  channelId,
  parentId = null,
  limit = 100,
  skip = 0,
}) {
  await assertProject(projectId, organizationId);
  await assertChannel(projectId, organizationId, channelId);
  const q = { organizationId, channelId, parentId: parentId || null };
  const [items, total] = await Promise.all([
    ChatMessage.find(q)
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .populate('author', 'name email'),
    ChatMessage.countDocuments(q),
  ]);
  return { items, total, limit, skip };
}

async function postMessage({
  projectId,
  organizationId,
  channelId,
  author,
  body,
  parentId = null,
  attachments = [],
}) {
  await assertProject(projectId, organizationId);
  await assertChannel(projectId, organizationId, channelId);
  if (parentId) {
    const parent = await ChatMessage.findOne({ _id: parentId, organizationId, channelId });
    if (!parent)
      throw { status: 404, code: 'parent_not_found', message: 'Parent message not found' };
  }
  const message = new ChatMessage({
    organizationId,
    channelId,
    projectId,
    author,
    body,
    parentId,
    attachments,
  });
  await message.save();
  await bus.emitAsync('chat.message_sent', { projectId, channelId, message, author });
  // Real-time fan-out to everyone viewing this channel.
  require('../realtime/socket').emitMessage(projectId, channelId, message);
  return message;
}

module.exports = { listChannels, createChannel, listMessages, postMessage };
