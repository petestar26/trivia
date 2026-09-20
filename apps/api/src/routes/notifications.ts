import type { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware/error-handler.js';
import { authenticate } from '../middleware/auth.js';

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

// Bound on `page`. The offset handed to Prisma is (page - 1) * limit, and
// Prisma's `skip` is a 32-bit Int: an unbounded page — e.g. 1e21, which is
// still a valid JSON integer and so satisfies ajv's `type: 'integer'` —
// overflows it and surfaces as a 500. Bounding page at the schema layer
// turns that into a 400 and keeps the worst-case offset at
// MAX_PAGE * MAX_LIMIT = 1e8, comfortably inside Int range.
const MAX_PAGE = 1_000_000;
const MAX_LIMIT = 100;

export async function notificationRoutes(server: FastifyInstance): Promise<void> {
  // Every response from this plugin carries Cache-Control: no-store. A
  // notification inbox is per-user private data served over a credentialed
  // request; with no cache directive it is heuristically cacheable and a
  // shared browser/proxy cache can retain it past logout. This is an
  // onSend hook at plugin scope rather than a per-route `onSend` option so
  // it also covers replies that never reach a handler: 401 from the
  // authenticate preHandler, 400 from schema validation, and anything the
  // error handler produces.
  server.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

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
            page: { type: 'integer', minimum: 1, maximum: MAX_PAGE, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: 20 },
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

      // The schema bounds above are the protection; with page <= MAX_PAGE
      // and limit <= MAX_LIMIT the worst case here is 99,999,900, well
      // inside Int range. A second runtime check was tried and removed: it
      // was unreachable by construction (ajv rejects anything that could
      // overflow before the handler runs), so it was untestable dead code.
      const skip = (page - 1) * limit;

      const where = unreadOnly ? { userId, isRead: false } : { userId };

      const [notifications, total, unreadCount] = await Promise.all([
        prisma.notification.findMany({
          where,
          // id DESC as a deterministic tie-breaker: createdAt alone can tie
          // (two rows created in the same millisecond), which would
          // otherwise make skip/take page boundaries non-reproducible.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip,
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
