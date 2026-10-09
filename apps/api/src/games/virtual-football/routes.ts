import type { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import { authenticate } from '../../middleware/auth.js';
import { ApiError } from '../../middleware/api-error.js';
import { createFootballService } from './service.js';

/** Exact string match only: any other value, including "TRUE" or "1", fails closed. */
export const footballPracticeEnabled = () =>
  process.env.VIRTUAL_FOOTBALL_PRACTICE_ENABLED === 'true';

export async function footballRoutes(server: FastifyInstance) {
  const service = createFootballService(prisma);
  server.addHook('preHandler', authenticate);
  server.addHook('preHandler', async (_request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    if (!footballPracticeEnabled())
      throw ApiError.forbidden('Virtual Football practice is unavailable');
  });

  server.get<{ Querystring: { seasonNo?: number; weekNo?: number } }>(
    '/',
    {
      config: { rateLimit: { max: 90, timeWindow: '1 minute' } },
      schema: {
        querystring: {
          type: 'object',
          properties: {
            seasonNo: { type: 'integer', minimum: 1, maximum: 999999 },
            weekNo: { type: 'integer', minimum: 1, maximum: 38 },
          },
          dependencies: { seasonNo: ['weekNo'], weekNo: ['seasonNo'] },
        },
      },
    },
    async (request) => {
      const { seasonNo, weekNo } = request.query;
      return {
        success: true,
        data: await service.snapshot(
          request.user.sub,
          seasonNo !== undefined && weekNo !== undefined ? { seasonNo, weekNo } : undefined
        ),
      };
    }
  );

  // The body is validated strictly by parseTicketInput (unknown fields are refused, not
  // silently stripped), so the route schema only bounds the size and the top-level type.
  server.post<{ Body: unknown }>(
    '/tickets',
    {
      bodyLimit: 16 * 1024,
      config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
      schema: { body: { type: 'object' } },
    },
    async (request) => ({
      success: true,
      data: await service.admit(request.user.sub, request.body),
    })
  );
}
