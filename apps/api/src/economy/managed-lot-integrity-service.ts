import { prisma } from '@socialplay/database';
import type { Prisma } from '@socialplay/database';
import { ApiError } from '../middleware/error-handler.js';
import { flushCoinLedgerConstraints } from './coin-ledger-service.js';
import { lockAdminAndOwner } from './legacy-review-service.js';
import { applyBalanceChanges, COIN_LEDGER_INTENT } from './wallet-service.js';

type Tx = Prisma.TransactionClient;

export type ManagedLotAnomalyType =
  | 'MISSING_SOURCE_OPERATION' | 'INVALID_SOURCE_OPERATION'
  | 'CROSS_USER_SOURCE_OPERATION' | 'CACHE_ENTRY_MISMATCH' | 'WALLET_LOT_MISMATCH';

export interface ManagedLotIntegrityProposal {
  anomalyType: ManagedLotAnomalyType;
  /** The two admins' attested TRUE available amount. For a lot-scoped
   * anomaly this replaces the closed lot's value; for WALLET_LOT_MISMATCH
   * it is the shortfall to mint (wallet balance minus summed lots), and can
   * only correct a wallet that has MORE Coins than its lots explain — the
   * opposite direction always means some specific lot is also wrong, which
   * this same tool can remediate directly once identified. */
  proposedAvailableAmount: number;
  rationale: string;
  supportingEvidence: string[];
}

interface IntegrityTarget {
  userId: string;
  /** Omit for a WALLET_LOT_MISMATCH review with no single identifiable lot. */
  lotId?: string;
}

type ReviewRow = {
  id: string; userId: string; lotId: string | null; anomalyType: ManagedLotAnomalyType;
  proposedAvailableAmount: number; evidence: Prisma.JsonValue; status: string;
  resolvedBy: string; secondApproverId: string | null; resolutionOperationId: string | null;
};

function validateProposal(proposal: ManagedLotIntegrityProposal): void {
  const validTypes: ManagedLotAnomalyType[] = ['MISSING_SOURCE_OPERATION', 'INVALID_SOURCE_OPERATION',
    'CROSS_USER_SOURCE_OPERATION', 'CACHE_ENTRY_MISMATCH', 'WALLET_LOT_MISMATCH'];
  if (!validTypes.includes(proposal.anomalyType)) {
    throw ApiError.badRequest('Unknown managed-lot integrity anomaly type');
  }
  if (!Number.isSafeInteger(proposal.proposedAvailableAmount) || proposal.proposedAvailableAmount < 0
      || proposal.proposedAvailableAmount > 2_000_000_000) {
    throw ApiError.badRequest('Proposed available amount must be a non-negative Coin integer');
  }
  if (typeof proposal.rationale !== 'string' || proposal.rationale.trim().length < 10
      || !Array.isArray(proposal.supportingEvidence) || proposal.supportingEvidence.length === 0
      || proposal.supportingEvidence.some((x) => typeof x !== 'string' || !x.trim())) {
    throw ApiError.badRequest('Managed-lot integrity remediation requires a rationale and evidence');
  }
}

