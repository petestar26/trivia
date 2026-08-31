import { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate, requirePermission } from '../middleware';
import {
  openDispute,
  getDisputeById,
  listOpenDisputesForAdmin,
  claimDispute,
  resolveDispute,
  DisputeReason,
  DisputeResolutionValue,
} from './dispute-service';

function requestContext(request: FastifyRequest) {
  return { ip: request.ip, userAgent: request.headers['user-agent'] };
}

export async function agentDisputeRoutes(server: FastifyInstance): Promise<void> {
  const auth = [authenticate];
  const admin = [authenticate, requirePermission('agent:review')];

  server.post<{
    Body: { orderId: string; reason: DisputeReason; description: string; idempotencyKey: string };
  }>(
    '/',
    { preHandler: auth },
    async (request, reply) => {
      const result = await openDispute(request.user!.sub, request.body, requestContext(request));
      return reply.status(result.idempotent ? 200 : 201).send({ success: true, data: result.dispute });
    }
  );

  server.get('/pending', { preHandler: admin }, async (_request, reply) => {
    const disputes = await listOpenDisputesForAdmin();
    return reply.send({ success: true, data: disputes });
  });

  server.get<{ Params: { id: string } }>('/:id', { preHandler: auth }, async (request, reply) => {
    const dispute = await getDisputeById(request.user!.sub, request.params.id);
    return reply.send({ success: true, data: dispute });
  });

  server.post<{ Params: { id: string } }>('/:id/claim', { preHandler: admin }, async (request, reply) => {
    const result = await claimDispute(request.user!.sub, request.params.id, requestContext(request));
    return reply.send({ success: true, data: result });
  });

  server.post<{ Params: { id: string }; Body: { resolution: DisputeResolutionValue; resolutionNote: string } }>(
    '/:id/resolve',
    { preHandler: admin },
    async (request, reply) => {
      const result = await resolveDispute(
        request.user!.sub,
        request.params.id,
        request.body?.resolution,
        request.body?.resolutionNote,
        requestContext(request)
      );
      return reply.send({ success: true, data: result });
    }
  );
}
