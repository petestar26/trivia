import { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import { ApiError, authenticate } from '../middleware';
import { listActiveGames, ensureGameDefinitions } from '../games/game-catalog';
import { playGame, getGameHistory } from '../games/game-play';

export async function gameRoutes(server: FastifyInstance): Promise<void> {
  // GET /games — list active games (public catalog)
  server.get(
    '/',
    { preHandler: [authenticate] },
    async (_request, reply) => {
      const games = await listActiveGames();
      return reply.send({ success: true, data: games });
    }
  );

  // POST /games/:gameKey/play — play a game (server-authoritative)
  server.post<{
    Params: { gameKey: string };
    Body: { betAmount: number; guess?: number; questionId?: string; answerIndex?: number };
    Headers: { 'idempotency-key'?: string };
  }>(
    '/:gameKey/play',
    {
      preHandler: [authenticate],
      rateLimit: { max: 30, timeWindow: '1 minute' },
      schema: {
        params: {
          type: 'object',
          required: ['gameKey'],
          properties: { gameKey: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['betAmount'],
          properties: {
            betAmount: { type: 'integer', minimum: 1 },
            guess: { type: 'integer' },
            questionId: { type: 'string' },
            answerIndex: { type: 'integer' },
          },
        },
      },
    },
    async (request, reply) => {
      const { gameKey } = request.params;
      const { betAmount, guess, questionId, answerIndex } = request.body;
      const idempotencyKey = (request.headers as any)['idempotency-key'] as string | undefined;

      const result = await playGame({
        userId: request.user!.sub,
        gameKey,
        betAmount,
        idempotencyKey,
        clientData: { guess, questionId, answerIndex },
      });

      return reply.status(201).send({ success: true, data: result });
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
  server.get(
    '/questions',
    { preHandler: [authenticate] },
    async (_request, reply) => {
      const questions = await prisma.triviaQuestion.findMany({
        where: { isActive: true },
        select: {
          id: true,
          question: true,
          choices: true,
          category: true,
          difficulty: true,
        },
        take: 20,
      });
      return reply.send({ success: true, data: questions });
    }
  );
}
