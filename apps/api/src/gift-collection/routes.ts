import type { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import type { GiftAction } from '@socialplay/shared';
import { authenticate } from '../middleware/auth.js';
import { ApiError } from '../middleware/api-error.js';
import { emitToGroup, emitToUser } from '../realtime/broadcast.js';
import { createGiftCollectionService } from './service.js';

export async function giftCollectionRoutes(server: FastifyInstance) {
  const service = createGiftCollectionService(prisma);
  server.addHook('preHandler', authenticate);
  server.addHook('preHandler', async (_request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    if (process.env.GIFT_COLLECTION_ENABLED !== 'true') throw ApiError.forbidden('The gift collection is not enabled yet');
  });
  server.get<{ Querystring: { groupId?: string; page?: number } }>('/', {
    schema: { querystring: { type: 'object', properties: {
      groupId: { type: 'string', format: 'uuid' }, page: { type: 'integer', minimum: 1, maximum: 100000 } } } },
    config: { rateLimit: { max: 90, timeWindow: '1 minute' } },
  }, async request => ({ success: true, data: await service.snapshot(request.query.groupId ?? null, request.user.sub, request.query.page) }));
  const common = { policyId: { type: 'string', maxLength: 80 }, kind: { type: 'string' } };
  const group = { groupId: { type: 'string', format: 'uuid' }, recipientId: { type: 'string', format: 'uuid' } };
  const owned = { itemId: { type: 'string', format: 'uuid' }, version: { type: 'integer', minimum: 0 } };
  const value = { type: 'integer', minimum: 10, maximum: 10000, multipleOf: 10 };
  // Separate routes avoid removeAdditional+oneOf silently stripping action fields.
  for (const kind of ['BUY', 'SEND', 'CONVERT'] as const) {
    const properties = kind === 'BUY' ? { ...common, ...group, groupId: { type: ['string','null'], format: 'uuid' }, catalogId: { type: 'string', maxLength: 64 }, faceValue: value }
      : kind === 'SEND' ? { ...common, ...group, ...owned } : { ...common, ...owned, faceValue: value };
    server.post<{ Body: GiftAction; Headers: { 'idempotency-key'?: string } }>(`/${kind.toLowerCase()}`, {
      schema: { body: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties: { ...properties, kind: { const: kind } } } },
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    }, async (request, reply) => {
      const result = await service.act(request.user.sub, request.headers['idempotency-key'] ?? '', request.body);
      if (!result.isReplay) {
        if (result.groupId && result.messageId) emitToGroup(result.groupId, 'message:created', { id: result.messageId });
        emitToUser(result.gift.recipientId, 'gift:received', { itemId: result.itemId });
      }
      return reply.code(result.isReplay ? 200 : 201).send({ success: true, data: result });
    });
  }
}
