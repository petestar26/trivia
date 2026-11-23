import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { finalizeAgentPaymentAccount, parseExpectedUpdatedAt } from '../agents/payment-account-finalization.js';
import { ApiError } from '../middleware/api-error.js';
import { deny, validId } from './authority.js';

const directInput = z.object({
  expectedUpdatedAt: z.string().datetime({ precision: 3 }),
  reason: z.string().trim().min(1).max(240)
    .refine(value => !/[\u0000-\u001f\u007f-\u009f]/u.test(value)).optional(),
}).strict();

/** The legacy HTTP URI is strict in this release candidate, independently
 * of Manager route registration. No feature flag falls back to global Admin. */
export async function approveAgentPaymentAccountAsMainAdmin(
  db: PrismaClient, actor: string, tokenVersion: number, accountId: string, body: unknown,
  requestContext?: { ip?: string; userAgent?: string },
) {
  validId(actor);
  validId(accountId);
  if (!Number.isSafeInteger(tokenVersion) || tokenVersion < 0 || tokenVersion > 2_147_483_647) deny();
  const parsed = directInput.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest('Use the displayed account version and an optional short approval reason');
  const { expectedUpdatedAt, reason } = parsed.data;
  const version = parseExpectedUpdatedAt(expectedUpdatedAt);
  return db.$transaction(async tx => {
    const [gate] = await tx.$queryRaw<{ allowed:boolean }[]>`
      SELECT staff_entrypoints.can_directly_approve(${actor}::text,${tokenVersion}::int4) AS allowed`;
    if (gate?.allowed !== true) deny();
    return finalizeAgentPaymentAccount(tx, actor, accountId, version, {
      ...requestContext,
      directDecision: reason === undefined
        ? { reason: 'Legacy approval form has no reason field', reasonSource: 'LEGACY_FORM' }
        : { reason, reasonSource: 'ENTERED' },
    });
  }, { timeout:15000, maxWait:15000 });
}

