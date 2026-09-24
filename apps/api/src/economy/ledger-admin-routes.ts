import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@socialplay/database';
import { authenticate, requireRole } from '../middleware/auth.js';
import { ApiError } from '../middleware/error-handler.js';
import { configureCountryPolicyDraft, activateCountryPolicy, deactivateCountryPolicy } from './ledger-admin-service.js';
import { classifyLegacyCoinAccount } from './legacy-ledger-classifier.js';
import { firstApproveLegacyReview, secondApproveLegacyReview } from './legacy-review-service.js';
import {
  closeCoinAdjustment, executeCoinAdjustment, firstApproveCoinAdjustment, listOpenCoinAdjustments, requestCoinAdjustment,
} from './admin-adjustment-service.js';

const countryCode = z.string().regex(/^[A-Z]{2}$/);
const id = z.string().min(1).max(128);
const policyConfig = z.object({
  minWithdrawal: z.number().int().positive(), maxWithdrawal: z.number().int().positive(),
  dailyWithdrawalLimit: z.number().int().nonnegative(),
  monthlyWithdrawalLimit: z.number().int().nonnegative(),
  playthroughMultiplier: z.number().positive(),
  qualifyingGames: z.array(z.string().min(1)).min(1),
  maxQualifyingStake: z.number().int().positive(),
  holdingPeriodHours: z.number().int().nonnegative(),
  giftDailyLimit: z.number().int().nonnegative(),
  kycTierRequired: z.number().int().nonnegative(),
  supportedPaymentMethods: z.array(z.string().min(1)).min(1),
  withdrawalFeePercent: z.number().min(0).max(1),
  manualReviewThreshold: z.number().int().nonnegative(),
  maxConversionMultiple: z.number().positive().nullable(),
  bonusExpiryHours: z.number().int().positive().nullable(),
}).strict();
const proposal = z.object({
  decision: z.enum(['WITHDRAWABLE', 'RESTRICTED']),
  rationale: z.string().trim().min(10),
  supportingEvidence: z.array(z.string().trim().min(1)).min(1),
  countryCode: countryCode.optional(),
}).strict();
const adjustment = z.object({
  targetUserId: id, caseId: id,
  delta: z.number().int().refine((n) => n !== 0 && Math.abs(n) <= 1_000_000_000, 'delta must be a nonzero whole number of at most 1,000,000,000 Coins'),
  rationale: z.string().trim().min(10),
  supportingEvidence: z.array(z.string().trim().min(1)).min(1),
}).strict();
const closure = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw ApiError.badRequest(parsed.error.errors[0]?.message ?? 'Invalid request');
  return parsed.data;
}

