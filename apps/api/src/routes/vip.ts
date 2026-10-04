import { FastifyInstance } from 'fastify';
import { authenticate } from '../middleware/index.js';
import { getVip } from '../vip/vip-service.js';

export async function vipRoutes(server: FastifyInstance): Promise<void> {
  // GET /vip — read-only VIP status for the authenticated user
  server.get(
    '/',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const vip = await getVip(request.user!.sub);
      return reply.send({ success: true, data: vip });
    }
  );
}
