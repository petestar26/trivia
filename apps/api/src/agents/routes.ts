import { prisma } from '@socialplay/database';
import { z } from 'zod';
import { getAgentFiatLiquidity, fundAgentFiatLiquidity, adjustAgentFiatLiquidity } from '../withdrawals/liquidity-service.js';
import { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate, requirePermission, ApiError } from '../middleware/index.js';
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
} from './agent-service.js';
import {
  createAgentPaymentAccount,
  updateAgentPaymentAccount,
  approveAgentPaymentAccount,
  rejectAgentPaymentAccount,
  disableOwnPaymentAccount,
  adminDisablePaymentAccount,
  listOwnPaymentAccounts,
  listPendingPaymentAccounts,
} from './payment-account-service.js';
import {
  fundAgentInventory,
  adjustAgentInventory,
  getAgentInventory,
  getAgentInventoryLedger,
} from './inventory-service.js';

// Fields returned for an agent's OWN payment accounts: everything except
// nothing is withheld from the owner, but accountDetails is still opaque
// JSON the client renders as-is — no reviewer-only fields are added here.
function requestContext(request: FastifyRequest) {
  return { ip: request.ip, userAgent: request.headers['user-agent'] };
}

export async function agentRoutes(server: FastifyInstance): Promise<void> {
  const auth = [authenticate];
  const admin = [authenticate, requirePermission('agent:review')];

  server.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'private, no-store');
    return payload;
  });
  const liquiditySchema = z.object({
    fiatCurrency: z.string().regex(/^[A-Z]{3}$/),
    amountMinor: z.string().regex(/^-?[1-9]\d{0,15}$/),
    idempotencyKey: z.string().min(8).max(120),
    reason: z.string().trim().min(5).max(500).optional(),
  }).strict();
  server.get<{ Params: { id: string; currency: string } }>('/:id/liquidity/:currency', { preHandler: admin }, async request => {
    const value = await getAgentFiatLiquidity(request.params.id, request.params.currency);
    return { success: true, data: JSON.parse(JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v)) };
  });
  for (const mode of ['fund', 'adjust'] as const) {
    server.post<{ Params: { id: string } }>(`/:id/liquidity/${mode}`, { preHandler: admin }, async request => {
      const parsed = liquiditySchema.safeParse(request.body);
      if (!parsed.success) throw ApiError.badRequest('Currency, integer minor-unit amount and idempotency key are required');
      const b = parsed.data;
      if (mode === 'adjust' && !b.reason) throw ApiError.badRequest('Adjustment reason is required');
      const amount = BigInt(b.amountMinor);
      const value = mode === 'fund'
        ? await fundAgentFiatLiquidity(request.user!.sub, request.params.id, b.fiatCurrency, amount, b.idempotencyKey, requestContext(request))
        : await adjustAgentFiatLiquidity(request.user!.sub, request.params.id, b.fiatCurrency, amount, b.reason!, b.idempotencyKey, requestContext(request));
      return { success: true, data: JSON.parse(JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v)) };
    });
  }

  server.get('/me/setup', { preHandler: auth }, async request => ({ success: true,
    data: await prisma.agent.findUnique({ where: { userId: request.user!.sub },
      select: { id: true, countryId: true, displayName: true, status: true } }) }));

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
