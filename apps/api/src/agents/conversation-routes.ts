import { FastifyInstance } from 'fastify';
import { authenticate, requirePermission } from '../middleware';
import {
  sendMessageAsAgent,
  sendMessageAsAdmin,
  getOwnConversation,
  getConversationForAgent,
  listMessages,
  listConversationsWithUnreadForAdmin,
} from './conversation-service';

export async function agentConversationRoutes(server: FastifyInstance): Promise<void> {
  const auth = [authenticate];
  const admin = [authenticate, requirePermission('agent:review')];

  // ── Agent (self-service) ─────────────────────────────────────

  server.get('/me', { preHandler: auth }, async (request, reply) => {
    const conversation = await getOwnConversation(request.user!.sub);
    return reply.send({ success: true, data: conversation });
  });

  server.post<{
    Body: { body: string; relatedOrderId?: string; relatedDisputeId?: string };
  }>(
    '/me/messages',
    { preHandler: auth },
    async (request, reply) => {
      const message = await sendMessageAsAgent(request.user!.sub, request.body);
      return reply.status(201).send({ success: true, data: message });
    }
  );

  // ── Shared read (agent own conversation, or any admin) ───────

  server.get<{ Params: { id: string }; Querystring: { cursor?: string; limit?: string } }>(
    '/:id/messages',
    { preHandler: auth },
    async (request, reply) => {
      const result = await listMessages(request.user!.sub, request.params.id, {
        cursor: request.query.cursor,
        limit: request.query.limit ? Number(request.query.limit) : undefined,
      });
      return reply.send({ success: true, data: result });
    }
  );

  // ── Admin ─────────────────────────────────────────────────────

  server.get('/admin/unread', { preHandler: admin }, async (_request, reply) => {
    const conversations = await listConversationsWithUnreadForAdmin();
    return reply.send({ success: true, data: conversations });
  });

  server.get<{ Params: { agentId: string } }>(
    '/admin/agent/:agentId',
    { preHandler: admin },
    async (request, reply) => {
      const conversation = await getConversationForAgent(request.user!.sub, request.params.agentId);
      return reply.send({ success: true, data: conversation });
    }
  );

  server.post<{
    Params: { agentId: string };
    Body: { body: string; relatedOrderId?: string; relatedDisputeId?: string };
  }>(
    '/admin/agent/:agentId/messages',
    { preHandler: admin },
    async (request, reply) => {
      const message = await sendMessageAsAdmin(request.user!.sub, request.params.agentId, request.body);
      return reply.status(201).send({ success: true, data: message });
    }
  );
}
