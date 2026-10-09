import type { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import { DERBY_MARKETS } from '@socialplay/shared';
import { authenticate } from '../../middleware/auth.js';
import { ApiError } from '../../middleware/api-error.js';
import { createDerbyService } from './service.js';
export async function derbyRoutes(server: FastifyInstance) {
  const service = createDerbyService(prisma);
  server.addHook('preHandler', authenticate);
  server.addHook('preHandler', async (_request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    if (process.env.THUNDER_DERBY_PRACTICE_ENABLED !== 'true')
      throw ApiError.forbidden('Thunder Derby practice is unavailable');
  });
  server.get<{ Querystring: { field: number } }>(
    '/',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['field'],
          properties: { field: { type: 'integer', enum: [6, 8] } },
        },
      },
    },
    async (request) => ({
      success: true,
      data: await service.snapshot(request.user.sub, request.query.field as 6 | 8),
    })
  );
  server.post<{
    Body: { roundId: string; field: number; market: string; picks: number[]; stake: number };
  }>(
    '/tickets',
    {
      config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['roundId', 'field', 'market', 'picks', 'stake'],
          properties: {
            roundId: { type: 'string', minLength: 1, maxLength: 64 },
            field: { type: 'integer', enum: [6, 8] },
            market: { type: 'string', enum: [...DERBY_MARKETS] },
            picks: {
              type: 'array',
              maxItems: 3,
              uniqueItems: true,
              items: { type: 'integer', minimum: 1, maximum: 8 },
            },
            stake: { type: 'integer', minimum: 10, maximum: 500 },
          },
        },
      },
    },
    async (request) => ({
      success: true,
      data: await service.enter(
        request.user.sub,
        request.body.roundId,
        request.body.field,
        request.body.market,
        request.body.picks,
        request.body.stake
      ),
    })
  );
}
