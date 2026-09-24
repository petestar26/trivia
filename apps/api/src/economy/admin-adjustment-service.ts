import { prisma } from '@socialplay/database';
import type { AdminAdjustmentApproval } from '@socialplay/database';
import { ApiError } from '../middleware/error-handler.js';
import { creditCoins, debitCoins, lockUserEconomicScope } from './coin-ledger-service.js';

/** The largest adjustment either way, in Coins (also a database CHECK). */
export const MAX_COIN_ADJUSTMENT = 1_000_000_000;

export interface AdminCoinAdjustmentRequest {
  targetUserId: string;
  caseId: string;
  /** Signed Coins: positive credits UNCLASSIFIED value, negative debits lots. */
  delta: number;
  rationale: string;
  supportingEvidence: string[];
}

export interface AdjustmentTerms {
  userId: string;
  caseId: string;
  amount: number;
  evidence: { caseId: string; rationale: string; supportingEvidence: string[] };
}

/**
 * The validated terms of an adjustment request. Refuses, before any write:
 * a missing user or case, an amount that is not a whole number of Coins
 * (fractions, strings, NaN, unsafe integers), zero, anything beyond
 * MAX_COIN_ADJUSTMENT either way, and evidence that is empty, blank or
 * not a list of real references.
 */
export function adjustmentTerms(input: unknown): AdjustmentTerms {
  const request = (input && typeof input === 'object' ? input : {}) as Partial<Record<keyof AdminCoinAdjustmentRequest, unknown>>;
  const { targetUserId, caseId, delta, rationale, supportingEvidence } = request;
  if (typeof targetUserId !== 'string' || !targetUserId.trim() || targetUserId.length > 128) {
    throw ApiError.badRequest('A Coin adjustment needs the affected user');
  }
  if (typeof caseId !== 'string' || !caseId.trim() || caseId.trim().length > 128) {
    throw ApiError.badRequest('A Coin adjustment needs a case ID of at most 128 characters');
  }
  if (typeof delta !== 'number' || !Number.isSafeInteger(delta)) {
    throw ApiError.badRequest('The adjustment must be a whole number of Coins');
  }
  if (delta === 0) throw ApiError.badRequest('The adjustment must not be zero');
  if (Math.abs(delta) > MAX_COIN_ADJUSTMENT) {
    throw ApiError.badRequest(`The adjustment must be at most ${MAX_COIN_ADJUSTMENT} Coins either way`);
  }
  if (typeof rationale !== 'string' || rationale.trim().length < 10) {
    throw ApiError.badRequest('The adjustment needs a rationale of at least 10 characters');
  }
  if (!Array.isArray(supportingEvidence) || supportingEvidence.length === 0
      || supportingEvidence.some((item) => typeof item !== 'string' || !item.trim())) {
    throw ApiError.badRequest('The adjustment needs at least one non-empty supporting evidence reference');
  }
  const normalizedCase = caseId.trim();
  return {
    userId: targetUserId,
    caseId: normalizedCase,
    amount: delta,
    evidence: {
      caseId: normalizedCase,
      rationale: rationale.trim(),
      supportingEvidence: (supportingEvidence as string[]).map((item) => item.trim()),
    },
  };
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** The actor must be an active SUPER_ADMIN now; the row stays share-locked. */
async function requireActiveSuperAdmin(tx: Tx, userId: string, message = 'Active SUPER_ADMIN required') {
  const rows = (await tx.$queryRaw`
    SELECT "role"::text AS "role", "status"::text AS "status" FROM "users" WHERE "id"=${userId} FOR SHARE
  `) as { role: string; status: string }[];
  if (rows[0]?.role !== 'SUPER_ADMIN' || rows[0]?.status !== 'ACTIVE') throw ApiError.forbidden(message);
}

async function lockApproval(tx: Tx, approvalId: string): Promise<AdminAdjustmentApproval> {
  await lockUserEconomicScope(tx, `admin_adjust_approval:${approvalId}`);
  const approval = await tx.adminAdjustmentApproval.findUnique({ where: { id: approvalId } });
  if (!approval) throw ApiError.notFound('Coin adjustment approval not found');
  return approval;
}

function sameTerms(approval: AdminAdjustmentApproval, terms: AdjustmentTerms): boolean {
  return approval.userId === terms.userId && approval.amount === terms.amount
    && JSON.stringify(approval.evidence) === JSON.stringify(terms.evidence);
}

/** Step 1: a SUPER_ADMIN records the request. Nothing moves yet. */
export async function requestCoinAdjustment(actorId: string, input: unknown) {
  const terms = adjustmentTerms(input);
  return prisma.$transaction(async (tx) => {
    await lockUserEconomicScope(tx, `admin_adjust:${terms.caseId}`);
    await requireActiveSuperAdmin(tx, actorId);
    if (actorId === terms.userId) throw ApiError.forbidden('An administrator cannot adjust their own Coins');
    const target = await tx.user.findUnique({ where: { id: terms.userId }, select: { id: true } });
    if (!target) throw ApiError.notFound('User not found');
    const prior = await tx.adminAdjustmentApproval.findUnique({ where: { caseId: terms.caseId } });
    if (prior) {
      if (!sameTerms(prior, terms)) throw ApiError.conflict('Coin adjustment case ID was used with different terms');
      return { approvalId: prior.id, status: prior.status, idempotent: true };
    }
    const approval = await tx.adminAdjustmentApproval.create({
      data: { userId: terms.userId, amount: terms.amount, caseId: terms.caseId, evidence: terms.evidence, createdBy: actorId },
    });
    return { approvalId: approval.id, status: approval.status, idempotent: false };
  });
}

/** Step 2: a first SUPER_ADMIN approval (the creator may give it). */
export async function firstApproveCoinAdjustment(actorId: string, approvalId: string) {
  return prisma.$transaction(async (tx) => {
    const approval = await lockApproval(tx, approvalId);
    await requireActiveSuperAdmin(tx, actorId);
    if (actorId === approval.userId) throw ApiError.forbidden('An administrator cannot approve their own Coin adjustment');
    if (approval.status === 'FIRST_APPROVED' && approval.firstApproverId === actorId) {
      return { approvalId, status: approval.status, idempotent: true };
    }
    if (approval.status !== 'PENDING') throw ApiError.conflict(`This adjustment is ${approval.status}, not awaiting a first approval`);
    const updated = await tx.adminAdjustmentApproval.update({
      where: { id: approvalId },
      data: { status: 'FIRST_APPROVED', firstApproverId: actorId, firstApprovedAt: new Date() },
    });
    return { approvalId, status: updated.status, idempotent: false };
  });
}

/**
 * Step 3: a second, distinct SUPER_ADMIN approves, which settles the
 * adjustment in the same transaction. Both approvers are rechecked now: an
 * approval whose first approver is no longer an active SUPER_ADMIN cannot
 * settle (cancel it and request again). The approval is consumed by exactly
 * this one ADMIN_ADJUST operation; the database verifies the binding.
 */
export async function executeCoinAdjustment(actorId: string, approvalId: string) {
  return prisma.$transaction(async (tx) => {
    const approval = await lockApproval(tx, approvalId);
    await requireActiveSuperAdmin(tx, actorId);
    if (approval.status === 'EXECUTED' && approval.secondApproverId === actorId && approval.operationId) {
      return { approvalId, operationId: approval.operationId, idempotent: true };
    }
    if (approval.status !== 'FIRST_APPROVED') {
      throw ApiError.conflict(`This adjustment is ${approval.status}, not awaiting its second approval`);
    }
    if (actorId === approval.userId) throw ApiError.forbidden('An administrator cannot approve their own Coin adjustment');
    if (actorId === approval.firstApproverId) {
      throw ApiError.conflict('A distinct second administrator must approve the adjustment');
    }
    await requireActiveSuperAdmin(tx, approval.firstApproverId!,
      'The first approver is no longer an active SUPER_ADMIN; cancel this adjustment and request it again');
    const evidence = approval.evidence as AdjustmentTerms['evidence'];
    const common = {
      type: 'ADMIN_ADJUST' as const, scopeType: 'ADMIN_ADJUSTMENT', scopeId: approval.caseId,
      referenceType: 'ADMIN' as const, referenceId: approval.caseId,
      description: evidence.rationale, createdBy: actorId, evidence,
      adjustmentApproval: { id: approval.id, amount: approval.amount },
    };
    const result = approval.amount > 0
      ? await creditCoins(tx, approval.userId, approval.amount, common)
      : await debitCoins(tx, approval.userId, -approval.amount, common);
    if (!result.walletTransactionId) throw ApiError.internal('Coin adjustment has no wallet transaction');
    const now = new Date();
    await tx.adminAdjustmentApproval.update({
      where: { id: approvalId },
      data: {
        status: 'EXECUTED', secondApproverId: actorId, secondApprovedAt: now,
        operationId: result.operationId, walletTransactionId: result.walletTransactionId, executedAt: now,
      },
    });
    // Surface the database's verdict on the approval binding inside this
    // callback (Prisma can resolve before a deferred COMMIT rejects).
    const guards = '"operation_authorization_guard", "authorized_operation_guard", "adjustment_execution_guard"';
    await tx.$executeRawUnsafe(`SET CONSTRAINTS ${guards} IMMEDIATE`);
    await tx.$executeRawUnsafe(`SET CONSTRAINTS ${guards} DEFERRED`);
    return {
      approvalId, operationId: result.operationId, idempotent: false, coinsBalance: result.coinsBalance,
      reviewLotId: 'lotId' in result ? result.lotId : null,
    };
  }, { isolationLevel: 'Serializable', timeout: 120_000 });
}

/** Ends a pending adjustment: REJECTED by any other SUPER_ADMIN, CANCELLED by its creator. */
export async function closeCoinAdjustment(
  actorId: string, approvalId: string, outcome: 'REJECTED' | 'CANCELLED', reason: unknown,
) {
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500) {
    throw ApiError.badRequest('Closing an adjustment needs a reason of at most 500 characters');
  }
  return prisma.$transaction(async (tx) => {
    const approval = await lockApproval(tx, approvalId);
    await requireActiveSuperAdmin(tx, actorId);
    if (outcome === 'CANCELLED' && actorId !== approval.createdBy) {
      throw ApiError.forbidden('Only the administrator who requested an adjustment can cancel it');
    }
    if (approval.status === outcome && approval.closedBy === actorId) return { approvalId, status: outcome, idempotent: true };
    if (approval.status !== 'PENDING' && approval.status !== 'FIRST_APPROVED') {
      throw ApiError.conflict(`This adjustment is ${approval.status} and can no longer be closed`);
    }
    await tx.adminAdjustmentApproval.update({
      where: { id: approvalId },
      data: { status: outcome, closedBy: actorId, closedAt: new Date(), closeReason: reason.trim() },
    });
    return { approvalId, status: outcome, idempotent: false };
  });
}

/** The open adjustment requests, for the administration queue. */
export async function listOpenCoinAdjustments(actorId: string) {
  return prisma.$transaction(async (tx) => {
    await requireActiveSuperAdmin(tx, actorId);
    return tx.adminAdjustmentApproval.findMany({
      where: { status: { in: ['PENDING', 'FIRST_APPROVED'] } }, orderBy: { createdAt: 'asc' }, take: 100,
    });
  });
}
