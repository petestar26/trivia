import type { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import { RK_MARKETS, type RouletteKenoEntry } from '@socialplay/shared';
import { authenticate } from '../../middleware/auth.js';
import { ApiError } from '../../middleware/api-error.js';
import { createRouletteKenoService } from './service.js';
export async function rouletteKenoRoutes(server: FastifyInstance) {
  const service = createRouletteKenoService(prisma);
  server.addHook('preHandler', authenticate);
  server.addHook('preHandler', async (_request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    if (process.env.ROULETTE_KENO_PRACTICE_ENABLED !== 'true')
      throw ApiError.forbidden('Roulette Keno is currently unavailable');
  });
  server.get(
    '/',
    { config: { rateLimit: { max: 90, timeWindow: '1 minute' } } },
    async (request) => ({ success: true, data: await service.snapshot(request.user.sub) })
  );
  server.post<{ Body: RouletteKenoEntry }>(
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
            market: { type: 'string', enum: [...RK_MARKETS] },
            picks: {
              type: 'array',
              minItems: 1,
              maxItems: 10,
              uniqueItems: true,
              items: { type: 'integer', minimum: 1, maximum: 72 },
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
