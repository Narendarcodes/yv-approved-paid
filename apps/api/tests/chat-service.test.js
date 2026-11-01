/**
 * chat.service — channel creation behavior.
 *
 * Regression guard for the production outage where `createChannel` was
 * exported and called but never defined (ReferenceError at runtime, red
 * backend lint). Ported from postiz-absorption 7b9cb5e (the fix itself landed
 * in fix/launch-polish 1eb2cf0). These tests hit a real (in-memory) database and assert
 * persisted state — an undefined or non-saving implementation fails them.
 */
const mongoose = require('mongoose');
const chatService = require('../src/services/chat.service');
const Channel = require('../src/models/channel.model');
const Project = require('../src/models/project.model');
require('../src/models/user.model'); // listMessages populates author

describe('chat.service channels', () => {
  const orgId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    await require('../src/db/mongo').connect();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (global.__MONGOD__) await global.__MONGOD__.stop();
  });

  test('createChannel persists a channel with the given fields', async () => {
    const project = await Project.create({ organizationId: orgId, title: 'Chat Test' });
    const channel = await chatService.createChannel({
      projectId: project._id,
      organizationId: orgId,
      name: 'general',
      type: 'channel',
      members: [],
      createdBy: userId,
    });
    expect(channel._id).toBeTruthy();
    expect(channel.name).toBe('general');
    const found = await Channel.findById(channel._id);
    expect(found).not.toBeNull();
  });

  test('createChannel rejects an unknown project with 404', async () => {
    await expect(
      chatService.createChannel({
        projectId: new mongoose.Types.ObjectId(),
        organizationId: orgId,
        name: 'nope',
        createdBy: userId,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'project_not_found' });
  });

  test('postMessage persists a message and a threaded reply, listMessages filters by thread', async () => {
    const project = await Project.create({ organizationId: orgId, title: 'Chat Thread Test' });
    const channel = await chatService.createChannel({
      projectId: project._id,
      organizationId: orgId,
      name: 'feedback',
      createdBy: userId,
    });
    const root = await chatService.postMessage({
      projectId: project._id,
      organizationId: orgId,
      channelId: channel._id,
      author: userId,
      body: 'First cut is up',
    });
    await chatService.postMessage({
      projectId: project._id,
      organizationId: orgId,
      channelId: channel._id,
      author: userId,
      body: 'Looks good',
      parentId: root._id,
    });

    const top = await chatService.listMessages({
      projectId: project._id,
      organizationId: orgId,
      channelId: channel._id,
    });
    const topItems = top.items || top;
    expect(topItems.map((m) => m.body)).toEqual(['First cut is up']);

    const thread = await chatService.listMessages({
      projectId: project._id,
      organizationId: orgId,
      channelId: channel._id,
      parentId: root._id,
    });
    const threadItems = thread.items || thread;
    expect(threadItems.map((m) => m.body)).toEqual(['Looks good']);
  });

  test('a project from another organization is 404 (tenant scope, ADR-0015)', async () => {
    const project = await Project.create({ organizationId: orgId, title: 'Chat Other Org' });
    await expect(
      chatService.createChannel({
        projectId: project._id,
        organizationId: new mongoose.Types.ObjectId(),
        name: 'x',
        createdBy: userId,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'project_not_found' });
    const channel = await chatService.createChannel({
      projectId: project._id,
      organizationId: orgId,
      name: 'y',
      createdBy: userId,
    });
    expect(String(channel.organizationId)).toBe(String(orgId));
  });

  test('postMessage rejects a channel from another project with 404', async () => {
    const a = await Project.create({ organizationId: orgId, title: 'Chat A' });
    const b = await Project.create({ organizationId: orgId, title: 'Chat B' });
    const channelA = await chatService.createChannel({
      projectId: a._id,
      organizationId: orgId,
      name: 'a',
      createdBy: userId,
    });
    await expect(
      chatService.postMessage({
        projectId: b._id,
        organizationId: orgId,
        channelId: channelA._id,
        author: userId,
        body: 'x',
      }),
    ).rejects.toMatchObject({ status: 404, code: 'channel_not_found' });
  });
});
