import type { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import { ApiError, authenticate } from '../middleware';

// ─── Notifications ────────────────────────────────────────────────
//
// User-scoped notification inbox. Every route here is authenticated and
// every query/mutation is scoped to `request.user.sub` — a notification
// belonging to another user is treated as not found (404), never 403, so a
// caller can't distinguish "not yours" from "doesn't exist" (no existence
// oracle / IDOR surface). The `data` JSON column is returned as-is: every
// `notification.create()` call site in this codebase was audited to embed
// only IDs, names, amounts, and reasons — never a token, password, or
// other secret — so exposing it verbatim to the owning user is safe.

export async function notificationRoutes(server: FastifyInstance): Promise<void> {
  // List the caller's notifications, newest first. `meta.unreadCount` is
  // the caller's TOTAL unread count (not just this page), so a client can
  // render an accurate badge from the same request that populates the list.
  server.get<{ Querystring: { page?: number; limit?: number; unreadOnly?: boolean } }>(
    '/',
    {
      preHandler: [authenticate],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            unreadOnly: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => {
      const userId = request.user!.sub;
      const page = request.query.page ?? 1;
      const limit = request.query.limit ?? 20;
      const unreadOnly = request.query.unreadOnly ?? false;

      const where = unreadOnly ? { userId, isRead: false } : { userId };

      const [notifications, total, unreadCount] = await Promise.all([
        prisma.notification.findMany({
          where,
          // id DESC as a deterministic tie-breaker: createdAt alone can tie
          // (two rows created in the same millisecond), which would
          // otherwise make skip/take page boundaries non-reproducible.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.notification.count({ where }),
        prisma.notification.count({ where: { userId, isRead: false } }),
      ]);

      const totalPages = Math.ceil(total / limit);

      return {
        success: true,
        data: notifications,
        meta: {
          page,
          limit,
          total,
          totalPages,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
          unreadCount,
        },
      };
    }
  );

  // Mark one notification read. Idempotent: marking an already-read
  // notification again is a no-op success, not an error.
  server.patch<{ Params: { id: string } }>(
    '/:id/read',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request) => {
      const userId = request.user!.sub;
      const { id } = request.params;

      const notification = await prisma.notification.findUnique({ where: { id } });
      // A row that doesn't exist and a row that belongs to someone else
      // are both reported as 404 — the response must never let a caller
      // learn which one is true.
      if (!notification || notification.userId !== userId) {
        throw ApiError.notFound('Notification not found');
      }

      if (notification.isRead) {
        return { success: true, data: notification };
      }

      const updated = await prisma.notification.update({
        where: { id },
        data: { isRead: true, readAt: new Date() },
      });

      return { success: true, data: updated };
    }
  );

  // Mark every one of the caller's unread notifications read in one call.
  server.post(
    '/read-all',
    { preHandler: [authenticate] },
    async (request) => {
      const userId = request.user!.sub;
      const result = await prisma.notification.updateMany({
        where: { userId, isRead: false },
        data: { isRead: true, readAt: new Date() },
      });
      return { success: true, data: { updated: result.count } };
    }
  );
}
