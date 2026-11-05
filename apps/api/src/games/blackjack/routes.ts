import type { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import { BJ_MARKETS, type BlackjackEntry } from '@socialplay/shared';
import { authenticate } from '../../middleware/auth.js';
import { ApiError } from '../../middleware/api-error.js';
import { createBlackjackService } from './service.js';
export async function blackjackRoutes(server: FastifyInstance) {
  const service = createBlackjackService(prisma);
  server.addHook('preHandler', authenticate);
  server.addHook('preHandler', async (_request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    if (process.env.BLACKJACK_PRACTICE_ENABLED !== 'true')
      throw ApiError.forbidden('Blackjack is currently unavailable');
  });
  server.get(
    '/',
    { config: { rateLimit: { max: 90, timeWindow: '1 minute' } } },
    async (request) => ({ success: true, data: await service.snapshot(request.user.sub) })
  );
  server.post<{ Body: BlackjackEntry }>(
    '/tickets',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['roundId', 'slot', 'stage', 'seat', 'market', 'amount', 'odds'],
          properties: {
            roundId: { type: 'string', minLength: 1, maxLength: 64 },
            slot: { type: 'integer', minimum: 1, maximum: 10 },
            market: { type: 'string', enum: [...BJ_MARKETS] },
            stage: { type: 'integer', minimum: 0, maximum: 2 },
            seat: { type: 'integer', minimum: 0, maximum: 6 },
            odds: { type: 'integer', minimum: 101, maximum: 20000 },
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
