import { FastifyInstance } from 'fastify';
import { ApiError, authenticate } from '../middleware';
import { listActiveGifts, sendGift, getGiftTransactions } from '../economy/gift-service';
import { emitToUser } from '../realtime/broadcast';

export async function giftRoutes(server: FastifyInstance): Promise<void> {
  // GET /gifts — list active gifts (catalog)
  server.get(
    '/',
    {
      preHandler: [authenticate],
    },
    async (_request, reply) => {
      const gifts = await listActiveGifts();

      return reply.send({
        success: true,
        data: gifts,
      });
    }
  );

  // POST /gifts/send — send a gift
  server.post<{
    Body: { recipientId: string; giftId: string; quantity?: number };
    Headers: { 'idempotency-key'?: string };
  }>(
    '/send',
    {
      preHandler: [authenticate],
      rateLimit: { max: 20, timeWindow: '1 minute' },
      schema: {
        body: {
          type: 'object',
          required: ['recipientId', 'giftId'],
          properties: {
            recipientId: { type: 'string', format: 'uuid' },
            giftId: { type: 'string', format: 'uuid' },
            quantity: { type: 'integer', minimum: 1, maximum: 100, default: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { recipientId, giftId, quantity = 1 } = request.body;
      const idempotencyKey = (request.headers as any)['idempotency-key'] as string | undefined;

      const result = await sendGift({
        senderId: request.user!.sub,
        recipientId,
        giftId,
        quantity,
        idempotencyKey,
      });

      // Emit realtime event after successful commit
      emitToUser(recipientId, 'gift:received', {
        giftId: result.giftId,
        giftName: result.giftName,
        senderId: request.user!.sub,
        quantity: result.quantity,
        totalGamePoints: result.totalGamePoints,
        createdAt: result.createdAt,
      });

      return reply.status(201).send({
        success: true,
        data: result,
      });
    }
  );

  // GET /gifts/transactions — gift transaction history
  server.get<{
    Querystring: { page?: number; limit?: number; role?: 'sender' | 'recipient' };
  }>(
    '/transactions',
    {
      preHandler: [authenticate],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            role: { type: 'string', enum: ['sender', 'recipient'] },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await getGiftTransactions(request.user!.sub, {
        page: request.query.page ?? 1,
        limit: request.query.limit ?? 20,
        role: request.query.role,
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
}
