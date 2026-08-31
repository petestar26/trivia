import { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate, requirePermission, ApiError } from '../middleware';
import {
  submitAgentApplication,
  approveAgentApplication,
  rejectAgentApplication,
  suspendAgent,
  reactivateAgent,
  markAgentUnderReview,
  disableAgent,
  requireOwnAgent,
  getAgentApplicationHistory,
  listSubmittedApplications,
} from './agent-service';
import {
  createAgentPaymentAccount,
  updateAgentPaymentAccount,
  approveAgentPaymentAccount,
  rejectAgentPaymentAccount,
  disableOwnPaymentAccount,
  adminDisablePaymentAccount,
  listOwnPaymentAccounts,
  listPendingPaymentAccounts,
} from './payment-account-service';
import {
  fundAgentInventory,
  adjustAgentInventory,
  getAgentInventory,
  getAgentInventoryLedger,
} from './inventory-service';

// Fields returned for an agent's OWN payment accounts: everything except
// nothing is withheld from the owner, but accountDetails is still opaque
// JSON the client renders as-is — no reviewer-only fields are added here.
function requestContext(request: FastifyRequest) {
  return { ip: request.ip, userAgent: request.headers['user-agent'] };
}

export async function agentRoutes(server: FastifyInstance): Promise<void> {
  const auth = [authenticate];
  const admin = [authenticate, requirePermission('agent:review')];

  // ── Application ──────────────────────────────────────────────

  server.post<{
    Body: { countryId: string; displayName: string; contactEmail: string; contactPhone?: string };
  }>(
    '/applications',
    { preHandler: auth },
    async (request, reply) => {
      const result = await submitAgentApplication(
        request.user!.sub,
        request.body,
        requestContext(request)
      );
      return reply.status(201).send({ success: true, data: result });
    }
  );

  // Own application history — never another user's.
  server.get('/applications/me', { preHandler: auth }, async (request, reply) => {
    const agent = await requireOwnAgent(request.user!.sub);
    const history = await getAgentApplicationHistory(agent.id);
    return reply.send({ success: true, data: { agent, applications: history } });
  });

  // Admin queue — every application currently awaiting review.
  server.get('/applications/pending', { preHandler: admin }, async (_request, reply) => {
    const applications = await listSubmittedApplications();
    return reply.send({ success: true, data: applications });
  });

  server.post<{ Params: { id: string }; Body: { reviewNote?: string } }>(
    '/applications/:id/approve',
    { preHandler: admin },
    async (request, reply) => {
      const result = await approveAgentApplication(
        request.user!.sub,
        request.params.id,
        request.body?.reviewNote,
        requestContext(request)
      );
      return reply.send({ success: true, data: result });
    }
  );

  server.post<{ Params: { id: string }; Body: { reviewNote: string } }>(
    '/applications/:id/reject',
    { preHandler: admin },
    async (request, reply) => {
      const result = await rejectAgentApplication(
        request.user!.sub,
        request.params.id,
        request.body?.reviewNote,
        requestContext(request)
      );
      return reply.send({ success: true, data: result });
    }
  );

  // ── Agent profile / status ───────────────────────────────────

  server.get('/me', { preHandler: auth }, async (request, reply) => {
    const agent = await requireOwnAgent(request.user!.sub);
    return reply.send({ success: true, data: agent });
  });

  server.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/:id/suspend',
    { preHandler: admin },
    async (request, reply) => {
      const result = await suspendAgent(
        request.user!.sub,
        request.params.id,
        request.body?.reason,
        requestContext(request)
      );
      return reply.send({ success: true, data: result });
    }
  );

  server.post<{ Params: { id: string } }>(
    '/:id/reactivate',
    { preHandler: admin },
    async (request, reply) => {
      const result = await reactivateAgent(request.user!.sub, request.params.id, requestContext(request));
      return reply.send({ success: true, data: result });
    }
  );

  server.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/:id/under-review',
    { preHandler: admin },
    async (request, reply) => {
      const result = await markAgentUnderReview(
        request.user!.sub,
        request.params.id,
        request.body?.reason,
        requestContext(request)
      );
      return reply.send({ success: true, data: result });
    }
  );

  server.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/:id/disable',
    { preHandler: admin },
    async (request, reply) => {
      const result = await disableAgent(
        request.user!.sub,
        request.params.id,
        request.body?.reason,
        requestContext(request)
      );
      return reply.send({ success: true, data: result });
    }
  );

  // ── Payment accounts (self-service) ──────────────────────────

  server.get('/me/payment-accounts', { preHandler: auth }, async (request, reply) => {
    const agent = await requireOwnAgent(request.user!.sub);
    const accounts = await listOwnPaymentAccounts(agent.id);
    return reply.send({ success: true, data: accounts });
  });

  server.post<{
    Body: { countryId: string; methodDefId: string; accountDetails: unknown };
  }>(
    '/me/payment-accounts',
    { preHandler: auth },
    async (request, reply) => {
      const account = await createAgentPaymentAccount(
        request.user!.sub,
        request.body,
        requestContext(request)
      );
      return reply.status(201).send({ success: true, data: account });
    }
  );

  server.patch<{
    Params: { id: string };
    Body: { countryId: string; methodDefId: string; accountDetails: unknown };
  }>(
    '/me/payment-accounts/:id',
    { preHandler: auth },
    async (request, reply) => {
      const account = await updateAgentPaymentAccount(
        request.user!.sub,
        request.params.id,
        request.body,
        requestContext(request)
      );
      return reply.send({ success: true, data: account });
    }
  );

  server.post<{ Params: { id: string } }>(
    '/me/payment-accounts/:id/disable',
    { preHandler: auth },
    async (request, reply) => {
      const result = await disableOwnPaymentAccount(
        request.user!.sub,
        request.params.id,
        requestContext(request)
      );
      return reply.send({ success: true, data: result });
    }
  );

  // ── Payment accounts (admin review) ──────────────────────────

  server.get('/payment-accounts/pending', { preHandler: admin }, async (_request, reply) => {
    const accounts = await listPendingPaymentAccounts();
    return reply.send({ success: true, data: accounts });
  });

  server.post<{ Params: { id: string } }>(
    '/payment-accounts/:id/approve',
    { preHandler: admin },
    async (request, reply) => {
      const result = await approveAgentPaymentAccount(
        request.user!.sub,
        request.params.id,
        requestContext(request)
      );
      return reply.send({ success: true, data: result });
    }
  );

  server.post<{ Params: { id: string }; Body: { reviewNote: string } }>(
    '/payment-accounts/:id/reject',
    { preHandler: admin },
    async (request, reply) => {
      const result = await rejectAgentPaymentAccount(
        request.user!.sub,
        request.params.id,
        request.body?.reviewNote,
        requestContext(request)
      );
      return reply.send({ success: true, data: result });
    }
  );

  server.post<{ Params: { id: string } }>(
    '/payment-accounts/:id/admin-disable',
    { preHandler: admin },
    async (request, reply) => {
      const result = await adminDisablePaymentAccount(
        request.user!.sub,
        request.params.id,
        requestContext(request)
      );
      return reply.send({ success: true, data: result });
    }
  );

  // ── Inventory (self-service read + admin funding/adjustment) ──
  // Route-level gate is ADMIN or SUPER_ADMIN (as elsewhere); adjustAgentInventory
  // enforces the stricter SUPER_ADMIN-only requirement itself (Phase B
  // decision 6) — the route is not the security boundary here either.

  server.get('/me/inventory', { preHandler: auth }, async (request, reply) => {
    const agent = await requireOwnAgent(request.user!.sub);
    const inventory = await getAgentInventory(agent.id);
    return reply.send({ success: true, data: inventory });
  });

  server.get('/me/inventory/ledger', { preHandler: auth }, async (request, reply) => {
    const agent = await requireOwnAgent(request.user!.sub);
    const ledger = await getAgentInventoryLedger(agent.id);
    return reply.send({ success: true, data: ledger });
  });

  server.get<{ Params: { id: string } }>('/:id/inventory', { preHandler: admin }, async (request, reply) => {
    const inventory = await getAgentInventory(request.params.id);
    return reply.send({ success: true, data: inventory });
  });

  server.get<{ Params: { id: string } }>(
    '/:id/inventory/ledger',
    { preHandler: admin },
    async (request, reply) => {
      const ledger = await getAgentInventoryLedger(request.params.id);
      return reply.send({ success: true, data: ledger });
    }
  );

  server.post<{ Params: { id: string }; Body: { amount: number; idempotencyKey: string } }>(
    '/:id/inventory/fund',
    { preHandler: admin },
    async (request, reply) => {
      const result = await fundAgentInventory(
        request.user!.sub,
        request.params.id,
        request.body?.amount,
        request.body?.idempotencyKey,
        requestContext(request)
      );
      return reply.status(201).send({ success: true, data: result });
    }
  );

  server.post<{ Params: { id: string }; Body: { signedAmount: number; reason: string; idempotencyKey: string } }>(
    '/:id/inventory/adjust',
    { preHandler: admin },
    async (request, reply) => {
      const result = await adjustAgentInventory(
        request.user!.sub,
        request.params.id,
        request.body?.signedAmount,
        request.body?.reason,
        request.body?.idempotencyKey,
        requestContext(request)
      );
      return reply.send({ success: true, data: result });
    }
  );
}