/** Administrative entrypoints; every mutation also rechecks the active DB role. */
export async function ledgerAdminRoutes(server: FastifyInstance): Promise<void> {
  const admin = [authenticate, requireRole('SUPER_ADMIN')];

  server.get('/reviews', { preHandler: admin }, async (request, reply) => {
    const reviews = await prisma.$transaction(async (tx) => {
      const actors = (await tx.$queryRaw`
        SELECT "id" FROM "users" WHERE "id"=${request.user!.sub}
          AND "role"='SUPER_ADMIN' AND "status"='ACTIVE' FOR SHARE
      `) as { id: string }[];
      if (actors.length !== 1) throw ApiError.forbidden('Active SUPER_ADMIN required');
      return tx.legacyBalanceReview.findMany({
        where: { status: { in: ['OPEN', 'FIRST_APPROVED'] } },
        orderBy: { id: 'asc' }, take: 100,
      });
    });
    return reply.send({ success: true, data: reviews });
  });

  server.post<{ Params: { reviewId: string } }>(
    '/reviews/:reviewId/first-approval', { preHandler: admin }, async (request, reply) => {
      const reviewId = parse(id, request.params.reviewId);
      const body = parse(proposal, request.body);
      const review = await firstApproveLegacyReview(request.user!.sub, reviewId, body);
      return reply.send({ success: true, data: review });
    });
  server.post<{ Params: { reviewId: string } }>(
    '/reviews/:reviewId/second-approval', { preHandler: admin }, async (request, reply) => {
      const reviewId = parse(id, request.params.reviewId);
      const result = await secondApproveLegacyReview(request.user!.sub, reviewId);
      return reply.send({ success: true, data: result });
    });

  server.post<{ Params: { userId: string } }>(
    '/legacy-classifications/:userId/preview', { preHandler: admin }, async (request, reply) => {
      const userId = parse(id, request.params.userId);
      return reply.send({ success: true, data: await classifyLegacyCoinAccount(userId, true, request.user!.sub) });
    });
  server.post<{ Params: { userId: string } }>(
    '/legacy-classifications/:userId/apply', { preHandler: admin }, async (request, reply) => {
      const userId = parse(id, request.params.userId);
      return reply.send({ success: true, data: await classifyLegacyCoinAccount(userId, false, request.user!.sub) });
    });

  server.post<{ Params: { countryCode: string } }>(
    '/policies/:countryCode/drafts', { preHandler: admin }, async (request, reply) => {
      const code = parse(countryCode, request.params.countryCode);
      const body = parse(policyConfig, request.body);
      const draft = await configureCountryPolicyDraft(request.user!.sub, code, body);
      return reply.status(201).send({ success: true, data: draft });
    });
  server.put<{ Params: { countryCode: string; version: string } }>(
    '/policies/:countryCode/drafts/:version', { preHandler: admin }, async (request, reply) => {
      const code = parse(countryCode, request.params.countryCode);
      const version = parse(z.coerce.number().int().positive(), request.params.version);
      const body = parse(policyConfig, request.body);
      const draft = await configureCountryPolicyDraft(request.user!.sub, code, body, version);
      return reply.send({ success: true, data: draft });
    });
  server.post<{ Params: { countryCode: string; version: string } }>(
    '/policies/:countryCode/versions/:version/activate', { preHandler: admin }, async (request, reply) => {
      const code = parse(countryCode, request.params.countryCode);
      const version = parse(z.coerce.number().int().positive(), request.params.version);
      const result = await activateCountryPolicy(request.user!.sub, code, version);
      return reply.send({ success: true, data: result });
    });
  server.post<{ Params: { countryCode: string } }>(
    '/policies/:countryCode/deactivate', { preHandler: admin }, async (request, reply) => {
      const code = parse(countryCode, request.params.countryCode);
      const result = await deactivateCountryPolicy(request.user!.sub, code);
      return reply.send({ success: true, data: result });
    });

  // A Coin adjustment is a request, a first approval and a second approval
  // by a distinct SUPER_ADMIN, which settles it. Nothing moves before that.
  server.get('/adjustments', { preHandler: admin }, async (request, reply) => {
    return reply.send({ success: true, data: await listOpenCoinAdjustments(request.user!.sub) });
  });
  server.post('/adjustments', { preHandler: admin }, async (request, reply) => {
    const body = parse(adjustment, request.body);
    const result = await requestCoinAdjustment(request.user!.sub, body);
    return reply.status(result.idempotent ? 200 : 201).send({ success: true, data: result });
  });
  server.post<{ Params: { approvalId: string } }>(
    '/adjustments/:approvalId/first-approval', { preHandler: admin }, async (request, reply) => {
      const approvalId = parse(id, request.params.approvalId);
      return reply.send({ success: true, data: await firstApproveCoinAdjustment(request.user!.sub, approvalId) });
    });
  server.post<{ Params: { approvalId: string } }>(
    '/adjustments/:approvalId/second-approval', { preHandler: admin }, async (request, reply) => {
      const approvalId = parse(id, request.params.approvalId);
      const result = await executeCoinAdjustment(request.user!.sub, approvalId);
      return reply.status(result.idempotent ? 200 : 201).send({ success: true, data: result });
    });
  server.post<{ Params: { approvalId: string } }>(
    '/adjustments/:approvalId/reject', { preHandler: admin }, async (request, reply) => {
      const approvalId = parse(id, request.params.approvalId);
      const { reason } = parse(closure, request.body);
      return reply.send({ success: true, data: await closeCoinAdjustment(request.user!.sub, approvalId, 'REJECTED', reason) });
    });
  server.post<{ Params: { approvalId: string } }>(
    '/adjustments/:approvalId/cancel', { preHandler: admin }, async (request, reply) => {
      const approvalId = parse(id, request.params.approvalId);
      const { reason } = parse(closure, request.body);
      return reply.send({ success: true, data: await closeCoinAdjustment(request.user!.sub, approvalId, 'CANCELLED', reason) });
    });
}
