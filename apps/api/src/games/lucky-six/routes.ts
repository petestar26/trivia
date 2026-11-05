import type { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import { LS_MARKETS, type LuckySixEntry } from '@socialplay/shared';
import { authenticate } from '../../middleware/auth.js';
import { ApiError } from '../../middleware/api-error.js';
import { createLuckySixService } from './service.js';
export async function luckySixRoutes(server: FastifyInstance) {
  const service = createLuckySixService(prisma);
  server.addHook('preHandler', authenticate);
  server.addHook('preHandler', async (_request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    if (process.env.LUCKY_SIX_PRACTICE_ENABLED !== 'true')
      throw ApiError.forbidden('Lucky Six is currently unavailable');
  });
  server.get(
    '/',
    { config: { rateLimit: { max: 90, timeWindow: '1 minute' } } },
    async (request) => ({ success: true, data: await service.snapshot(request.user.sub) })
  );
  server.post<{ Body: LuckySixEntry }>(
    '/tickets',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['roundId', 'slot', 'market', 'picks', 'amount'],
          properties: {
            roundId: { type: 'string', minLength: 1, maxLength: 64 },
            slot: { type: 'integer', minimum: 1, maximum: 10 },
            market: { type: 'string', enum: [...LS_MARKETS] },
            picks: {
              type: 'array',
              minItems: 1,
              maxItems: 6,
              uniqueItems: true,
              items: { type: 'integer', minimum: 1, maximum: 48 },
            },
            amount: { type: 'integer', minimum: 5, maximum: 500, multipleOf: 5 },
          },
        },
      },
    },
    async (request) => ({
      success: true,
      data: await service.enter(request.user.sub, request.body),
    })
  );
}
