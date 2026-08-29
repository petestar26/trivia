import { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import { config } from '@socialplay/config';
import { JwtPayload } from '@socialplay/shared';
import { createMessage, getGroupMembership } from '../realtime/chat-service';

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
}

interface JoinGroupPayload {
  groupId: string;
}

export function registerWebSocket(server: FastifyInstance): void {
  const io = new Server(server.server, {
    path: config.WS_PATH,
    cors: {
      origin: config.CORS_ORIGIN,
      credentials: config.CORS_CREDENTIALS,
    },
  });

  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      const token =
        typeof socket.handshake.auth?.token === 'string'
          ? socket.handshake.auth.token
          : undefined;

      if (!token) {
        return next(new Error('UNAUTHORIZED'));
      }

      const decoded = await server.jwt.verify<JwtPayload>(token, {
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
      });

      socket.data.user = {
        id: decoded.sub,
        role: Array.isArray(decoded.roles) ? decoded.roles.join(',') : 'USER',
      } as SocketUser;

      next();
    } catch (err) {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user as SocketUser;

    socket.on('group:join', async (payload: JoinGroupPayload, ack?: (res: unknown) => void) => {
      try {
        await joinGroupRoom(socket, io, payload.groupId, user.id);
        ack?.({ success: true, groupId: payload.groupId });
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    socket.on('group:leave', (payload: JoinGroupPayload, ack?: (res: unknown) => void) => {
      try {
        validateGroupId(payload.groupId);
        socket.leave(groupRoom(payload.groupId));
        ack?.({ success: true, groupId: payload.groupId });
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    socket.on('message:send', async (payload: SendMessagePayload, ack?: (res: unknown) => void) => {
      try {
        if (!rateLimit(user.id, 'message', 30)) {
          throw new SocketError('RATE_LIMITED', 'Too many messages sent');
        }

        if (!payload || typeof payload.groupId !== 'string' || typeof payload.content !== 'string') {
          throw new SocketError('MESSAGE_INVALID', 'Invalid message payload');
        }

        const message = await createMessage({
          groupId: payload.groupId,
          userId: user.id,
          content: payload.content,
          replyToId: payload.replyToId,
        });

        io.to(groupRoom(payload.groupId)).emit('message:created', message);

        ack?.({ success: true, data: message });
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    socket.on('typing:start', async (payload: TypingPayload, ack?: (res: unknown) => void) => {
      try {
        if (!rateLimit(user.id, 'typing', 30)) {
          throw new SocketError('RATE_LIMITED', 'Too many typing events');
        }

        validateGroupId(payload.groupId);
        await assertCanReceive(groupRoom(payload.groupId), user.id);
        socket.to(groupRoom(payload.groupId)).emit('typing:start', {
          groupId: payload.groupId,
          userId: user.id,
        });
        ack?.({ success: true });
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    socket.on('typing:stop', async (payload: TypingPayload, ack?: (res: unknown) => void) => {
      try {
        if (!rateLimit(user.id, 'typing', 30)) {
          throw new SocketError('RATE_LIMITED', 'Too many typing events');
        }

        validateGroupId(payload.groupId);
        await assertCanReceive(groupRoom(payload.groupId), user.id);
        socket.to(groupRoom(payload.groupId)).emit('typing:stop', {
          groupId: payload.groupId,
          userId: user.id,
        });
        ack?.({ success: true });
      } catch (err) {
        ack?.(socketError(err));
      }
    });

    socket.on('disconnect', () => {
      // No persistence needed. Socket disconnect does not affect auth session.
    });
  });

  return;
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

  const membership = await getGroupMembership(groupId, userId);

  if (!membership || membership.status !== 'ACTIVE') {
    throw new SocketError('FORBIDDEN', 'You are not an active member of this group');
  }

  socket.join(groupRoom(groupId));
}

// Re-checks ACTIVE membership server-side before granting access to group events.
async function assertCanReceive(groupId: string, userId: string): Promise<void> {
  validateGroupId(groupId);
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
