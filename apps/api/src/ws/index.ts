import { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import { config } from '@socialplay/config';
import { JwtPayload } from '@socialplay/shared';
import { createMessage, getGroupMembership } from '../realtime/chat-service.js';
import { prisma } from '@socialplay/database';
import { emitToGroup, setSocketServer } from '../realtime/broadcast.js';
import { createWorkDrain, WorkLease } from './work-drain.js';
import { WebSocketDrain } from './shutdown-adapter.js';
import { createSocketTransportOwner } from './transport-owner.js';
import { canWatchTogether } from '../games/play-together/events.js';

const GROUP_ROOM_PREFIX = 'group:';

interface SocketUser {
  id: string;
  role: string;
}

interface TypingPayload {
  groupId: string;
}

interface SendMessagePayload {
  groupId: string;
  content: string;
  replyToId?: string;
  clientRequestId?: string;
}

interface JoinGroupPayload {
  groupId: string;
}

export function registerWebSocket(server: FastifyInstance): WebSocketDrain {
  // Socket.IO defaults to appending a slash to its configured transport path.
  const transportPath = config.WS_PATH.replace(/\/$/, '') + '/';
  const transport = createSocketTransportOwner(server.server, transportPath);
  const work = createWorkDrain();
  const io = new Server(server.server, {
    path: config.WS_PATH,
    allowRequest: (_request, done) => done(null, !transport.stopping),
    cors: {
      origin: config.CORS_ORIGIN,
      credentials: config.CORS_CREDENTIALS,
    },
  });

  transport.attach(io);
  setSocketServer(io);

  // Authentication middleware — accept the access token from either
  // socket.handshake.auth.token (explicit) or the sp_access_token cookie
  // (sent automatically because the client uses withCredentials:true).
  io.use(async (socket, next) => {
    const lease = work.acquire();
    if (!lease) return next(new Error('SERVER_DRAINING'));
    try {
      let token: string | undefined =
        typeof socket.handshake.auth?.token === 'string'
          ? socket.handshake.auth.token
          : undefined;

      if (!token) {
        // Fall back to the httpOnly auth cookie carried in the handshake.
        const cookieHeader = socket.handshake.headers.cookie;
        if (typeof cookieHeader === 'string') {
          const match = cookieHeader
            .split(';')
            .map((c) => c.trim())
            .find((c) => c.startsWith('sp_access_token='));
          if (match) {
            token = match.split('=').slice(1).join('=');
          }
        }
      }

      if (!token) {
        return next(new Error('UNAUTHORIZED'));
      }

      const decoded = await server.jwt.verify<JwtPayload>(token, {
        allowedIss: config.JWT_ISSUER,
        allowedAud: config.JWT_AUDIENCE,
      });

      if (!Number.isFinite(decoded.exp) || decoded.exp! * 1000 <= Date.now()) throw new Error('UNAUTHORIZED');
      const currentUser = await prisma.user.findUnique({ where: { id: decoded.sub }, select: { status: true, tokenVersion: true } });
      if (currentUser?.status !== 'ACTIVE' || (currentUser.tokenVersion ?? 0) !== (decoded.tokenVersion ?? 0)) throw new Error('UNAUTHORIZED');
      socket.data.tokenVersion = decoded.tokenVersion ?? 0;
      socket.data.expiresAt = decoded.exp! * 1000;
      socket.data.user = {
        id: decoded.sub,
        role: Array.isArray(decoded.roles) ? decoded.roles.join(',') : 'USER',
      } as SocketUser;

      if (!work.accepting) return next(new Error('SERVER_DRAINING'));
      next();
    } catch (err) {
      next(new Error('UNAUTHORIZED'));
    } finally { lease.finish(); }
  });

  io.on('connection', (socket) => {
    if (!work.accepting) { socket.disconnect(true); return; }
    const user = socket.data.user as SocketUser;
    const queues = new Map<string, WorkLease[]>();
    // Keep the lease across Socket.IO's nextTick middleware-to-handler gap.
    function onWork(event: string, handler: (...args: any[]) => unknown) {
      queues.set(event, []);
      socket.on(event, (...args: any[]) => {
        const lease = queues.get(event)?.shift();
        if (!lease) return; // no authorized/admitted dispatch
        void Promise.resolve().then(() => handler(...args)).then(
          () => lease.finish(), () => lease.finish(true)
        );
      });
    }
    const expiryTimer = setTimeout(() => socket.disconnect(true), Math.min(2147483647, Math.max(0, socket.data.expiresAt - Date.now())));
    expiryTimer.unref();
    socket.use(async (packet, next) => {
      const lease = work.acquire();
      if (!lease) { next(new Error('SERVER_DRAINING')); return; }
      let handedOff = false;
      try {
        const actor = await prisma.user.findUnique({ where: { id: user.id }, select: { status: true, tokenVersion: true } });
        if (socket.data.expiresAt <= Date.now() || actor?.status !== 'ACTIVE' || (actor.tokenVersion ?? 0) !== socket.data.tokenVersion) throw new Error('UNAUTHORIZED');
        const queue = queues.get(packet[0]);
        if (queue && socket.connected) { queue.push(lease); handedOff = true; }
        next();
      } catch { socket.disconnect(true); next(new Error('UNAUTHORIZED')); }
      finally { if (!handedOff) lease.finish(); }
    });

    // Join user-specific room for private events (e.g. gift:received)
    const roomLease = work.acquire();
    if (!roomLease) { socket.disconnect(true); return; }
    void Promise.resolve().then(() => socket.join(`user:${user.id}`)).then(
      () => roomLease.finish(), () => roomLease.finish(true)
    );

    onWork(
      'together:watch',
      async (payload: { roundId: string }, ack?: (res: unknown) => void) => {
        try {
          if (!rateLimit(user.id, 'together-watch', 60))
            throw new SocketError('RATE_LIMITED', 'Too many subscriptions');
          validateGroupId(payload?.roundId);
          if (!(await canWatchTogether(prisma, user.id, payload.roundId)))
            throw new SocketError('FORBIDDEN', 'Round access is unavailable');
          await socket.join('together:' + payload.roundId);
          ack?.({ success: true, roundId: payload.roundId });
        } catch (error) {
          ack?.(socketError(error));
        }
      }
    );
    onWork('together:leave', async (payload: { roundId: string }) => {
      if (typeof payload?.roundId === 'string') await socket.leave('together:' + payload.roundId);
    });

    onWork('group:join', async (payload: JoinGroupPayload, ack?: (res: unknown) => void) => {
      try {
        if (socket.data.expiresAt <= Date.now()) { socket.disconnect(true); throw new Error('UNAUTHORIZED'); }
        await joinGroupRoom(socket, io, payload.groupId, user.id);
        ack?.({ success: true, groupId: payload.groupId });
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    onWork('group:leave', async (payload: JoinGroupPayload, ack?: (res: unknown) => void) => {
      try {
        validateGroupId(payload.groupId);
        await socket.leave(groupRoom(payload.groupId));
        ack?.({ success: true, groupId: payload.groupId });
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    onWork('message:send', async (payload: SendMessagePayload, ack?: (res: unknown) => void) => {
      try {
        if (!rateLimit(user.id, 'message', 30)) {
          throw new SocketError('RATE_LIMITED', 'Too many messages sent');
        }

        if (!payload || typeof payload.groupId !== 'string' || typeof payload.content !== 'string') {
          throw new SocketError('MESSAGE_INVALID', 'Invalid message payload');
        }

        await assertCanReceive(payload.groupId, user.id);
        if (socket.data.expiresAt <= Date.now()) { socket.disconnect(true); throw new Error('UNAUTHORIZED'); }
        const message = await createMessage({
          groupId: payload.groupId,
          userId: user.id,
          content: payload.content,
          replyToId: payload.replyToId,
          clientRequestId: payload.clientRequestId,
        });

        await emitToGroup(payload.groupId, 'message:created', message);

        ack?.({ success: true, data: message });
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    onWork('typing:start', async (payload: TypingPayload, ack?: (res: unknown) => void) => {
      try {
        if (!rateLimit(user.id, 'typing', 30)) {
          throw new SocketError('RATE_LIMITED', 'Too many typing events');
        }

        validateGroupId(payload.groupId);
        await assertCanReceive(payload.groupId, user.id);
        await emitToGroup(payload.groupId, 'typing:start', {
          groupId: payload.groupId,
          userId: user.id,
        }, socket.id);
        ack?.({ success: true });
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    onWork('typing:stop', async (payload: TypingPayload, ack?: (res: unknown) => void) => {
      try {
        if (!rateLimit(user.id, 'typing', 30)) {
          throw new SocketError('RATE_LIMITED', 'Too many typing events');
        }

        validateGroupId(payload.groupId);
        await assertCanReceive(payload.groupId, user.id);
        await emitToGroup(payload.groupId, 'typing:stop', {
          groupId: payload.groupId,
          userId: user.id,
        }, socket.id);
        ack?.({ success: true });
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    socket.on('disconnect', () => {
      clearTimeout(expiryTimer);
      // Only undispatched leases are cancelled. Active handlers keep their lease.
      for (const queue of queues.values()) for (const lease of queue.splice(0)) lease.finish();
    });
  });

  return {
    stopAdmission: () => { work.stop(); transport.stopAdmission(); },
    drain: deadlineMs => work.wait(deadlineMs),
    closeTransports: async deadlineMs => {
      if (work.accepting || work.pending) throw new Error('WEBSOCKET_NOT_DRAINED');
      await transport.prepare(deadlineMs);
      // Fastify closes HTTP after preClose; this is preparation, not final receipt.
    },
    finalizeTransports: deadlineMs => transport.finalize(deadlineMs),
  };
}

// Simple in-memory sliding-window rate limiter.
const rateBuckets: Record<string, number[]> = {};

function rateLimit(key: string, bucketName: string, max: number, windowMs: number = 60000): boolean {
  const bucketKey = `${bucketName}:${key}`;
  const now = Date.now();

  const windowStart = now - windowMs;
  const bucket = (rateBuckets[bucketKey] = (rateBuckets[bucketKey] ?? []).filter(
    (ts) => ts > windowStart
  ));

  if (bucket.length >= max) {
    return false;
  }

  bucket.push(now);
  return true;
}

async function joinGroupRoom(
  socket: any,
  io: Server,
  groupId: string,
  userId: string
): Promise<void> {
  validateGroupId(groupId);

  const currentUser = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
  if (currentUser?.status !== 'ACTIVE') throw new SocketError('FORBIDDEN', 'An active account is required');
  const membership = await getGroupMembership(groupId, userId);

  if (!membership || membership.status !== 'ACTIVE') {
    throw new SocketError('FORBIDDEN', 'You are not an active member of this group');
  }

  await socket.join(groupRoom(groupId));
}

// Re-checks ACTIVE membership server-side before granting access to group events.
async function assertCanReceive(groupId: string, userId: string): Promise<void> {
  validateGroupId(groupId);
  const currentUser = await prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
  if (currentUser?.status !== 'ACTIVE') throw new SocketError('FORBIDDEN', 'An active account is required');
  const membership = await getGroupMembership(groupId, userId);

  if (!membership || membership.status !== 'ACTIVE') {
    throw new SocketError('FORBIDDEN', 'You are not an active member of this group');
  }
}

function groupRoom(groupId: string): string {
  return `${GROUP_ROOM_PREFIX}${groupId}`;
}

function validateGroupId(groupId: string): void {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof groupId !== 'string' || !uuidRegex.test(groupId)) {
    throw new SocketError('MESSAGE_INVALID', 'Invalid group identifier');
  }
}

function socketError(err: unknown): { success: boolean; code: string; message: string } {
  if (err instanceof SocketError) {
    return { success: false, code: err.code, message: err.message };
  }

  if (isApiError(err) && err.statusCode) {
    return {
      success: false,
      code: mapHttpToErrorCode(err.statusCode),
      message: err.message,
    };
  }

  return {
    success: false,
    code: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
  };
}

function isApiError(err: unknown): err is { statusCode?: number; message: string } {
  return typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string';
}

function mapHttpToErrorCode(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return 'MESSAGE_INVALID';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'GROUP_NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'INTERNAL_ERROR';
  }
}

class SocketError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SocketError';
    this.code = code;
  }
}
