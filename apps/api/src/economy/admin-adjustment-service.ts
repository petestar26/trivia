import { createHash } from 'node:crypto';
import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware/error-handler.js';
import { creditCoins, debitCoins, lockUserEconomicScope } from './coin-ledger-service.js';

export interface AdminCoinAdjustment {
  targetUserId: string;
  caseId: string;
  delta: number;
  rationale: string;
  supportingEvidence: string[];
}

/** A positive correction stays in U review; only a later dual approval can qualify it. */
export async function adjustUserCoins(actorId: string, input: AdminCoinAdjustment) {
  if (!input.targetUserId || !input.caseId || input.caseId.length > 128
      || !Number.isSafeInteger(input.delta) || input.delta === 0
      || Math.abs(input.delta) > 1_000_000_000
      || !input.rationale?.trim() || input.rationale.trim().length < 10
      || !Array.isArray(input.supportingEvidence) || input.supportingEvidence.length === 0
      || input.supportingEvidence.some((item) => typeof item !== 'string' || !item.trim())) {
    throw ApiError.badRequest('Coin adjustment requires a case ID, nonzero amount, rationale and evidence');
  }
  const evidence = {
    caseId: input.caseId, rationale: input.rationale.trim(),
    supportingEvidence: input.supportingEvidence.map((item) => item.trim()), actorId,
  };
  const requestHash = createHash('sha256').update(JSON.stringify({
    targetUserId: input.targetUserId, delta: input.delta, ...evidence,
  })).digest('hex');
  return prisma.$transaction(async (tx) => {
    await lockUserEconomicScope(tx, `admin_adjust:${input.caseId}`); // L0
    const users = (await tx.$queryRaw`
      SELECT "id","role"::text AS "role","status"::text AS "status"
      FROM "users" WHERE "id"=${actorId} OR "id"=${input.targetUserId}
      ORDER BY "id" FOR SHARE
    `) as { id: string; role: string; status: string }[];
    if (actorId === input.targetUserId || users.length !== 2 ||
        !users.some((user) => user.id === actorId && user.role === 'SUPER_ADMIN'
          && user.status === 'ACTIVE')) {
      throw ApiError.forbidden('Independent active SUPER_ADMIN required');
    }
    const prior = await tx.economicOperation.findUnique({
      where: { type_scopeType_scopeId: {
        type: 'ADMIN_ADJUST', scopeType: 'ADMIN_ADJUSTMENT', scopeId: input.caseId,
      } }, select: { id: true, userId: true, requestHash: true },
    });
    if (prior) {
      if (prior.userId !== input.targetUserId || prior.requestHash !== requestHash) {
        throw ApiError.conflict('Coin adjustment case ID was used with different terms');
      }
      return { operationId: prior.id, idempotent: true };
    }
    const common = {
      type: 'ADMIN_ADJUST' as const, scopeType: 'ADMIN_ADJUSTMENT', scopeId: input.caseId,
      referenceType: 'ADMIN' as const, referenceId: input.caseId,
      description: input.rationale.trim(), createdBy: actorId, requestHash, evidence,
    };
    const result = input.delta > 0
      ? await creditCoins(tx, input.targetUserId, input.delta, common)
      : await debitCoins(tx, input.targetUserId, -input.delta, common);
    return { operationId: result.operationId, idempotent: false,
      coinsBalance: result.coinsBalance,
      reviewLotId: 'lotId' in result ? result.lotId : null };
  }, { isolationLevel: 'Serializable', timeout: 120_000 });
}
