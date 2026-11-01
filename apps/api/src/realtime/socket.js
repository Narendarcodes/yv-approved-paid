/**
 * Socket.IO real-time layer for yv. team chat.
 *
 * Protocol:
 *  - Browsers connect withCredentials and authenticate with the httpOnly
 *    accessToken cookie (allowlisted Origin only); other clients may send
 *    `auth: { token: <JWT> }`. Same access tokens as REST.
 *  - After connect, the client may `channel:join` / `channel:leave` any
 *    channel of a project in its organization (membership checked).
 *  - When a message is persisted via REST, chat.service emits `message:new`
 *    to that channel's room - everyone viewing the channel receives it live.
 *
 * Rooms are named `channel:<id>` so channels are isolated per project.
 */
const { Server } = require('socket.io');
const { verifyAccessToken } = require('../utils/tokens');
const access = require('../modules/access/index.cts');
const Channel = require('../models/channel.model');
const logger = require('../utils/logger');
const config = require('../config');

let io = null;

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function handshakeAuth(socket, next) {
  try {
    const explicit = socket.handshake.auth && socket.handshake.auth.token;
    let token = explicit ? String(explicit) : null;
    if (!token) {
      token = readCookie(socket.handshake.headers.cookie, config.cookies.names.access);
      const origin = socket.handshake.headers.origin;
      if (token && origin && !config.corsOrigin.includes(origin))
        return next(new Error('forbidden_origin'));
    }
    const payload = token && verifyAccessToken(token);
    if (!payload) return next(new Error('unauthorized'));
    socket.data.userId = String(payload.sub);
    next();
  } catch {
    next(new Error('unauthorized'));
  }
}

/** Initialize Socket.IO on the existing HTTP server. */
function initSocketServer(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: config.corsOrigin, credentials: true },
  });

  // --- Handshake authentication (ADR-0017) ---
  // Browsers: the httpOnly accessToken cookie (sent with the handshake when the
  // client connects withCredentials). Because WebSockets are not subject to
  // CORS, a cookie handshake is only accepted from an allowlisted Origin
  // (blocks cross-site WebSocket hijacking). Non-browser clients may pass an
  // access token in auth.token. Refresh tokens are never accepted here: an
  // expired session gets 'unauthorized', the client refreshes over REST
  // (POST /auth/refresh) and reconnects.
  io.use(handshakeAuth);

  io.on('connection', (socket) => {
    /** Join a channel room after verifying org membership. */
    socket.on('channel:join', async ({ channelId } = {}, ack) => {
      try {
        if (!channelId) return ack?.({ ok: false, error: 'channelId required' });
        // Tenant key on the channel itself (ADR-0015); non-members see not_found.
        const channel = await Channel.findById(channelId).select('organizationId').lean();
        if (!channel || !(await access.memberOf(socket.data.userId, channel.organizationId))) {
          return ack?.({ ok: false, error: 'not_found' });
        }
        await socket.join(`channel:${channelId}`);
        ack?.({ ok: true });
      } catch (err) {
        logger.warn({ err }, 'channel:join failed');
        ack?.({ ok: false, error: 'join_failed' });
      }
    });

    /** Join the org room (agent job updates / insights) after a membership check. */
    socket.on('org:join', async ({ organizationId } = {}, ack) => {
      try {
        if (!organizationId) return ack?.({ ok: false, error: 'organizationId required' });
        if (!(await access.memberOf(socket.data.userId, organizationId))) {
          return ack?.({ ok: false, error: 'not_found' });
        }
        await socket.join(`org:${organizationId}`);
        ack?.({ ok: true });
      } catch (err) {
        logger.warn({ err }, 'org:join failed');
        ack?.({ ok: false, error: 'join_failed' });
      }
    });

    socket.on('channel:leave', ({ channelId } = {}) => {
      if (channelId) socket.leave(`channel:${channelId}`);
    });

    socket.on('disconnect', () => {
      /* rooms auto-clean */
    });
  });

  return io;
}

/** Emit a freshly persisted message to its channel room. */
function emitMessage(projectId, channelId, message) {
  if (!io) return;
  io.to(`channel:${channelId}`).emit('message:new', {
    projectId: String(projectId),
    channelId: String(channelId),
    message: message.toObject ? message.toObject() : message,
  });
}

/** Emit an org-scoped event (e.g. agent `job:update`, `insight:new`). */
function emitToOrg(organizationId, event, data) {
  if (!io) return;
  io.to(`org:${organizationId}`).emit(event, data);
}

module.exports = { initSocketServer, emitMessage, emitToOrg, handshakeAuth };
