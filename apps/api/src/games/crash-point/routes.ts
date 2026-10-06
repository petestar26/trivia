import type { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import { authenticate } from '../../middleware/auth.js';
import { ApiError } from '../../middleware/api-error.js';
import { createCrashPointService } from './service.js';
export async function crashPointRoutes(server: FastifyInstance) {
  const service = createCrashPointService(prisma);
  server.addHook('preHandler', authenticate);
  server.addHook('preHandler', async (_request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    if (process.env.CRASH_POINT_PRACTICE_ENABLED !== 'true')
      throw ApiError.forbidden('Crash Point practice is unavailable');
  });
  server.get(
    '/',
    { config: { rateLimit: { max: 150, timeWindow: '1 minute' } } },
    async (request) => ({ success: true, data: await service.snapshot(request.user.sub) })
  );
  server.get(
    '/leaderboard',
    { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } },
    async (request) => ({ success: true, data: await service.leaderboard(request.user.sub) })
  );
  const roundId = { type: 'string', minLength: 1, maxLength: 64 };
  server.get<{ Querystring: { roundId: string } }>(
    '/activity',
    {
      config: { rateLimit: { max: 40, timeWindow: '1 minute' } },
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['roundId'],
          properties: { roundId },
        },
      },
    },
    async (request) => ({
      success: true,
      data: await service.activity(request.user.sub, request.query.roundId),
    })
  );
  server.post<{
    Body: { roundId: string; stake: number; autoCents: number | null; slot?: number };
  }>(
    '/tickets',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['roundId', 'stake', 'autoCents'],
          properties: {
            roundId,
            slot: { type: 'integer', minimum: 1, maximum: 2 },
            stake: { type: 'integer', minimum: 10, maximum: 500 },
            autoCents: {
              anyOf: [{ type: 'null' }, { type: 'integer', minimum: 101, maximum: 2000 }],
            },
          },
        },
      },
    },
    async (request) => ({
      success: true,
      data: await service.enter(
        request.user.sub,
        request.body.roundId,
        request.body.stake,
        request.body.autoCents,
        request.body.slot ?? 1
      ),
    })
  );
  server.post<{ Body: { roundId: string; slot?: number } }>(
    '/cashout',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['roundId'],
          properties: { roundId, slot: { type: 'integer', minimum: 1, maximum: 2 } },
        },
      },
    },
    async (request) => ({
      success: true,
      data: await service.cashout(request.user.sub, request.body.roundId, request.body.slot ?? 1),
    })
  );
}