async function lockScope(tx: Tx, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM
    (SELECT pg_advisory_xact_lock(hashtextextended(${'managed_lot_integrity:' + userId}, 0))) AS acquired`;
}

/** The same live definition of "malformed" used by the migration gate and
 * the ongoing invariant scan (I15) — a remediation may never target
 * something this function does not currently flag. */
async function assertAnomalyStillPresent(tx: Tx, target: IntegrityTarget, anomalyType: ManagedLotAnomalyType): Promise<void> {
  const targetId = target.lotId ?? target.userId;
  const rows = (await tx.$queryRaw`
    SELECT 1 FROM "check_populated_upgrade_integrity"() v
    WHERE v.category = ${anomalyType} AND v.id = ${targetId}
  `) as unknown[];
  if (rows.length === 0) {
    throw ApiError.conflict('This anomaly is no longer present; remediation is not needed (or targets the wrong record)');
  }
}

async function lockReview(tx: Tx, reviewId: string): Promise<ReviewRow> {
  const rows = (await tx.$queryRaw`
    SELECT "id","userId","lotId","anomalyType","proposedAvailableAmount","evidence","status",
           "resolvedBy","secondApproverId","resolutionOperationId"
    FROM "managed_lot_integrity_reviews" WHERE "id"=${reviewId} FOR UPDATE
  `) as ReviewRow[];
  if (!rows[0]) throw ApiError.notFound('Managed-lot integrity review not found');
  return rows[0];
}

/** First independent administrator proposes the true value. There is no
 * pre-existing OPEN row (unlike legacy_balance_reviews, nothing auto-opens
 * one for a managed-lot anomaly) — this call both creates the review and
 * records its first approval in a single audited step. */
export async function firstApproveManagedLotIntegrityRemediation(
  actorId: string, target: IntegrityTarget, proposal: ManagedLotIntegrityProposal,
): Promise<{ reviewId: string }> {
  validateProposal(proposal);
  if (proposal.anomalyType === 'WALLET_LOT_MISMATCH' && target.lotId) {
    throw ApiError.badRequest('WALLET_LOT_MISMATCH reviews target a user, not a lot');
  }
  if (proposal.anomalyType !== 'WALLET_LOT_MISMATCH' && !target.lotId) {
    throw ApiError.badRequest('This anomaly type requires a specific lot');
  }
  return prisma.$transaction(async (tx) => {
    await lockScope(tx, target.userId); // L0
    const owner = await tx.user.findUnique({ where: { id: target.userId }, select: { id: true } });
    if (!owner) throw ApiError.notFound('Target user not found');
    await lockAdminAndOwner(tx, actorId, target.userId); // L1
    if (target.lotId) {
      const lots = (await tx.$queryRaw`
        SELECT "id" FROM "coin_provenance" WHERE "id"=${target.lotId} AND "userId"=${target.userId} FOR UPDATE
      `) as { id: string }[];
      if (!lots[0]) throw ApiError.notFound('Target lot not found for this user');
    }
    await assertAnomalyStillPresent(tx, target, proposal.anomalyType);
    const review = await tx.managedLotIntegrityReview.create({ data: {
      userId: target.userId, lotId: target.lotId ?? null, anomalyType: proposal.anomalyType,
      proposedAvailableAmount: proposal.proposedAvailableAmount, resolvedBy: actorId,
      evidence: { rationale: proposal.rationale, supportingEvidence: proposal.supportingEvidence,
        firstApprovedAt: new Date().toISOString() } as unknown as Prisma.InputJsonValue,
    } });
    return { reviewId: review.id };
  });
}

/** Second, distinct administrator commits one immutable
 * LEGACY_INTEGRITY_REMEDIATION operation. This is the only step that
 * changes ledger state — marking a review "resolved" alone never does. */
export async function secondApproveManagedLotIntegrityRemediation(
  actorId: string, reviewId: string,
): Promise<{ reviewId: string; operationId: string; idempotent: boolean }> {
  return prisma.$transaction(async (tx) => {
    const metadata = await tx.managedLotIntegrityReview.findUnique({
      where: { id: reviewId }, select: { userId: true, status: true, secondApproverId: true, resolutionOperationId: true },
    });
    if (!metadata) throw ApiError.notFound('Managed-lot integrity review not found');
    await lockScope(tx, metadata.userId); // L0
    if (metadata.status === 'RESOLVED' && metadata.secondApproverId === actorId && metadata.resolutionOperationId) {
      return { reviewId, operationId: metadata.resolutionOperationId, idempotent: true };
    }
    await lockAdminAndOwner(tx, actorId, metadata.userId); // L1
    const review = await lockReview(tx, reviewId); // L4
    if (review.status === 'RESOLVED' && review.secondApproverId === actorId && review.resolutionOperationId) {
      return { reviewId, operationId: review.resolutionOperationId, idempotent: true };
    }
    if (review.status !== 'FIRST_APPROVED' || review.resolvedBy === actorId) {
      throw ApiError.conflict('A distinct second administrator must approve the pending review');
    }
    const target: IntegrityTarget = { userId: review.userId, lotId: review.lotId ?? undefined };
    await assertAnomalyStillPresent(tx, target, review.anomalyType);

    const evidence = review.evidence && typeof review.evidence === 'object' && !Array.isArray(review.evidence)
      ? review.evidence as Record<string, unknown> : {};

    // A lot-scoped anomaly's admin-attested amount was never reflected in
    // the wallet by the original corruption (that is exactly why wallet and
    // lots disagree even after the lot itself is fixed) — crediting it here
    // is what makes the two agree again, the same as every other MINT path
    // in this module pairs a wallet credit with its lot/entry write.
    // WALLET_LOT_MISMATCH is the opposite case: the wallet already holds the
    // true value and only a lot is missing, so no wallet credit is needed.
    let walletTransactionIds: string[] = [];
    if (review.lotId && review.proposedAvailableAmount > 0) {
      const credit = await applyBalanceChanges(tx, review.userId, [{
        currency: 'COINS', amount: review.proposedAvailableAmount, ledgerType: 'CREDIT',
        transactionType: 'COIN_CREDIT', referenceType: 'ADMIN', referenceId: reviewId,
        description: `Managed-lot integrity remediation for lot ${review.lotId}`,
      }], { coinLedgerIntent: COIN_LEDGER_INTENT });
      walletTransactionIds = [credit.transactions[0].id];
    }

    const operation = await tx.economicOperation.create({ data: {
      type: 'LEGACY_INTEGRITY_REMEDIATION', userId: review.userId,
      scopeType: 'MANAGED_LOT_INTEGRITY_REVIEW', scopeId: reviewId, createdBy: actorId,
      walletTransactionIds,
      snapshot: { evidence, firstApproverId: review.resolvedBy, secondApproverId: actorId,
        anomalyType: review.anomalyType, proposedAvailableAmount: review.proposedAvailableAmount,
      } as unknown as Prisma.InputJsonValue,
    } });
    // Marked RESOLVED before the lot write below: coin_lot_row_guard's
    // INTEGRITY_REMEDIATED exemption requires a RESOLVED review naming the
    // lot to already exist, and reads it within this same transaction.
    await tx.managedLotIntegrityReview.update({ where: { id: reviewId }, data: {
      status: 'RESOLVED', secondApproverId: actorId, resolutionOperationId: operation.id, resolvedAt: new Date(),
    } });

    if (review.lotId) {
      const lots = (await tx.$queryRaw`
        SELECT "id","userId","lotClass"::text AS "lotClass","rootLotId","countryPolicyId","countryPolicyVersion"
        FROM "coin_provenance" WHERE "id"=${review.lotId} AND "userId"=${review.userId} FOR UPDATE
      `) as { id: string; userId: string; lotClass: string; rootLotId: string | null;
        countryPolicyId: string | null; countryPolicyVersion: number | null }[];
      const lot = lots[0];
      if (!lot) throw ApiError.internal('Reviewed lot disappeared during remediation');
      // Close the malformed lot: its history cannot be honestly explained by
      // forward-only entries (that is precisely the nature of pre-existing
      // corruption), so its cache is set directly to zero. The DB guard
      // (coin_lot_row_guard / coin_lot_journal_integrity_guard) accepts this
      // ONLY because a RESOLVED review naming this exact lot now exists.
      await tx.coinProvenance.update({ where: { id: lot.id }, data: {
        state: 'INTEGRITY_REMEDIATED', availableAmount: 0, reservedAmount: 0,
        requirementAmount: 0, progressAmount: 0, closedAt: new Date(),
      } });
      if (review.proposedAvailableAmount > 0) {
        const successor = await tx.coinProvenance.create({ data: {
          userId: review.userId, amount: review.proposedAvailableAmount,
          provenanceType: 'ADMIN_ADJUSTMENT', restrictionStatus: 'UNRESTRICTED',
          originalSource: 'ADMIN_ADJUSTMENT',
          countryPolicyId: lot.countryPolicyId, countryPolicyVersion: lot.countryPolicyVersion,
          lotClass: lot.lotClass as never, state: 'OPEN',
          availableAmount: 0, reservedAmount: 0, requirementAmount: 0, progressAmount: 0,
          mintedAt: new Date(), availableAt: new Date(), sourceOperationId: operation.id,
          parentLotId: lot.id, rootLotId: lot.rootLotId ?? lot.id,
        } });
        await tx.coinLotEntry.create({ data: {
          operationId: operation.id, lotId: successor.id, userId: review.userId,
          sequence: 0, entryType: 'MINT', availableDelta: review.proposedAvailableAmount,
        } });
      }
    } else {
      // WALLET_LOT_MISMATCH: mint the shortfall into a fresh UNCLASSIFIED
      // lot, immediately handed to the EXISTING dual-admin classification
      // review (legacy-review-service.ts) — this tool never decides
      // withdrawability itself, only that the shortfall's existence is
      // now explained by a real operation and entry.
      if (review.proposedAvailableAmount <= 0) {
        throw ApiError.badRequest('Wallet mismatch remediation requires a positive shortfall amount');
      }
      const successor = await tx.coinProvenance.create({ data: {
        userId: review.userId, amount: review.proposedAvailableAmount,
        provenanceType: 'ADMIN_ADJUSTMENT', restrictionStatus: 'UNRESTRICTED',
        originalSource: 'ADMIN_ADJUSTMENT',
        lotClass: 'UNCLASSIFIED', state: 'OPEN',
        availableAmount: 0, reservedAmount: 0, requirementAmount: 0, progressAmount: 0,
        mintedAt: new Date(), availableAt: new Date(), sourceOperationId: operation.id,
      } });
      // The lot must already carry a reviewId before any entry raises its
      // availableAmount above zero — coin_lot_row_guard rejects a classified
      // user's UNCLASSIFIED value-bearing lot that has none.
      const followUpReview = await tx.legacyBalanceReview.create({ data: {
        userId: review.userId, lotId: successor.id, amount: review.proposedAvailableAmount,
        evidence: { reason: 'managed-lot-integrity wallet/lot mismatch remediation',
          managedLotIntegrityReviewId: reviewId } as unknown as Prisma.InputJsonValue,
      } });
      await tx.coinProvenance.update({ where: { id: successor.id }, data: { reviewId: followUpReview.id } });
      await tx.coinLotEntry.create({ data: {
        operationId: operation.id, lotId: successor.id, userId: review.userId,
        sequence: 0, entryType: 'MINT', availableDelta: review.proposedAvailableAmount,
      } });
    }

    await flushCoinLedgerConstraints(tx);
    return { reviewId, operationId: operation.id, idempotent: false };
  }, { isolationLevel: 'Serializable', timeout: 120_000 });
}
