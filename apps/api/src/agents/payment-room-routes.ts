import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, ApiError } from '../middleware/index.js';
import {
  getPaymentRoom,
  getPaymentAttachment,
  postPaymentMessage,
} from './payment-room-service.js';

const params = z.object({
  kind: z.enum(['deposit', 'withdrawal']),
  id: z.string().uuid(),
  messageId: z.string().uuid().optional(),
});
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw ApiError.badRequest('Invalid payment order request');
  return result.data;
}
export async function paymentRoomRoutes(server: FastifyInstance) {
  server.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'private, no-store');
    return payload;
  });
  server.get('/:kind/:id', { preHandler: [authenticate] }, async (request) => {
    const p = parse(params, request.params),
      q = parse(z.object({ before: z.string().uuid().optional() }).strict(), request.query);
    return { success: true, data: await getPaymentRoom(request.user!.sub, p.kind, p.id, q.before) };
  });
  server.post(
    '/:kind/:id/messages',
    {
      preHandler: [authenticate],
      bodyLimit: 3 * 1024 * 1024,
      config: { rateLimit: { max: 30, timeWindow: '5 minutes' } },
    },
    async (request, reply) => {
      const p = parse(params, request.params),
        result = await postPaymentMessage(request.user!.sub, p.kind, p.id, request.body);
      return reply
        .status(result.idempotent ? 200 : 201)
        .send({ success: true, data: result.message });
    }
  );
  server.get(
    '/:kind/:id/attachments/:messageId',
    { preHandler: [authenticate], config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const p = parse(params, request.params),
        a = await getPaymentAttachment(request.user!.sub, p.kind, p.id, p.messageId!);
      const ext =
        a.attachmentMime === 'image/png'
          ? 'png'
          : a.attachmentMime === 'image/jpeg'
            ? 'jpg'
            : 'webp';
      return reply
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Content-Disposition', `attachment; filename="receipt.${ext}"`)
        .type(a.attachmentMime!)
        .send(a.attachmentBytes);
    }
  );
}
