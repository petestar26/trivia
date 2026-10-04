import type { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import { authenticate } from '../middleware/index.js';
import { listActiveGames } from '../games/game-catalog.js';
import { registerPublicProofRoutes } from '../games/scheduled/public-proof-routes.js';
import { registerPracticeRoutes } from '../games/scheduled/practice-routes.js';
import { prismaRoundDatabase } from '../games/scheduled/prisma-round-store.js';
import { playGame, getGameHistory } from '../games/game-play.js';

export async function gameRoutes(server: FastifyInstance): Promise<void> {
  registerPracticeRoutes(server, prismaRoundDatabase(prisma));
  registerPublicProofRoutes(server, prisma);

  // GET /games — public catalog (READ-ONLY: no writes happen here).
  // Returns the full catalog (mode, family, status, currencies, versions)
  // excluding RETIRED games.
  server.get(
    '/',
    { preHandler: [authenticate] },
    async (_request, reply) => {
      const games = await listActiveGames();
      return reply.send({ success: true, data: games });
    }
  );

  // POST /games/:gameKey/play — play a game (server-authoritative).
  // Idempotency key is REQUIRED (validated 1-128 visible ASCII chars),
  // enforced both by the AJV header schema and by the service.
  server.post<{
    Params: { gameKey: string };
    Body: { betAmount?: number; guess?: number; questionId?: string; answerIndex?: number; bets?: Array<{ marketId: string; amount: number }> };
    Headers: { 'idempotency-key': string };
  }>(
    '/:gameKey/play',
    {
      preHandler: [authenticate],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        params: {
          type: 'object',
          required: ['gameKey'],
          properties: { gameKey: { type: 'string' } },
        },
        headers: {
          type: 'object',
          required: ['idempotency-key'],
          properties: {
            'idempotency-key': {
              type: 'string',
              minLength: 1,
              maxLength: 128,
              pattern: '^[\\x21-\\x7E]+$',
            },
          },
        },
        body: {
          type: 'object',
          properties: {
            betAmount: { type: 'integer', minimum: 1 },
            guess: { type: 'integer' },
            questionId: { type: 'string' },
            answerIndex: { type: 'integer' },
            bets: {
              type: 'array', minItems: 1, maxItems: 52,
              items: { type: 'object', required: ['marketId', 'amount'], additionalProperties: false,
                properties: { marketId: { type: 'string', maxLength: 32 }, amount: { type: 'integer', minimum: 1, maximum: 1000000 } } },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { gameKey } = request.params;
      const { betAmount, guess, questionId, answerIndex, bets } = request.body;
      const idempotencyKey = request.headers['idempotency-key'];

      const result = await playGame({
        userId: request.user!.sub,
        gameKey,
        betAmount,
        idempotencyKey,
        clientData: { guess, questionId, answerIndex, bets },
      });

      return reply
        .status(result.isReplay ? 200 : 201)
        .send({ success: true, data: result });
    }
  );

  // GET /games/history — user's own game history (IDOR-protected)
  server.get<{
    Querystring: { page?: number; limit?: number; game?: string };
  }>(
    '/history',
    {
      preHandler: [authenticate],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            game: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await getGameHistory(request.user!.sub, {
        page: request.query.page ?? 1,
        limit: request.query.limit ?? 20,
        gameKey: request.query.game,
      });

      return reply.send({
        success: true,
        data: result.data,
        meta: {
          page: result.page,
          total: result.total,
          totalPages: result.totalPages,
        },
      });
    }
  );

  // GET /games/questions — trivia questions (for trivia game selection)
  server.get<{
    Querystring: { resumeQuestionId?: string };
  }>(
    '/questions',
    {
      preHandler: [authenticate],
      schema: {
        querystring: {
          type: 'object',
          properties: { resumeQuestionId: { type: 'string', maxLength: 64 } },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.sub;
      const questions = await prisma.triviaQuestion.findMany({
        // Don't offer a question this player has already answered. The play
        // transaction remains the authoritative one-attempt enforcement.
        where: { isActive: true, attempts: { none: { userId } } },
        select: {
          id: true,
          question: true,
          choices: true,
          category: true,
          difficulty: true,
        },
        take: 20,
      });

      // A lost response may leave a durable play request for a question that
      // is now in the user's attempt table. Return that active question only
      // for the exact id the authenticated client is resuming; never include
      // its answer key.
      const resumeQuestionId = request.query.resumeQuestionId;
      if (resumeQuestionId && !questions.some((question) => question.id === resumeQuestionId)) {
        const resumeQuestion = await prisma.triviaQuestion.findFirst({
          where: { id: resumeQuestionId, isActive: true },
          select: {
            id: true,
            question: true,
            choices: true,
            category: true,
            difficulty: true,
          },
        });
        if (resumeQuestion) questions.unshift(resumeQuestion);
      }

      return reply.send({ success: true, data: questions });
    }
  );
}
