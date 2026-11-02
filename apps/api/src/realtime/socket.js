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
 *
 * Deals: `deal:join { dealId }` joins room `deal:<id>` only when the user is an
 * active member of the deal's org AND a party to the deal or holds deal.manage
 * there (the same rule as GET /deals/:dealId). Every ledger line appended for
 * that deal is pushed as `deal:ledger { dealId, entry }`. Anything else answers
 * `not_found`, whether the deal is missing or belongs to another org.
 */
const { Server } = require('socket.io');
const { verifyAccessToken } = require('../utils/tokens');
const access = require('../modules/access/index.cts');
const Channel = require('../models/channel.model');
const { onLedgerAppend } = require('../modules/deals/events.cts');
const logger = require('../utils/logger');
const config = require('../config');

let io = null;
let stopLedgerFeed = null;

/** May this user watch this deal's ledger? Same rule as GET /deals/:dealId; never says why not. */
async function canWatchDeal(userId, dealId) {
  if (typeof dealId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(dealId)) return false;
  const { dealService } = require('../modules/deals/service.cts');
  const { engine } = require('../modules/deals/engine.cts');
  let deal;
  try {
    deal = await dealService().get(dealId);
  } catch {
    return false;
  }
  const perms = await access.permissionsIn(userId, deal.orgId);
  if (!perms) return false;
  return !!engine.actorRole(deal, userId) || access.allows(perms, 'deal.manage');
}

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

    /** Join a deal room (live MoneyTimeline) after the org-access + party check. */
    socket.on('deal:join', async ({ dealId } = {}, ack) => {
      try {
        if (!(await canWatchDeal(socket.data.userId, dealId))) {
          return ack?.({ ok: false, error: 'not_found' });
        }
        await socket.join(`deal:${dealId}`);
        ack?.({ ok: true });
      } catch (err) {
        logger.warn({ err }, 'deal:join failed');
        ack?.({ ok: false, error: 'join_failed' });
      }
    });

    socket.on('deal:leave', ({ dealId } = {}) => {
      if (typeof dealId === 'string') socket.leave(`deal:${dealId}`);
    });

    socket.on('channel:leave', ({ channelId } = {}) => {
      if (channelId) socket.leave(`channel:${channelId}`);
    });

    socket.on('disconnect', () => {
      /* rooms auto-clean */
    });
  });

  // every ledger line goes to its deal's room (only sockets that passed deal:join are in it)
  if (stopLedgerFeed) stopLedgerFeed();
  stopLedgerFeed = onLedgerAppend((entry) =>
    emitToDeal(entry.dealId, 'deal:ledger', { dealId: entry.dealId, entry }),
  );

  return io;
}

/** Emit to the sockets watching one deal. */
function emitToDeal(dealId, event, data) {
  if (!io || !dealId) return;
  io.to(`deal:${dealId}`).emit(event, data);
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

module.exports = {
  initSocketServer,
  emitMessage,
  emitToOrg,
  emitToDeal,
  handshakeAuth,
  canWatchDeal,
};
