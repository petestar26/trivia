import type { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import { authenticate } from '../../middleware/auth.js';
import { ApiError } from '../../middleware/api-error.js';
import { createNumberService } from './service.js';

export async function numberPracticeRoutes(server: FastifyInstance) {
  const service = createNumberService(prisma);
  server.addHook('onRequest', async (_req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
  });
  server.addHook('preHandler', authenticate);
  server.addHook('preHandler', async () => {
    if (process.env.NUMBER_CHALLENGE_PRACTICE_ENABLED !== 'true')
      throw ApiError.forbidden('Number Challenge practice is unavailable.');
  });
  server.get('/', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => ({
    success: true,
    data: await service.snapshot(req.user.sub),
  }));
  server.post<{ Body: unknown }>(
    '/guesses',
    {
      bodyLimit: 1024,
      schema: { body: { type: 'object' } },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req) => ({ success: true, data: await service.play(req.user.sub, req.body) })
  );
}
