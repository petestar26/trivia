import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { WithdrawalStatus } from '@socialplay/database';
import type { Withdrawal } from '@socialplay/database';
import { authenticate, requirePermission, ApiError } from '../middleware';
import { createWithdrawalQuote, getOwnWithdrawalQuote } from './quote-service';
import {
  createUserPayoutAccount,
  listOwnPayoutAccounts,
  getOwnPayoutAccount,
  disableOwnPayoutAccount,
} from './payout-account-service';
import {
  createWithdrawal,
  getOwnWithdrawalById,
  listOwnWithdrawals,
  listAssignedWithdrawals,
  getAssignedWithdrawal,
  claimPayout,
  submitPayment,
  cancelHeldWithdrawal,
} from './withdrawal-service';
import {
  claimWithdrawalDispute,
  confirmWithdrawalReceipt,
  escalateWithdrawalToDispute,
  getWithdrawalDisputeForAdmin,
  listWithdrawalDisputesForAdmin,
  listWithdrawalEscalationCandidates,
  openUserWithdrawalDispute,
  resolveWithdrawalDispute,
} from './dispute-service';
import type {
  WithdrawalDisputeReasonValue,
  WithdrawalEscalationReason,
  WithdrawalResolutionOutcome,
} from './dispute-service';
import { serializeAdminWithdrawal, serializeQuote, serializeSettlement, serializeWithdrawal } from './dto';
import { sweepWithdrawalTimeouts } from './timeout-service';
import { runWithdrawalReconciliation } from './reconciliation-service';

// W-1C withdrawal API routes.
//
// Every handler derives identity from request.user!.sub — no route
// accepts a userId, ownership, or step-up state from the client. Body
// schemas below use Zod's default (strip-unknown) mode, matching
// security/routes.ts's existing convention exactly (no route in this
// repo uses .strict()) — an extra userId field in a request body is
// silently dropped by the schema before the handler ever runs, and no
// handler below references request.body.userId in any case.
//
// tokenIat for step-up is always request.user!.iat — never a client-
// supplied field. No new step-up token/header/body shape is introduced;
// the client performs step-up via the existing POST /security/step-up/verify
// (W-0) before calling POST /withdrawals when required.

const createQuoteSchema = z.object({
  countryId: z.string().uuid(),
  coinAmount: z.number().int().positive(),
});

const createPayoutAccountSchema = z.object({
  countryId: z.string().uuid(),
  methodDefId: z.string().uuid(),
  accountDetails: z.record(z.unknown()),
  displayLabel: z.string().trim().max(64).optional(),
});

const createWithdrawalSchema = z.object({
  quoteId: z.string().uuid(),
  payoutAccountId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    // Field-level message only — mirrors security/routes.ts's parse().
    throw ApiError.badRequest(result.error.errors[0]?.message ?? 'Invalid request');
  }
  return result.data;
}

function requestContext(request: FastifyRequest) {
  return { ip: request.ip, userAgent: request.headers['user-agent'] };
}

// Fastify native JSON-schema for a single UUID path param — matches the
// existing convention in routes/chat.ts, routes/groups.ts, routes/gifts.ts.
const idParamSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  },
} as const;

