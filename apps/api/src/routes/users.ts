import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '@socialplay/database';
import { authenticate, ApiError } from '../middleware';
import { emailSchema } from '@socialplay/shared';

// ─── LIKE-escaping helper ──────────────────────────────────────
// PostgreSQL LIKE treats _ and % as wildcards. Before using a
// user-supplied prefix in a LIKE pattern, these must be escaped
// with a backslash so they match literally.
function escapeLikeLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

const USERNAME_RE = /^[A-Za-z0-9_]{3,30}$/;

export async function userRoutes(server: FastifyInstance): Promise<void> {
  // ── POST /search ──────────────────────────────────────────────
  //
  // Privacy-safe recipient search. Rate-limited per authenticated user
  // (10 req/min). Cache-Control: no-store on all responses.
  //
  // Hook execution order (verified via @fastify/rate-limit v9.1.0
  // addRouteRateHook): the plugin's onRoute handler pushes the rate
  // limit handler to the END of the preHandler array — so:
  //
  //   1. authenticate (sets request.user)
  //   2. rate limit keyGenerator reads request.user!.sub
  //   3. handler
  //
  server.post(
    '/search',
    {
      preHandler: [authenticate],
      config: {
        rateLimit: {
          hook: 'preHandler',
          max: 10,
          timeWindow: '1 minute',
          keyGenerator: (request: FastifyRequest) =>
            `user-search:${request.user!.sub}`,
        },
      },
      onSend: async (request: FastifyRequest, reply: FastifyReply) => {
        reply.header('Cache-Control', 'no-store');
      },
    },
    async (request, reply) => {
      const callerId = request.user!.sub as string;

      // ── Active caller gate ──────────────────────────────────
      const caller = await prisma.user.findUnique({
        where: { id: callerId },
        select: { status: true },
      });
      if (!caller || caller.status !== 'ACTIVE') {
        throw ApiError.forbidden('Account is not active');
      }

      // ── Body validation ────────────────────────────────────
      // Strict: exactly one key "q" which must be a string of
      // raw length 1–255. Unknown properties rejected. Trimmed
      // after raw-length validation; whitespace-only is rejected.
      const body = request.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw ApiError.badRequest('Invalid search request');
      }
      const keys = Object.keys(body);
      if (keys.length !== 1 || keys[0] !== 'q') {
        if (keys.length === 0) {
          throw ApiError.badRequest('Search query is required');
        }
        throw ApiError.badRequest('Invalid search request');
      }
      if (typeof body.q !== 'string') {
        throw ApiError.badRequest('Invalid search request');
      }
      if (body.q.length < 1 || body.q.length > 255) {
        throw ApiError.badRequest('Search query is required');
      }
      const trimmed = body.q.trim();
      if (trimmed.length === 0) {
        throw ApiError.badRequest('Search query is required');
      }

      // ── Match classification ───────────────────────────────
      if (trimmed.includes('@')) {
        // ── EMAIL MODE ───────────────────────────────────────
        // Validate using the shared email schema. Perform exact
        // stored email equality (case-sensitive, no prefix match,
        // no fallback to username). Return zero or one result.
        let validEmail: string;
        try {
          validEmail = emailSchema.parse(trimmed);
        } catch {
          throw ApiError.badRequest('Invalid search request');
        }

        const emailUser = await prisma.user.findFirst({
          where: { email: validEmail, status: 'ACTIVE', id: { not: callerId } },
          select: { id: true, username: true, displayName: true, avatarUrl: true },
        });

        return reply.send({ success: true, data: emailUser ? [emailUser] : [] });
      }

      // ── USERNAME MODE ──────────────────────────────────────
      // Validate format, then exact match first, prefix match
      // second. All comparisons case-sensitive. Max 10 results.
      if (!USERNAME_RE.test(trimmed)) {
        throw ApiError.badRequest(
          'Username search must be 3-30 letters, numbers, or underscores'
        );
      }

      // Exact match (one result max).
      const exactUser = await prisma.user.findFirst({
        where: { username: trimmed, status: 'ACTIVE', id: { not: callerId } },
        select: { id: true, username: true, displayName: true, avatarUrl: true },
      });

      // Prefix match — exclude caller + exact result, ordered
      // username ASC, id ASC. Take remaining capacity up to 10.
      const excludeIds = exactUser ? [exactUser.id, callerId] : [callerId];
      const remainingSlots = exactUser ? 9 : 10;
      const escapedPrefix = escapeLikeLiteral(trimmed);

      const prefixRows = await prisma.$queryRaw<
        { id: string; username: string; displayName: string | null; avatarUrl: string | null }[]
      >`
        SELECT "id", "username", "displayName", "avatarUrl"
        FROM "users"
        WHERE "status" = 'ACTIVE'
          AND "username" LIKE ${escapedPrefix + '%'} ESCAPE '\\'
        ORDER BY "username" ASC, "id" ASC
        LIMIT ${remainingSlots + excludeIds.length}
      `;

      // Filter out excluded IDs in JS (avoids complex array params in SQL).
      const prefixFiltered = prefixRows
        .filter((r) => !excludeIds.includes(r.id))
        .slice(0, remainingSlots);

      const results = exactUser ? [exactUser, ...prefixFiltered] : prefixFiltered;

      return reply.send({ success: true, data: results });
    }
  );
}
