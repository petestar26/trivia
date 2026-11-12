import { FastifyInstance } from 'fastify';
import { config } from '@socialplay/config';
import { authenticate, requirePermission } from '../middleware/index.js';
import { anonymousRateLimitKey } from '../plugins/rate-limit-identity.js';
import {
  activateAdminAgent,
  createAdminAgent,
  listPendingAgentAccounts,
  reissueAgentPassword,
  approveExistingMemberAgent,
} from './admin-account-service.js';
import type { StaffDatabase } from '../database/staff-database.js';
import type { CredentialDatabase } from '../auth/change-password.js';

export type AdminAgentAccountRouteOptions = {
  /** Restricted staff provisioning. Required: there is no default. */
  staffDb: StaffDatabase;
  /** Agent self-activation (member-facing credential write). */
  credentialDb: CredentialDatabase;
};

export async function adminAgentAccountRoutes(
  server: FastifyInstance,
  options: AdminAgentAccountRouteOptions
) {
  const { staffDb, credentialDb } = options ?? ({} as Partial<AdminAgentAccountRouteOptions>);
  if (!staffDb || !credentialDb) throw new Error('STAFF_DATABASE_REQUIRED');
  server.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'private, no-store');
    return payload;
  });
  server.post('/admin/accounts/existing', {
    preHandler: [authenticate, requirePermission('agent:create')],
    bodyLimit: 8192,
    config: { rateLimit: { hook: 'preHandler', max: 20, timeWindow: '1 minute', keyGenerator: request => `agent-existing:${request.user!.sub}` } },
  }, async (request, reply) => reply.status(201).send({ success: true, data: await approveExistingMemberAgent(staffDb, request.user!.sub, request.body) }));
  server.post(
    '/admin/accounts',
    {
      preHandler: [authenticate, requirePermission('agent:create')],
      bodyLimit: 8192,
      config: {
        rateLimit: {
          hook: 'preHandler',
          max: 20,
          timeWindow: '1 minute',
          keyGenerator: (request) => `agent-create:${request.user!.sub}`,
        },
      },
    },
    async (request, reply) =>
      reply
        .status(201)
        .send({ success: true, data: await createAdminAgent(staffDb, request.user!.sub, request.body) })
  );
  server.get(
    '/admin/accounts/pending',
    { preHandler: [authenticate, requirePermission('agent:create')] },
    async (request) => ({ success: true, data: await listPendingAgentAccounts(staffDb, request.user!.sub) })
  );
  server.post<{ Params: { userId: string } }>(
    '/admin/accounts/:userId/reissue',
    {
      preHandler: [authenticate, requirePermission('agent:create')],
      bodyLimit: 8192,
      config: {
        rateLimit: {
          hook: 'preHandler',
          max: 10,
          timeWindow: '15 minutes',
          keyGenerator: (request) => `agent-reissue:${request.user!.sub}`,
        },
      },
    },
    async (request) => ({
      success: true,
      data: await reissueAgentPassword(staffDb, request.user!.sub, request.params.userId, request.body),
    })
  );
  server.post(
    '/activate-account',
    {
      bodyLimit: 8192,
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '15 minutes',
          keyGenerator: (request) => anonymousRateLimitKey(request, config.WEB_GATEWAY_SECRET),
        },
      },
    },
    async (request) => ({ success: true, data: await activateAdminAgent(credentialDb, request.body) })
  );
}
