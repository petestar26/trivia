import type { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import {
  TOGETHER_GAMES,
  type TogetherGame,
  type TogetherCurrency,
  type TogetherSettings,
} from '@socialplay/shared';
import { authenticate, requireRole } from '../../middleware/auth.js';
import {
  createTogetherService,
  type CreateTogetherRound,
  type ConfirmTogetherEntry,
} from './service.js';

const game = { type: 'string', enum: TOGETHER_GAMES.map((g) => g.key) };
const currency = { type: 'string', enum: ['GAME_POINTS', 'ETB'] };
const id = { type: 'string', format: 'uuid' };
export async function togetherRoutes(server: FastifyInstance) {
  const service = createTogetherService(prisma);
  server.addHook('preHandler', authenticate);
  server.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
  });
  const params = {
    type: 'object',
    required: ['roundId'],
    properties: { roundId: id, entryId: id },
  };
  const rate = { rateLimit: { max: 30, timeWindow: '1 minute' } };
  const admin = { preHandler: requireRole('ADMIN', 'SUPER_ADMIN'), config: rate };
  server.get<{ Querystring: { groupId?: string } }>(
    '/',
    {
      schema: {
        querystring: { type: 'object', additionalProperties: false, properties: { groupId: id } },
      },
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (request) => ({
      success: true,
      data: await service.lobby(request.user.sub, request.query.groupId),
    })
  );
  server.post<{ Body: CreateTogetherRound }>(
    '/rounds',
    {
      config: rate,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: [
            'groupId',
            'game',
            'currency',
            'entryAmount',
            'minPlayers',
            'maxPlayers',
            'lobbySeconds',
            'requestId',
          ],
          properties: {
            groupId: id,
            requestId: id,
            game,
            currency,
            entryAmount: { type: 'integer', minimum: 100, maximum: 100000, multipleOf: 100 },
            minPlayers: { type: 'integer', minimum: 2, maximum: 20 },
            maxPlayers: { type: 'integer', minimum: 2, maximum: 20 },
            lobbySeconds: { type: 'integer', enum: [120, 300, 600] },
          },
        },
      },
    },
    async (request) => ({
      success: true,
      data: { roundId: await service.create(request.user.sub, request.body) },
    })
  );
  server.get<{ Params: { groupId: string } }>(
    '/groups/:groupId/activity',
    {
      schema: {
        params: { type: 'object', required: ['groupId'], properties: { groupId: id } },
      },
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (request) => ({
      success: true,
      data: await service.activity(request.user.sub, request.params.groupId),
    })
  );
  server.post<{ Body: { game: TogetherGame; currency: TogetherCurrency } }>(
    '/public',
    {
      config: rate,
      schema: {
        body: {
          type: 'object',
          required: ['game', 'currency'],
          additionalProperties: false,
          properties: { game, currency },
        },
      },
    },
    async (request) => ({
      success: true,
      data: {
        roundId: await service.openPublic(
          request.user.sub,
          request.body.game,
          request.body.currency
        ),
      },
    })
  );
  server.post(
    '/practice-points',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request) => ({ success: true, data: await service.refillPractice(request.user.sub) })
  );
  server.get<{ Params: { roundId: string } }>(
    '/rounds/:roundId',
    {
      schema: { params },
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (request) => ({
      success: true,
      data: await service.snapshot(request.user.sub, request.params.roundId),
    })
  );
  server.post<{ Params: { roundId: string }; Body: ConfirmTogetherEntry }>(
    '/rounds/:roundId/entries',
    {
      config: rate,
      schema: {
        params,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['requestId', 'termsHash', 'selection'],
          properties: {
            requestId: id,
            termsHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            selection: {
              type: 'array',
              maxItems: 6,
              items: { type: 'integer', minimum: 0, maximum: 2000 },
            },
          },
        },
      },
    },
    async (request) => ({
      success: true,
      data: await service.enter(request.user.sub, request.params.roundId, request.body),
    })
  );
  server.post<{ Params: { roundId: string; entryId: string } }>(
    '/rounds/:roundId/entries/:entryId/refund',
    {
      schema: { params: { ...params, required: ['roundId', 'entryId'] } },
      config: { ...rate, allowOwnFundsReturn: true },
    },
    async (request) => {
      await service.withdraw(request.user.sub, request.params.roundId, request.params.entryId);
      return { success: true, data: { refunded: true } };
    }
  );
  server.post<{ Params: { roundId: string } }>(
    '/rounds/:roundId/cancel',
    { schema: { params }, config: rate },
    async (request) => {
      await service.cancel(request.user.sub, request.params.roundId);
      return { success: true, data: { cancelled: true } };
    }
  );
  server.get('/admin/settings', admin, async (request) => ({
    success: true,
    data: await service.settings(request.user.sub),
  }));
  server.put<{ Body: TogetherSettings }>(
    '/admin/settings',
    {
      ...admin,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: [
            'version',
            'feeBps',
            'minEntry',
            'maxEntry',
            'enabledGames',
            'practiceEnabled',
            'cashEnabled',
            'publicRoomsEnabled',
          ],
          properties: {
            version: { type: 'integer', minimum: 1 },
            feeBps: { type: 'integer', minimum: 0, maximum: 2000 },
            minEntry: { type: 'integer', minimum: 100, maximum: 100000, multipleOf: 100 },
            maxEntry: { type: 'integer', minimum: 100, maximum: 100000, multipleOf: 100 },
            enabledGames: {
              type: 'array',
              minItems: 1,
              maxItems: 12,
              uniqueItems: true,
              items: game,
            },
            practiceEnabled: { type: 'boolean' },
            cashEnabled: { type: 'boolean' },
            publicRoomsEnabled: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => ({
      success: true,
      data: await service.settings(request.user.sub, request.body),
    })
  );
  server.get('/admin/rounds', admin, async (request) => ({
    success: true,
    data: await service.operations(request.user.sub),
  }));
  server.get('/admin/health', admin, async () => ({ success: true, data: await service.health() }));
  server.post<{ Params: { roundId: string } }>(
    '/admin/rounds/:roundId/retry',
    { ...admin, schema: { params } },
    async (request) => {
      await service.settings(request.user.sub);
      await service.recover(request.params.roundId);
      return { success: true, data: { processed: true } };
    }
  );
}