export async function withdrawalRoutes(server: FastifyInstance): Promise<void> {
  const auth = [authenticate];

  // ── Quotes ───────────────────────────────────────────────────

  server.post('/quotes', { preHandler: auth }, async (request, reply) => {
    const body = parse(createQuoteSchema, request.body);
    const quote = await createWithdrawalQuote(request.user!.sub, body);
    return reply.status(201).send({ success: true, data: serializeQuote(quote) });
  });

  server.get<{ Params: { id: string } }>(
    '/quotes/:id',
    { preHandler: auth, schema: idParamSchema },
    async (request, reply) => {
      const quote = await getOwnWithdrawalQuote(request.user!.sub, request.params.id);
      return reply.send({ success: true, data: serializeQuote(quote) });
    }
  );

  // ── Payout accounts ──────────────────────────────────────────

  server.post('/payout-accounts', { preHandler: auth }, async (request, reply) => {
    const body = parse(createPayoutAccountSchema, request.body);
    const userId = request.user!.sub;
    const account = await createUserPayoutAccount(userId, body, requestContext(request));
    // createUserPayoutAccount returns UNMASKED accountDetails (the caller
    // just typed them) — the HTTP response should not echo full sensitive
    // destination details back, so re-read through the already-masked
    // getOwnPayoutAccount rather than duplicating masking logic here or
    // changing the service's own return shape.
    const masked = await getOwnPayoutAccount(userId, account.id);
    return reply.status(201).send({ success: true, data: masked });
  });

  server.get('/payout-accounts', { preHandler: auth }, async (request, reply) => {
    const accounts = await listOwnPayoutAccounts(request.user!.sub);
    return reply.send({ success: true, data: accounts });
  });

  server.get<{ Params: { id: string } }>(
    '/payout-accounts/:id',
    { preHandler: auth, schema: idParamSchema },
    async (request, reply) => {
      const account = await getOwnPayoutAccount(request.user!.sub, request.params.id);
      return reply.send({ success: true, data: account });
    }
  );

  server.post<{ Params: { id: string } }>(
    '/payout-accounts/:id/disable',
    { preHandler: auth, schema: idParamSchema },
    async (request, reply) => {
      const result = await disableOwnPayoutAccount(request.user!.sub, request.params.id, requestContext(request));
      return reply.send({ success: true, data: result });
    }
  );

  // ── Withdrawals ──────────────────────────────────────────────

  server.post('/', { preHandler: auth }, async (request, reply) => {
    const body = parse(createWithdrawalSchema, request.body);
    // tokenIat is always request.user!.iat — the verified JWT's own
    // iat claim, never a client-supplied value. requireStepUp() is still
    // consumed only inside createWithdrawal's own transaction (W-1B,
    // unchanged) — this route adds no new call site that could consume
    // a step-up outside it.
    const result = await createWithdrawal(request.user!.sub, body, request.user!.iat, requestContext(request));
    return reply
      .status(result.idempotent ? 200 : 201)
      .send({ success: true, data: serializeWithdrawal(result.withdrawal as Withdrawal) });
  });

  server.get('/me', { preHandler: auth }, async (request, reply) => {
    const withdrawals = await listOwnWithdrawals(request.user!.sub);
    return reply.send({ success: true, data: withdrawals.map(serializeWithdrawal) });
  });

  // ── W-1D1: Agent assigned withdrawals (MUST be before /:id) ──

  // Validated against the real enum rather than passed through as an
  // arbitrary string — an unrecognized value used to reach Prisma
  // directly and surface as an uncaught validation error (500) instead
  // of a clean 400.
  const listAssignedQuerySchema = z.object({
    status: z.nativeEnum(WithdrawalStatus).optional(),
  });

  server.get('/agent/assigned', { preHandler: auth }, async (request, reply) => {
    const query = parse(listAssignedQuerySchema, request.query);
    const filters = query.status ? { status: query.status } : undefined;
    const withdrawals = await listAssignedWithdrawals(request.user!.sub, filters);
    return reply.send({ success: true, data: withdrawals.map(serializeWithdrawal) });
  });

  server.get<{ Params: { id: string } }>(
    '/agent/assigned/:id',
    { preHandler: auth, schema: idParamSchema },
    async (request, reply) => {
      const withdrawal = await getAssignedWithdrawal(request.user!.sub, request.params.id);
      return reply.send({ success: true, data: serializeWithdrawal(withdrawal) });
    }
  );

  // ── W-1D1: Lifecycle mutations (MUST be before /:id) ────────

  const lifecycleIdSchema = {
    params: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string', format: 'uuid' } },
    },
  } as const;

  const claimPayoutSchema = z.object({
    idempotencyKey: z.string().min(8).max(128),
  });

  const submitPaymentSchema = z.object({
    referenceNumber: z.string().min(1).max(256),
    note: z.string().max(1024).optional(),
    idempotencyKey: z.string().min(8).max(128),
  });

  const cancelWithdrawalSchema = z.object({
    idempotencyKey: z.string().min(8).max(128),
  });

  const confirmReceiptSchema = z.object({
    idempotencyKey: z.string().min(8).max(128),
  });

  const openDisputeSchema = z.object({
    reason: z.enum(['FIAT_NOT_RECEIVED', 'WRONG_FIAT_AMOUNT', 'AGENT_UNRESPONSIVE', 'OTHER']),
    description: z.string().trim().min(1).max(4000),
    idempotencyKey: z.string().min(8).max(128),
  });

  const escalateSchema = z.object({
    escalationReason: z.enum(['AGENT_NOT_ACTIVE', 'PAYMENT_DEADLINE_ELAPSED', 'FRAUD_SUSPECTED']),
    description: z.string().trim().min(1).max(4000),
    idempotencyKey: z.string().min(8).max(128),
  });

  const claimDisputeSchema = z.object({
    idempotencyKey: z.string().min(8).max(128),
  });

  const adminVerifiedPaymentSchema = z.object({
    referenceNumber: z.string().trim().min(1).max(256),
    paymentOccurredAt: z.string().datetime({ offset: true }),
    note: z.string().max(1024).optional(),
  });

  const resolveDisputeSchema = z.object({
    outcome: z.enum(['COMPLETED', 'CANCELLED']),
    resolutionNote: z.string().trim().min(1).max(4000),
    idempotencyKey: z.string().min(8).max(128),
    adminVerifiedPayment: adminVerifiedPaymentSchema.optional(),
  });

  const adminDisputeQuerySchema = z.object({
    status: z.enum(['OPEN', 'ASSIGNED', 'RESOLVED']).optional(),
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  });

  const escalationCandidateQuerySchema = z.object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  });

  const sweepTimeoutsBodySchema = z
    .object({
      batchSize: z.number().int().min(1).max(500).optional(),
    })
    .optional();

  const reconciliationQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    staleDisputeThresholdHours: z.coerce.number().positive().optional(),
  });

  server.post<{ Params: { id: string } }>(
    '/:id/claim-payout',
    { preHandler: auth, schema: lifecycleIdSchema },
    async (request, reply) => {
      const body = parse(claimPayoutSchema, request.body);
      const result = await claimPayout(request.user!.sub, request.params.id, body, requestContext(request));
      return reply
        .status(200)
        .send({ success: true, data: serializeWithdrawal(result.result as Withdrawal), idempotent: result.idempotent });
    }
  );

  server.post<{ Params: { id: string } }>(
    '/:id/submit-payment',
    { preHandler: auth, schema: lifecycleIdSchema },
    async (request, reply) => {
      const body = parse(submitPaymentSchema, request.body);
      const result = await submitPayment(request.user!.sub, request.params.id, body, requestContext(request));
      return reply
        .status(200)
        .send({
          success: true,
          data: {
            paymentSubmission: result.result,
            withdrawal: serializeWithdrawal(result.withdrawal as Withdrawal),
          },
          idempotent: result.idempotent,
        });
    }
  );

  server.post<{ Params: { id: string } }>(
    '/:id/cancel',
    { preHandler: auth, schema: lifecycleIdSchema },
    async (request, reply) => {
      const body = parse(cancelWithdrawalSchema, request.body);
      const result = await cancelHeldWithdrawal(request.user!.sub, request.params.id, body, requestContext(request));
      return reply
        .status(200)
        .send({ success: true, data: serializeWithdrawal(result.result as Withdrawal), idempotent: result.idempotent });
    }
  );

  // ── W-1D2: user settlement/dispute transitions ──────────────

  server.post<{ Params: { id: string } }>(
    '/:id/confirm-receipt',
    { preHandler: auth, schema: lifecycleIdSchema },
    async (request, reply) => {
      const body = parse(confirmReceiptSchema, request.body);
      const result = await confirmWithdrawalReceipt(
        request.user!.sub,
        request.params.id,
        body,
        requestContext(request)
      );
      return reply.send({
        success: true,
        data: {
          withdrawal: serializeWithdrawal(result.withdrawal as Withdrawal),
          settlement: serializeSettlement(result.settlement),
        },
        idempotent: result.idempotent,
      });
    }
  );

  server.post<{ Params: { id: string } }>(
    '/:id/dispute',
    { preHandler: auth, schema: lifecycleIdSchema },
    async (request, reply) => {
      const body = parse(openDisputeSchema, request.body);
      const result = await openUserWithdrawalDispute(
        request.user!.sub,
        request.params.id,
        body as {
          reason: WithdrawalDisputeReasonValue;
          description: string;
          idempotencyKey: string;
        },
        requestContext(request)
      );
      return reply
        .status(result.idempotent ? 200 : 201)
        .send({
          success: true,
          data: {
            dispute: result.dispute,
            withdrawal: serializeWithdrawal(result.withdrawal as Withdrawal),
          },
          idempotent: result.idempotent,
        });
    }
  );

  // ── W-1D2: admin-only escalation and resolution ─────────────

  const withdrawalAdmin = [authenticate, requirePermission('withdrawal:admin')];

  server.get('/admin/disputes', { preHandler: withdrawalAdmin }, async (request, reply) => {
    const query = parse(adminDisputeQuerySchema, request.query);
    const result = await listWithdrawalDisputesForAdmin(request.user!.sub, query);
    return reply.send({ success: true, data: result.items, nextCursor: result.nextCursor });
  });

  server.get('/admin/escalation-candidates', { preHandler: withdrawalAdmin }, async (request, reply) => {
    const query = parse(escalationCandidateQuerySchema, request.query);
    const result = await listWithdrawalEscalationCandidates(request.user!.sub, query);
    return reply.send({
      success: true,
      data: result.items.map(serializeAdminWithdrawal),
      nextCursor: result.nextCursor,
    });
  });

  server.get<{ Params: { id: string } }>(
    '/admin/disputes/:id',
    { preHandler: withdrawalAdmin, schema: lifecycleIdSchema },
    async (request, reply) => {
      const result = await getWithdrawalDisputeForAdmin(request.user!.sub, request.params.id);
      return reply.send({
        success: true,
        data: {
          dispute: result.dispute,
          withdrawal: serializeAdminWithdrawal(result.withdrawal),
        },
      });
    }
  );

  server.post<{ Params: { id: string } }>(
    '/admin/:id/escalate',
    { preHandler: withdrawalAdmin, schema: lifecycleIdSchema },
    async (request, reply) => {
      const body = parse(escalateSchema, request.body);
      const result = await escalateWithdrawalToDispute(
        request.user!.sub,
        request.params.id,
        body as {
          escalationReason: WithdrawalEscalationReason;
          description: string;
          idempotencyKey: string;
        },
        requestContext(request)
      );
      return reply
        .status(result.idempotent ? 200 : 201)
        .send({
          success: true,
          data: {
            dispute: result.dispute,
            withdrawal: serializeAdminWithdrawal(result.withdrawal as Withdrawal),
          },
          idempotent: result.idempotent,
        });
    }
  );

  server.post<{ Params: { id: string } }>(
    '/admin/disputes/:id/claim',
    { preHandler: withdrawalAdmin, schema: lifecycleIdSchema },
    async (request, reply) => {
      const body = parse(claimDisputeSchema, request.body);
      const result = await claimWithdrawalDispute(
        request.user!.sub,
        request.params.id,
        body,
        requestContext(request)
      );
      return reply.send({
        success: true,
        data: {
          dispute: result.dispute,
          withdrawal: serializeAdminWithdrawal(result.withdrawal as Withdrawal),
        },
        idempotent: result.idempotent,
      });
    }
  );

  server.post<{ Params: { id: string } }>(
    '/admin/disputes/:id/resolve',
    { preHandler: withdrawalAdmin, schema: lifecycleIdSchema },
    async (request, reply) => {
      const body = parse(resolveDisputeSchema, request.body);
      const result = await resolveWithdrawalDispute(
        request.user!.sub,
        request.params.id,
        body as {
          outcome: WithdrawalResolutionOutcome;
          resolutionNote: string;
          idempotencyKey: string;
          adminVerifiedPayment?: {
            referenceNumber: string;
            paymentOccurredAt: string;
            note?: string;
          };
        },
        requestContext(request)
      );
      return reply.send({
        success: true,
        data: {
          dispute: result.dispute,
          withdrawal: serializeAdminWithdrawal(result.withdrawal as Withdrawal),
          settlement: serializeSettlement(result.settlement),
        },
        idempotent: result.idempotent,
      });
    }
  );

  // ── W-1D3: admin-only timeout sweep and reconciliation ──────

  server.post('/admin/sweeps/timeouts', { preHandler: withdrawalAdmin }, async (request, reply) => {
    const body = parse(sweepTimeoutsBodySchema, request.body) ?? {};
    // Counts + withdrawal/dispute ids + reason codes only — never a full
    // Withdrawal body, so there is no paymentSnapshot or BigInt field to
    // leak here regardless of caller.
    const summary = await sweepWithdrawalTimeouts({ batchSize: body.batchSize });
    return reply.send({ success: true, data: summary });
  });

  server.get('/admin/reconciliation', { preHandler: withdrawalAdmin }, async (request, reply) => {
    const query = parse(reconciliationQuerySchema, request.query);
    const report = await runWithdrawalReconciliation({
      limit: query.limit,
      staleDisputeThresholdMs:
        query.staleDisputeThresholdHours !== undefined ? query.staleDisputeThresholdHours * 60 * 60 * 1000 : undefined,
    });
    return reply.send({ success: true, data: report });
  });

  // ── Single withdrawal by ID (MUST be after /agent/ and /:id/lifecycle routes) ──

  server.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: auth, schema: idParamSchema },
    async (request, reply) => {
      const withdrawal = await getOwnWithdrawalById(request.user!.sub, request.params.id);
      return reply.send({ success: true, data: serializeWithdrawal(withdrawal) });
    }
  );
}
