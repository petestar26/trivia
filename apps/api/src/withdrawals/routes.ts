import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Withdrawal } from '@socialplay/database';
import { authenticate, ApiError } from '../middleware';
import { createWithdrawalQuote, getOwnWithdrawalQuote } from './quote-service';
import {
  createUserPayoutAccount,
  listOwnPayoutAccounts,
  getOwnPayoutAccount,
  disableOwnPayoutAccount,
} from './payout-account-service';
import { createWithdrawal, getOwnWithdrawalById, listOwnWithdrawals } from './withdrawal-service';
import { serializeQuote, serializeWithdrawal } from './dto';

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

  server.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: auth, schema: idParamSchema },
    async (request, reply) => {
      const withdrawal = await getOwnWithdrawalById(request.user!.sub, request.params.id);
      return reply.send({ success: true, data: serializeWithdrawal(withdrawal) });
    }
  );
}
