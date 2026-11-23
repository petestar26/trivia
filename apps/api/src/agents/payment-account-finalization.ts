import type { Prisma } from '@prisma/client';
import { ApiError } from '../middleware/api-error.js';

export const PAYMENT_ACCOUNT_CHANGED = 'Payment account changed since it was loaded. Reload and review the latest details.';

/** The token is the UTC ISO timestamp returned with the displayed record. */
export function parseExpectedUpdatedAt(value: unknown): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw ApiError.badRequest('expectedUpdatedAt must be the displayed account’s ISO timestamp');
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw ApiError.badRequest('expectedUpdatedAt must be a valid ISO timestamp');
  }
  return date;
}

export function assertDisplayedVersion(updatedAt: Date, expectedUpdatedAt: Date): void {
  if (updatedAt.getTime() !== expectedUpdatedAt.getTime()) {
    throw ApiError.conflict(PAYMENT_ACCOUNT_CHANGED);
  }
}

/** A successful same-millisecond change must still invalidate its old token. */
export function nextAccountVersion(updatedAt: Date): Date {
  return new Date(Math.max(Date.now(), updatedAt.getTime() + 1));
}

/**
 * Shared final transition for server-owned transactions. The caller must
 * establish admin authority before calling; this module holds no global client.
 */
export async function finalizeAgentPaymentAccount(
  tx: Prisma.TransactionClient,
  adminId: string,
  accountId: string,
  expectedUpdatedAt: Date,
  context?: { ip?: string; userAgent?: string } & (
    | { recommendationId: string; directDecision?: never }
    | { recommendationId?: never; directDecision: { reason: string; reasonSource: 'LEGACY_FORM' | 'ENTERED' } }
    | { recommendationId?: never; directDecision?: never }
  ),
) {
  const before = await tx.agentPaymentAccount.findUnique({
    where: { id: accountId },
    include: { agent: { select: { userId: true, countryId: true } } },
  });
  if (!before) throw ApiError.notFound('Payment account not found');
  if (before.agent.userId === adminId) {
    throw ApiError.forbidden('You cannot review your own payment account');
  }
  assertDisplayedVersion(before.updatedAt, expectedUpdatedAt);

  // Re-verify the country/method relationship at approval time too, per
  // Phase D §7 — a defense-in-depth re-check, not trusting that it still
  // holds just because it held at creation.
  const method = await tx.paymentMethodDefinition.findUnique({ where: { id: before.methodDefId } });
  if (!method || !method.isActive || method.countryId !== before.countryId || before.agent.countryId !== before.countryId) {
    throw ApiError.conflict('Payment method/country relationship is no longer valid — cannot approve');
  }

  // Match the version the administrator actually viewed, including edits
  // committed before this request began as well as races during the request.
  const claim = await tx.agentPaymentAccount.updateMany({
    where: { id: accountId, status: 'PENDING_APPROVAL', safetyHold: false, updatedAt: expectedUpdatedAt },
    data: {
      status: 'APPROVED', reviewedBy: adminId, reviewedAt: new Date(),
      updatedAt: nextAccountVersion(before.updatedAt),
    },
  });

  if (claim.count === 0) {
    throw ApiError.conflict(PAYMENT_ACCOUNT_CHANGED);
  }

  const agent = await tx.agent.findUnique({ where: { id: before.agentId } });

  await tx.auditLog.create({
    data: {
      userId: adminId,
      action: 'AGENT_PAYMENT_ACCOUNT_APPROVED',
      entity: 'AgentPaymentAccount',
      entityId: accountId,
      oldData: { status: 'PENDING_APPROVAL' },
      newData: {
        status: 'APPROVED',
        ...(context?.recommendationId ? { recommendationId: context.recommendationId } : {}),
        ...(context?.directDecision ? {
          mode: 'DIRECT_MAIN_ADMIN',
          reason: context.directDecision.reason,
          reasonSource: context.directDecision.reasonSource,
          approvedVersion: expectedUpdatedAt.toISOString(),
        } : {}),
      },
      ip: context?.ip,
      userAgent: context?.userAgent,
    },
  });

  await tx.notification.create({
    data: {
      userId: agent!.userId,
      type: 'AGENT_PAYMENT_ACCOUNT_APPROVED',
      title: 'Payment Account Approved',
      body: 'One of your payment accounts has been approved and can now be used for orders.',
      data: { accountId, agentId: before.agentId },
    },
  });

  return { accountId, alreadyReviewed: false, status: 'APPROVED' as const };
}
