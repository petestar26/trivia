import { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate } from '../middleware';
import {
  createAgentOrder,
  getAgentOrderById,
  listOwnAgentOrders,
  listOrdersForOwnAgent,
  submitOrderPayment,
  cancelAgentOrder,
  settleAgentOrder,
} from './order-service';

function requestContext(request: FastifyRequest) {
  return { ip: request.ip, userAgent: request.headers['user-agent'] };
}

export async function agentOrderRoutes(server: FastifyInstance): Promise<void> {
  const auth = [authenticate];

  // ── Customer ──────────────────────────────────────────────────

  server.post<{
    Body: { agentId: string; countryId: string; paymentAccountId: string; fiatAmount: number; idempotencyKey: string };
  }>(
    '/',
    { preHandler: auth },
    async (request, reply) => {
      const result = await createAgentOrder(request.user!.sub, request.body, requestContext(request));
      return reply.status(result.idempotent ? 200 : 201).send({ success: true, data: result.order });
    }
  );

  server.get('/me', { preHandler: auth }, async (request, reply) => {
    const orders = await listOwnAgentOrders(request.user!.sub);
    return reply.send({ success: true, data: orders });
  });

  server.get<{ Params: { id: string } }>('/:id', { preHandler: auth }, async (request, reply) => {
    const order = await getAgentOrderById(request.user!.sub, request.params.id);
    return reply.send({ success: true, data: order });
  });

  server.post<{ Params: { id: string } }>(
    '/:id/submit-payment',
    { preHandler: auth },
    async (request, reply) => {
      const result = await submitOrderPayment(request.user!.sub, request.params.id, requestContext(request));
      return reply.send({ success: true, data: result });
    }
  );

  server.post<{ Params: { id: string } }>(
    '/:id/cancel',
    { preHandler: auth },
    async (request, reply) => {
      const result = await cancelAgentOrder(request.user!.sub, request.params.id, requestContext(request));
      return reply.send({ success: true, data: result });
    }
  );

  // ── Agent ─────────────────────────────────────────────────────

  server.get('/agent/me', { preHandler: auth }, async (request, reply) => {
    const orders = await listOrdersForOwnAgent(request.user!.sub);
    return reply.send({ success: true, data: orders });
  });

  server.post<{ Params: { id: string } }>(
    '/:id/settle',
    { preHandler: auth },
    async (request, reply) => {
      const result = await settleAgentOrder(request.user!.sub, request.params.id, requestContext(request));
      return reply.send({ success: true, data: result });
    }
  );
}
