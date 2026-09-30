import type { FastifyInstance } from 'fastify';
import type {} from '@fastify/jwt';
import type {} from '@fastify/rate-limit';
import type { RoundDatabase } from './round-store.js';
import { authenticate } from '../../middleware/auth.js';
import { practiceSnapshot, PracticeError, submitPracticeTicket } from './practice-service.js';

export function registerPracticeRoutes(server: FastifyInstance, db: RoundDatabase) {
  server.get(
    '/scheduled/spin-win',
    {
      preHandler: [authenticate],
      config: { rateLimit: { max: 90, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      try {
        return { success: true, data: await practiceSnapshot(db, request.user.sub) };
      } catch (error) {
        if (error instanceof PracticeError)
          return reply
            .code(error.statusCode)
            .send({
              success: false,
              error: { code: 'PRACTICE_UNAVAILABLE', message: error.message },
            });
        throw error;
      }
    }
  );
  server.post<{ Body: { roundId: string; bets: unknown } }>(
    '/scheduled/spin-win/tickets',
    {
      preHandler: [authenticate],
      config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['roundId', 'bets'],
          additionalProperties: false,
          properties: {
            roundId: { type: 'string', maxLength: 64 },
            bets: {
              type: 'array',
              minItems: 1,
              maxItems: 52,
              items: {
                type: 'object',
                required: ['marketId', 'amount'],
                additionalProperties: false,
                properties: {
                  marketId: { type: 'string', maxLength: 16 },
                  amount: { type: 'integer', minimum: 40, maximum: 480 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      try {
        const data = await submitPracticeTicket(
          db,
          request.user.sub,
          request.body.roundId,
          request.body.bets
        );
        return reply.code(data.isReplay ? 200 : 201).send({ success: true, data });
      } catch (error) {
        if (error instanceof PracticeError)
          return reply
            .code(error.statusCode)
            .send({
              success: false,
              error: { code: 'PRACTICE_ENTRY_REJECTED', message: error.message },
            });
        throw error;
      }
    }
  );
}
