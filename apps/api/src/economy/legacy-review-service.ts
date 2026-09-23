import { prisma } from '@socialplay/database';
import type { Prisma } from '@socialplay/database';
import { ApiError } from '../middleware/error-handler.js';
import { applyBalanceChanges, COIN_LEDGER_INTENT } from './wallet-service.js';
import { flushCoinLedgerConstraints } from './coin-ledger-service.js';

type Tx = Prisma.TransactionClient;
type Decision = 'WITHDRAWABLE' | 'RESTRICTED' | 'FORFEIT';
export interface LegacyResolutionProposal {
  decision: Decision;
  rationale: string;
  supportingEvidence: string[];
  countryCode?: string;
}
type StoredProposal = LegacyResolutionProposal & {
  amount: number; policyId: string | null; policyVersion: number | null;
  requirementAmount: number;
};
type ReviewRow = { id: string; userId: string; lotId: string; status: string;
  resolvedBy: string | null; secondApproverId: string | null;
  resolutionOperationId: string | null; evidence: Prisma.JsonValue };
type LotRow = { id: string; userId: string; lotClass: string; state: string;
  reviewId: string | null; availableAmount: number; reservedAmount: number;
  rootLotId: string | null };

function asEvidenceObject(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

async function lockScope(tx: Tx, reviewId: string) {
  await tx.$queryRaw`SELECT 1 FROM
    (SELECT pg_advisory_xact_lock(hashtextextended(${'legacy_review:' + reviewId},0))) AS acquired`;
}

async function lockAdminAndOwner(tx: Tx, actorId: string, ownerId: string) {
  if (actorId === ownerId) throw ApiError.forbidden('An administrator cannot approve their own Coin review');
  const users = (await tx.$queryRaw`
    SELECT "id","role"::text AS "role","status"::text AS "status"
    FROM "users" WHERE "id"=${actorId} OR "id"=${ownerId}
    ORDER BY "id" FOR SHARE
  `) as { id: string; role: string; status: string }[];
  if (users.length !== 2 || !users.some((u) => u.id === actorId
      && u.role === 'SUPER_ADMIN' && u.status === 'ACTIVE')) {
    throw ApiError.forbidden('Active independent SUPER_ADMIN required');
  }
}

function validateProposal(proposal: LegacyResolutionProposal) {
  if (proposal.decision === 'FORFEIT') {
    throw ApiError.forbidden('Legacy forfeiture is disabled pending an explicit owner policy');
  }
  if (!['WITHDRAWABLE', 'RESTRICTED'].includes(proposal.decision)
      || typeof proposal.rationale !== 'string' || proposal.rationale.trim().length < 10
      || !Array.isArray(proposal.supportingEvidence)
      || proposal.supportingEvidence.length === 0
      || proposal.supportingEvidence.some((x) => typeof x !== 'string' || !x.trim())) {
    throw ApiError.badRequest('Review resolution requires a decision, rationale, and evidence');
  }
  if (proposal.decision === 'RESTRICTED' && !/^[A-Z]{2}$/.test(proposal.countryCode ?? '')) {
    throw ApiError.badRequest('Restricted resolution requires a country policy');
  }
}

async function activePolicyForProposal(tx: Tx, proposal: LegacyResolutionProposal,
  allowUnavailable = false): Promise<{
  id: string; version: number; requirementMultiplier: number;
} | null> {
  if (proposal.decision !== 'RESTRICTED') return null;
  const pointers = (await tx.$queryRaw`
    SELECT "activePolicyId" FROM "country_jurisdictions"
    WHERE "countryCode"=${proposal.countryCode} FOR SHARE
  `) as { activePolicyId: string | null }[];
  if (!pointers[0]?.activePolicyId) {
    if (allowUnavailable) return null;
    throw ApiError.forbidden('Active country policy required');
  }
  const policies = (await tx.$queryRaw`
    SELECT "id","version","playthroughMultiplier"
    FROM "country_casino_policies"
    WHERE "id"=${pointers[0].activePolicyId} AND "state"='ACTIVE'
      AND "status"='ENABLED' AND "thresholdsConfiguredAt" IS NOT NULL
    FOR SHARE
  `) as { id: string; version: number;
    playthroughMultiplier: number | { toNumber(): number } }[];
  const policy = policies[0];
  if (!policy) {
    if (allowUnavailable) return null;
    throw ApiError.forbidden('Active country policy required');
  }
  return { id: policy.id, version: policy.version,
    requirementMultiplier: typeof policy.playthroughMultiplier === 'number'
      ? policy.playthroughMultiplier : policy.playthroughMultiplier.toNumber() };
}

async function lockReview(tx: Tx, reviewId: string): Promise<ReviewRow> {
  const reviews = (await tx.$queryRaw`
    SELECT "id","userId","lotId","status","resolvedBy",
           "secondApproverId","resolutionOperationId","evidence"
    FROM "legacy_balance_reviews" WHERE "id"=${reviewId} FOR UPDATE
  `) as ReviewRow[];
  if (!reviews[0]) throw ApiError.notFound('Legacy balance review not found');
  return reviews[0];
}

async function lockWalletAndLot(tx: Tx, review: ReviewRow): Promise<{ walletBalance: number; lot: LotRow }> {
  const wallets = (await tx.$queryRaw`
    SELECT "coinsBalance" FROM "wallets" WHERE "userId"=${review.userId} FOR UPDATE
  `) as { coinsBalance: number }[];
  if (!wallets[0]) throw ApiError.internal('Reviewed user has no wallet');
  const lots = (await tx.$queryRaw`
    SELECT "id","userId","lotClass"::text AS "lotClass", "state"::text AS "state",
           "reviewId","availableAmount","reservedAmount","rootLotId"
    FROM "coin_provenance" WHERE "id"=${review.lotId} FOR UPDATE
  `) as LotRow[];
  const lot = lots[0];
  if (!lot || lot.userId !== review.userId || lot.reviewId !== review.id
      || lot.lotClass !== 'UNCLASSIFIED' || lot.state !== 'OPEN'
      || lot.availableAmount === null || lot.availableAmount < 0
      || lot.reservedAmount !== 0) {
    throw ApiError.conflict('Reviewed value is unavailable or reserved; retry after its hold ends');
  }
  return { walletBalance: wallets[0].coinsBalance, lot };
}

/** A changed lot or policy voids only the pending approval, never Coin history. */
async function reopenStaleApproval(tx: Tx, review: ReviewRow, reason: string,
  observedAvailableAmount?: number) {
  const evidence = asEvidenceObject(review.evidence);
  const prior = Array.isArray(evidence.invalidatedApprovals)
    ? evidence.invalidatedApprovals : [];
  await tx.legacyBalanceReview.update({ where: { id: review.id }, data: {
    status: 'OPEN', resolvedBy: null,
    evidence: {
      ...evidence,
      proposal: null,
      firstApprovedAt: null,
      invalidatedApprovals: [...prior, {
        firstApproverId: review.resolvedBy,
        proposal: evidence.proposal ?? null,
        invalidatedAt: new Date().toISOString(),
        reason,
        ...(observedAvailableAmount === undefined ? {} : { observedAvailableAmount }),
      }],
    },
  } });
  return { stale: true as const, reason };
}

/** First independent administrator fixes the exact current amount and terms. */
export async function firstApproveLegacyReview(
  actorId: string, reviewId: string, proposal: LegacyResolutionProposal,
) {
  validateProposal(proposal);
  return prisma.$transaction(async (tx) => {
    await lockScope(tx, reviewId); // L0
    const metadata = await tx.legacyBalanceReview.findUnique({
      where: { id: reviewId }, select: { userId: true },
    });
    if (!metadata) throw ApiError.notFound('Legacy balance review not found');
    await lockAdminAndOwner(tx, actorId, metadata.userId); // L1
    const policy = await activePolicyForProposal(tx, proposal); // L3
    const review = await lockReview(tx, reviewId); // L4
    if (review.userId !== metadata.userId) throw ApiError.conflict('Review owner changed');
    if (review.status !== 'OPEN') throw ApiError.conflict('Review already has an approval or resolution');
    const { lot } = await lockWalletAndLot(tx, review); // L5, L6
    if (lot.availableAmount === 0) throw ApiError.conflict('Review lot has no available value');
    const requirementAmount = policy
      ? Math.ceil(lot.availableAmount * policy.requirementMultiplier) : 0;
    if (!Number.isSafeInteger(requirementAmount) || requirementAmount > 2_000_000_000) {
      throw ApiError.badRequest('Restricted review requirement exceeds Coin limit');
    }
    const stored: StoredProposal = { ...proposal, amount: lot.availableAmount,
      policyId: policy?.id ?? null, policyVersion: policy?.version ?? null,
      requirementAmount };
    return tx.legacyBalanceReview.update({ where: { id: reviewId }, data: {
      status: 'FIRST_APPROVED', resolvedBy: actorId,
      evidence: { ...asEvidenceObject(review.evidence), proposal: stored,
        firstApprovedAt: new Date().toISOString() } as unknown as Prisma.InputJsonValue,
    } });
  });
}

/** Second, distinct administrator commits one immutable LEGACY_RESOLVE operation. */
export async function secondApproveLegacyReview(actorId: string, reviewId: string) {
  const result = await prisma.$transaction(async (tx) => {
    await lockScope(tx, reviewId); // L0
    const metadata = await tx.legacyBalanceReview.findUnique({
      where: { id: reviewId }, select: { userId: true, evidence: true, resolvedBy: true,
        status: true, secondApproverId: true, resolutionOperationId: true },
    });
    if (!metadata) throw ApiError.notFound('Legacy balance review not found');
    const proposed = (metadata.evidence as { proposal?: StoredProposal } | null)?.proposal;
    if (!proposed) throw ApiError.conflict('Review has no first approval');
    validateProposal(proposed);
    await lockAdminAndOwner(tx, actorId, metadata.userId); // L1
    // Both approvals must still be held by active SUPER_ADMINs when the value
    // moves; the database refuses the resolution otherwise.
    const firstApprover = metadata.resolvedBy ? (await tx.$queryRaw`
      SELECT "role"::text AS "role", "status"::text AS "status"
      FROM "users" WHERE "id"=${metadata.resolvedBy} FOR SHARE
    `) as { role: string; status: string }[] : [];
    const firstApproverActive = firstApprover[0]?.role === 'SUPER_ADMIN' && firstApprover[0]?.status === 'ACTIVE';
    // An exact replay must not depend on a policy version that was
    // legitimately deactivated after the review committed.
    if (metadata.status === 'RESOLVED' && metadata.secondApproverId === actorId
        && metadata.resolutionOperationId) {
      return { reviewId, operationId: metadata.resolutionOperationId, idempotent: true };
    }
    const policy = await activePolicyForProposal(tx, proposed, true); // L3
    const review = await lockReview(tx, reviewId); // L4
    if (review.status === 'RESOLVED' && review.secondApproverId === actorId
        && review.resolutionOperationId) {
      return { reviewId, operationId: review.resolutionOperationId, idempotent: true };
    }
    if (review.status !== 'FIRST_APPROVED' || !review.resolvedBy
        || review.resolvedBy === actorId) {
      throw ApiError.conflict('A distinct second administrator must approve the pending review');
    }
    if (review.resolvedBy !== metadata.resolvedBy || !firstApproverActive) {
      return reopenStaleApproval(tx, review,
        'First approver is no longer an active SUPER_ADMIN; the review needs a new first approval');
    }
    const stored = (review.evidence as { proposal?: StoredProposal } | null)?.proposal;
    if (!stored || JSON.stringify(stored) !== JSON.stringify(proposed)) {
      throw ApiError.conflict('Review proposal changed during approval');
    }
    if (stored.decision === 'RESTRICTED' &&
        (policy?.id !== stored.policyId || policy?.version !== stored.policyVersion)) {
      return reopenStaleApproval(tx, review,
        'Country policy changed; the review needs a new first approval');
    }
    const { walletBalance, lot } = await lockWalletAndLot(tx, review); // L5, L6
    if (lot.availableAmount !== stored.amount) {
      return reopenStaleApproval(tx, review,
        'Reviewed Coin amount changed; first approval must be renewed', lot.availableAmount);
    }
    if (stored.amount <= 0 || walletBalance < stored.amount) {
      throw ApiError.conflict('Reviewed Coin balance is inconsistent');
    }
    let walletTransactionIds: string[] = [];
    if (stored.decision === 'FORFEIT') {
      const change = await applyBalanceChanges(tx, review.userId, [{
        currency: 'COINS', amount: stored.amount, ledgerType: 'DEBIT',
        transactionType: 'COIN_DEBIT', referenceType: 'ADMIN', referenceId: reviewId,
        description: `Legacy balance forfeiture after independent review ${reviewId}`,
      }], { coinLedgerIntent: COIN_LEDGER_INTENT });
      walletTransactionIds = change.transactions.map((row: { id: string }) => row.id);
    }
    const operation = await tx.economicOperation.create({ data: {
      type: 'LEGACY_RESOLVE', userId: review.userId,
      scopeType: 'REVIEW', scopeId: reviewId, createdBy: actorId,
      countryPolicyId: stored.policyId, countryPolicyVersion: stored.policyVersion,
      walletTransactionIds,
      snapshot: { evidence: review.evidence, firstApproverId: review.resolvedBy,
        secondApproverId: actorId, decision: stored.decision, amount: stored.amount },
    } });
    await tx.coinLotEntry.create({ data: {
      operationId: operation.id, lotId: lot.id, userId: review.userId, sequence: 0,
      entryType: stored.decision === 'FORFEIT' ? 'FORFEIT' : 'RECLASS_OUT',
      availableDelta: -stored.amount,
    } });
    if (stored.decision !== 'FORFEIT') {
      const withdrawable = stored.decision === 'WITHDRAWABLE';
      const successor = await tx.coinProvenance.create({ data: {
        userId: review.userId, amount: stored.amount,
        provenanceType: withdrawable ? 'ADMIN_ADJUSTMENT' : 'PROMOTION',
        restrictionStatus: withdrawable ? 'UNRESTRICTED' : 'RESTRICTED',
        originalSource: withdrawable ? 'ADMIN_ADJUSTMENT' : 'PROMOTION',
        countryPolicyId: stored.policyId, countryPolicyVersion: stored.policyVersion,
        requiredPlaythrough: stored.requirementAmount, completedPlaythrough: 0,
        lotClass: stored.decision, state: 'OPEN', availableAmount: 0, reservedAmount: 0,
        requirementAmount: 0, progressAmount: 0,
        mintedAt: new Date(), availableAt: new Date(), sourceOperationId: operation.id,
        parentLotId: lot.id, rootLotId: lot.rootLotId ?? lot.id,
      } });
      await tx.coinLotEntry.create({ data: {
        operationId: operation.id, lotId: successor.id, userId: review.userId,
        sequence: 1, entryType: 'RECLASS_IN', availableDelta: stored.amount,
        obligationDelta: stored.requirementAmount,
      } });
    }
    await tx.coinProvenance.update({ where: { id: lot.id }, data: {
      state: stored.decision === 'FORFEIT' ? 'FORFEITED' : 'RECLASSIFIED',
      closedAt: new Date(),
    } });
    await tx.legacyBalanceReview.update({ where: { id: reviewId }, data: {
      status: 'RESOLVED', secondApproverId: actorId,
      resolutionOperationId: operation.id, resolvedAt: new Date(),
    } });
    await flushCoinLedgerConstraints(tx);
    return { reviewId, operationId: operation.id, idempotent: false };
  }, { isolationLevel: 'Serializable', timeout: 120_000 });
  // Throw only after the stale approval has been invalidated and committed.
  // Throwing inside the transaction would roll the OPEN transition back.
  if ('stale' in result) throw ApiError.conflict(result.reason);
  return result;
}
