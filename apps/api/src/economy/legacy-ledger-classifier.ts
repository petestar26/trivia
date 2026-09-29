import { createHash } from 'node:crypto';
import { prisma } from '@socialplay/database';
import type { Prisma } from '@socialplay/database';
import { ApiError } from '../middleware/error-handler.js';
import { allocateFunding, splitPayout } from './coin-allocator.js';
import { flushCoinLedgerConstraints } from './coin-ledger-service.js';
import type { FundingShare, LotClass } from './coin-allocator.js';

type Tx = Prisma.TransactionClient;
// Historical rows read via raw SQL (SELECT *): typed with only the columns
// this module actually reads off "coin_provenance", not the full row shape.
type RawCoinProvenanceRow = {
  id: string; sourceOperationId: string | null; lotClass: LotClass | null;
  state: string | null; availableAmount: number | null; reservedAmount: number | null;
  requirementAmount: number | null; progressAmount: number | null; createdAt: Date;
};
type PolicyPin = { id: string; version: number; multiplier: number;
  qualifyingGames: string[]; maxQualifyingStake: number; maxConversionMultiple: number | null };
type ReplayLot = {
  id: string; lotClass: LotClass; availableAmount: number; requirementAmount: number;
  progressAmount: number; mintedAt: Date; availableAt: Date; expiresAt: Date | null;
  sourceWalletTransactionId: string; sourceKind: 'PURCHASE' | 'BONUS' | 'BONUS_CONVERSION' | 'UNKNOWN';
  sourceScopeId: string; originalGrantAmount: number; policy: PolicyPin | null; reason?: string;
};
type LedgerRow = { id: string; userId: string; amount: number; balanceBefore: number;
  balanceAfter: number; type: string; ledgerType: string; referenceType: string;
  referenceId: string | null; status: string; createdAt: Date };

type TerminalHold = { id: string; withdrawalId: string; coinAmount: number;
  status: 'CONSUMED' | 'REFUNDED'; debitWalletTransactionId: string;
  refundWalletTransactionId: string | null; createdAt: Date;
  consumedAt: Date | null; releasedAt: Date | null };

export interface LegacyReplayPlan {
  userId: string; walletBalance: number; ledgerReplayHash: string;
  sources: ReplayLot[]; reviewAmount: number; reviewReasons: string[];
  ledgerReconciled: boolean; oldAvailableAmount: number; activeReservedAmount: number;
  purchaseOverageAmount: number; conversionOverageAmount: number;
  idempotent?: boolean;
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && value !== null && 'toNumber' in value) {
    return (value as { toNumber(): number }).toNumber();
  }
  return Number(value);
}

function walletLedgerHash(rows: LedgerRow[], walletBalance: number): string {
  return createHash('sha256').update(JSON.stringify({ walletBalance,
    rows: rows.map((row) => [row.id, row.createdAt.toISOString(), row.type,
      row.ledgerType, row.amount, row.balanceBefore, row.balanceAfter,
      row.referenceType, row.referenceId]),
  })).digest('hex');
}

function reconciles(rows: LedgerRow[], walletBalance: number): boolean {
  if (rows.length === 0) return walletBalance === 0;
  let running = 0;
  for (const row of rows) {
    const delta = row.ledgerType === 'CREDIT' ? row.amount
      : row.ledgerType === 'DEBIT' ? -row.amount : Number.NaN;
    if (!Number.isSafeInteger(row.amount) || row.amount <= 0
        || row.balanceBefore !== running || row.balanceAfter !== running + delta) return false;
    running = row.balanceAfter;
  }
  return running === walletBalance;
}

async function replayLedger(
  tx: Tx, userId: string, walletBalance: number, rows: LedgerRow[], _hash: string,
): Promise<{ sources: ReplayLot[]; reasons: string[]; reconciled: boolean;
  purchaseOverageAmount: number; conversionOverageAmount: number }> {
  if (!reconciles(rows, walletBalance)) {
    return { sources: walletBalance > 0 ? [{
      id: 'unreconciled-wallet', lotClass: 'UNCLASSIFIED', availableAmount: walletBalance,
      requirementAmount: 0, progressAmount: 0, mintedAt: new Date(), availableAt: new Date(),
      expiresAt: null, sourceWalletTransactionId: '', sourceKind: 'UNKNOWN',
      sourceScopeId: userId, originalGrantAmount: walletBalance, policy: null,
      reason: 'Wallet and chronological COINS transactions do not reconcile',
    }] : [], reasons: ['Wallet and chronological COINS transactions do not reconcile'],
    reconciled: false, purchaseOverageAmount: 0, conversionOverageAmount: 0 };
  }

  const settlements = await tx.agentOrderSettlement.findMany({
    where: { order: { userId } }, include: { order: true },
  });
  const purchaseByWalletRow = new Map<string, (typeof settlements)[number]>();
  for (const settlement of settlements) purchaseByWalletRow.set(settlement.walletTransactionId, settlement);
  const referenceIds = rows.map((row) => row.referenceId).filter((id): id is string => !!id);
  const sessions = await tx.gameSession.findMany({
    where: { userId, id: { in: referenceIds } }, include: { game: true },
  });
  const sessionById = new Map(sessions.map((session) => [session.id, session] as const));
  const originalLots = await tx.coinProvenance.findMany({
    where: { userId }, include: { countryPolicy: true },
  });
  const bonusByWalletRow = new Map<string, (typeof originalLots)[number]>();
  for (const lot of originalLots) {
    if (lot.provenanceType === 'TRIVIA_REWARD' && lot.walletTransactionId) {
      bonusByWalletRow.set(lot.walletTransactionId, lot);
    }
  }
  const holds = await tx.withdrawalHold.findMany({
    where: { withdrawal: { userId } }, include: { withdrawal: true },
  });
  const holdByWithdrawalId = new Map(holds.map((hold) => [hold.withdrawalId, hold] as const));

  const all = new Map<string, ReplayLot>();
  const wagerFunding = new Map<string, FundingShare[]>();
  const withdrawalFunding = new Map<string, FundingShare[]>();
  const reasons: string[] = [];
  let purchaseOverageAmount = 0;
  let conversionOverageAmount = 0;
  const reviewWholeWallet = (reason: string, at: Date) => ({
    sources: walletBalance > 0 ? [{
      id: 'unreconciled-funding', lotClass: 'UNCLASSIFIED' as const,
      availableAmount: walletBalance, requirementAmount: 0, progressAmount: 0,
      mintedAt: at, availableAt: at, expiresAt: null,
      sourceWalletTransactionId: '', sourceKind: 'UNKNOWN' as const,
      sourceScopeId: userId, originalGrantAmount: walletBalance, policy: null,
      reason,
    }] : [],
    reasons: [reason], reconciled: false,
    purchaseOverageAmount: 0, conversionOverageAmount: 0,
  });
  const addUnknown = (row: LedgerRow, reason: string, amount = row.amount) => {
    const id = `unknown:${row.id}:${all.size}`;
    all.set(id, { id, lotClass: 'UNCLASSIFIED', availableAmount: amount,
      requirementAmount: 0, progressAmount: 0, mintedAt: row.createdAt,
      availableAt: row.createdAt, expiresAt: null, sourceWalletTransactionId: row.id,
      sourceKind: 'UNKNOWN', sourceScopeId: row.id, originalGrantAmount: amount,
      policy: null, reason });
    reasons.push(`${row.id}: ${reason}`);
  };
  const finishBonus = (row: LedgerRow) => {
    for (const lot of [...all.values()]) {
      if (lot.lotClass !== 'RESTRICTED' || lot.progressAmount < lot.requirementAmount) continue;
      const cap = lot.policy?.maxConversionMultiple === null || lot.policy?.maxConversionMultiple === undefined
        ? lot.availableAmount
        : Math.floor(lot.originalGrantAmount * lot.policy.maxConversionMultiple);
      const converted = Math.min(lot.availableAmount, cap);
      const excess = lot.availableAmount - converted;
      lot.availableAmount = 0;
      if (converted > 0) {
        const id = `converted:${lot.id}`;
        all.set(id, { ...lot, id, lotClass: 'WITHDRAWABLE',
          sourceKind: 'BONUS_CONVERSION', availableAmount: converted,
          mintedAt: row.createdAt, availableAt: row.createdAt });
      }
      if (excess > 0) {
        conversionOverageAmount += excess;
        addUnknown(row, 'Legacy bonus value exceeds the pinned conversion cap', excess);
      }
    }
  };

  for (const row of rows) {
    if (row.ledgerType === 'DEBIT') {
      const withdrawalHold = row.referenceType === 'WITHDRAWAL' && row.referenceId
        ? holdByWithdrawalId.get(row.referenceId) : null;
      // The old withdrawal allocator drew only UNRESTRICTED provenance.
      // An unlinked or mismatched debit cannot be attributed to a hold. Fail
      // closed into admin review instead of spending a bonus on paper and
      // leaving an overstated withdrawable purchase lot.
      if (row.referenceType === 'WITHDRAWAL' && (
          row.type !== 'COIN_DEBIT' || !withdrawalHold
          || withdrawalHold.debitWalletTransactionId !== row.id
          || withdrawalHold.coinAmount !== row.amount)) {
        return reviewWholeWallet('Historical withdrawal debit lacks an exact hold link', row.createdAt);
      }
      let shares: FundingShare[];
      try {
        const eligible = [...all.values()].filter((lot) => lot.availableAmount > 0
          && (row.referenceType !== 'WITHDRAWAL' || lot.lotClass === 'WITHDRAWABLE'));
        shares = allocateFunding(eligible, row.amount);
      } catch {
        return reviewWholeWallet('Historical debit cannot be funded by proven chronological credits', row.createdAt);
      }
      for (const share of shares) all.get(share.lotId)!.availableAmount -= share.amount;
      const session = row.referenceId ? sessionById.get(row.referenceId) : null;
      if (row.referenceType === 'GAME' && session?.mode === 'WAGER'
          && session.betAmount === row.amount && session.settlementDebitCurrency === 'COINS') {
        wagerFunding.set(session.id, shares);
        for (const share of shares) {
          const lot = all.get(share.lotId)!;
          if (lot.lotClass !== 'RESTRICTED' || !lot.policy) continue;
          if (lot.expiresAt && lot.expiresAt <= row.createdAt) continue;
          if (!lot.policy.qualifyingGames.includes(session.game.key)
              || row.amount > lot.policy.maxQualifyingStake) continue;
          lot.progressAmount = Math.min(lot.requirementAmount, lot.progressAmount + share.amount);
        }
        if (session.rewardAmount === 0) finishBonus(row);
      } else if (withdrawalHold && row.referenceId) {
        withdrawalFunding.set(row.referenceId, shares);
      }
      continue;
    }

    const purchase = purchaseByWalletRow.get(row.id);
    if (row.type === 'COIN_CREDIT' && row.referenceType === 'AGENT_ORDER' && purchase
        && row.referenceId === purchase.orderId && purchase.order.userId === userId
        && purchase.coinAmount === row.amount && purchase.order.coinAmount === row.amount) {
      const id = `purchase:${purchase.orderId}`;
      all.set(id, { id, lotClass: 'WITHDRAWABLE', availableAmount: row.amount,
        requirementAmount: 0, progressAmount: 0, mintedAt: row.createdAt,
        availableAt: row.createdAt, expiresAt: null, sourceWalletTransactionId: row.id,
        sourceKind: 'PURCHASE', sourceScopeId: purchase.orderId,
        originalGrantAmount: row.amount, policy: null });
      continue;
    }

    const session = row.referenceId ? sessionById.get(row.referenceId) : null;
    const grant = bonusByWalletRow.get(row.id);
    if (row.type === 'COIN_CREDIT' && row.referenceType === 'GAME'
        && session?.mode === 'BONUS' && session.betAmount === 0
        && session.rewardAmount === row.amount && grant?.countryPolicy
        && grant.countryPolicy.version === grant.countryPolicyVersion) {
      const policy = grant.countryPolicy;
      const multiplier = asNumber(policy.playthroughMultiplier);
      const requirement = Math.ceil(row.amount * multiplier);
      if (Number.isSafeInteger(requirement) && requirement > 0 && requirement <= 2_000_000_000
          && Array.isArray(policy.qualifyingGames)) {
        const id = `bonus:${session.id}`;
        all.set(id, { id, lotClass: 'RESTRICTED', availableAmount: row.amount,
          requirementAmount: requirement, progressAmount: 0, mintedAt: row.createdAt,
          availableAt: row.createdAt, expiresAt: grant.expiresAt ?? null,
          sourceWalletTransactionId: row.id, sourceKind: 'BONUS', sourceScopeId: session.id,
          originalGrantAmount: row.amount,
          policy: { id: policy.id, version: policy.version, multiplier,
            qualifyingGames: policy.qualifyingGames as string[],
            maxQualifyingStake: policy.maxQualifyingStake,
            maxConversionMultiple: policy.maxConversionMultiple === null
              ? null : asNumber(policy.maxConversionMultiple) } });
        continue;
      }
    }

    if (row.type === 'COIN_CREDIT' && row.referenceType === 'GAME'
        && session?.mode === 'WAGER' && session.rewardAmount === row.amount
        && session.settlementCreditCurrency === 'COINS' && wagerFunding.has(session.id)) {
      const shares = splitPayout(wagerFunding.get(session.id)!, row.amount);
      for (const share of shares) all.get(share.lotId)!.availableAmount += share.amount;
      finishBonus(row);
      wagerFunding.delete(session.id);
      continue;
    }

    const hold = row.referenceId ? holdByWithdrawalId.get(row.referenceId) : null;
    if (row.type === 'COIN_CREDIT' && row.referenceType === 'WITHDRAWAL'
        && hold?.status === 'REFUNDED' && hold.refundWalletTransactionId === row.id
        && withdrawalFunding.has(row.referenceId!)) {
      const shares = withdrawalFunding.get(row.referenceId!)!;
      if (shares.reduce((sum, share) => sum + share.amount, 0) === row.amount) {
        for (const share of shares) {
          const lot = all.get(share.lotId);
          if (lot && lot.lotClass === share.lotClass) lot.availableAmount += share.amount;
          else addUnknown(row, 'Refund source became terminal during legacy history', share.amount);
        }
        withdrawalFunding.delete(row.referenceId!);
        continue;
      }
    }
    addUnknown(row, 'No complete provenance proof for historical COINS credit');
  }

  const final = [...all.values()].filter((lot) => lot.availableAmount > 0);
  // Do not classify purchased winnings beyond the original settled amount
  // until replay evidence can be independently bounded in the DB. Excess
  // remains available in UNCLASSIFIED review, never silently withdrawable.
  for (const lot of [...final]) {
    if (lot.sourceKind !== 'PURCHASE' || lot.availableAmount <= lot.originalGrantAmount) continue;
    const excess = lot.availableAmount - lot.originalGrantAmount;
    lot.availableAmount = lot.originalGrantAmount;
    purchaseOverageAmount += excess;
    const id = `purchase-overage:${lot.sourceScopeId}`;
    final.push({ ...lot, id, sourceKind: 'UNKNOWN', lotClass: 'UNCLASSIFIED',
      availableAmount: excess, reason: 'Purchased-lot winnings exceed the proven settlement amount' });
    reasons.push(`${lot.sourceWalletTransactionId}: purchased-lot winnings await review`);
  }
  const total = final.reduce((sum, lot) => sum + lot.availableAmount, 0);
  if (total !== walletBalance) {
    throw ApiError.internal(`Legacy replay value mismatch for ${userId}: ${total} vs ${walletBalance}`);
  }
  return { sources: final, reasons, reconciled: true,
    purchaseOverageAmount, conversionOverageAmount };
}

async function reverseOldOpeningLots(tx: Tx, userId: string, oldLots: RawCoinProvenanceRow[], hash: string): Promise<void> {
  for (const lot of oldLots) {
    if ((lot.availableAmount ?? 0) <= 0) continue;
    if (lot.lotClass !== 'UNCLASSIFIED' || lot.state !== 'OPEN' || lot.reservedAmount !== 0) {
      throw ApiError.conflict('Historical lot cannot be safely replayed');
    }
    const entries = await tx.coinLotEntry.findMany({
      where: { lotId: lot.id }, include: { operation: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const opening = entries.find((e) => e.entryType === 'MINT'
      && e.operation.type === 'LEGACY_OPENING' && e.operation.scopeType === 'LEGACY_LOT');
    const oldAllocations = entries.filter((e) => e.entryType === 'CONSUME'
      && e.operation.type === 'LEGACY_OPENING' && e.operation.scopeType === 'LEGACY_ALLOCATION');
    if (!opening || entries.length !== oldAllocations.length + 1) {
      throw ApiError.conflict('Historical provenance has unsupported entries; manual review required');
    }
    for (const old of oldAllocations) {
      const op = await tx.economicOperation.create({ data: {
        type: 'COMPENSATION', userId, scopeType: 'LEGACY_ALLOCATION', scopeId: old.operation.scopeId,
        reversesOperationId: old.operationId, walletTransactionIds: [], createdBy: 'SYSTEM',
        snapshot: { ledgerReplayHash: hash, reason: 'Reverse superseded allocation' },
      } });
      await tx.coinLotEntry.create({ data: {
        operationId: op.id, lotId: lot.id, userId, sequence: 0, entryType: old.entryType,
        availableDelta: -old.availableDelta, reservedDelta: -old.reservedDelta,
        progressDelta: -old.progressDelta, obligationDelta: -old.obligationDelta,
        reversesEntryId: old.id,
      } });
    }
    const op = await tx.economicOperation.create({ data: {
      type: 'COMPENSATION', userId, scopeType: 'LEGACY_LOT', scopeId: lot.id,
      reversesOperationId: opening.operationId, walletTransactionIds: [], createdBy: 'SYSTEM',
      snapshot: { ledgerReplayHash: hash, reason: 'Reverse superseded opening provenance' },
    } });
    await tx.coinLotEntry.create({ data: {
      operationId: op.id, lotId: lot.id, userId, sequence: 0, entryType: opening.entryType,
      availableDelta: -opening.availableDelta, reservedDelta: -opening.reservedDelta,
      progressDelta: -opening.progressDelta, obligationDelta: -opening.obligationDelta,
      reversesEntryId: opening.id,
    } });
    await tx.coinProvenance.update({ where: { id: lot.id },
      data: { state: 'RECLASSIFIED', closedAt: new Date() } });
  }
}

async function createReplaySource(tx: Tx, userId: string, amount: number,
  hash: string, plan: LegacyReplayPlan) {
  const op = await tx.economicOperation.create({ data: {
    type: 'LEGACY_OPENING', userId, scopeType: 'WALLET_REPLAY', scopeId: userId,
    walletTransactionIds: [], createdBy: 'SYSTEM',
    snapshot: { ledgerReplayHash: hash, openingBalance: amount,
      classificationPlan: JSON.parse(JSON.stringify(plan)) },
  } });
  if (amount === 0) return { lotId: null, operationId: op.id };
  const lot = await tx.coinProvenance.create({ data: {
    userId, amount, provenanceType: 'LEGACY_UNTRACKED', restrictionStatus: 'RESTRICTED',
    originalSource: 'LEGACY_UNTRACKED', requiredPlaythrough: 0, completedPlaythrough: 0,
    lotClass: 'UNCLASSIFIED', state: 'OPEN', availableAmount: 0, reservedAmount: 0,
    requirementAmount: 0, progressAmount: 0, mintedAt: new Date(), availableAt: new Date(),
    sourceOperationId: op.id,
  } });
  await tx.coinLotEntry.create({ data: {
    operationId: op.id, lotId: lot.id, userId, sequence: 0,
    entryType: 'MINT', availableDelta: amount,
  } });
  return { lotId: lot.id as string, operationId: op.id as string };
}

/** Superseded pre-journal rows retain their historical provenance but no
 * economic value. M7 permits exactly this one-time zero initialization. */
async function retireUnmanagedHistoricalLots(tx: Tx, oldLots: RawCoinProvenanceRow[], operationId: string) {
  for (const lot of oldLots) {
    if (lot.sourceOperationId !== null) continue;
    if (lot.lotClass !== null || lot.state !== null
        || lot.availableAmount !== null || lot.reservedAmount !== null
        || lot.requirementAmount !== null || lot.progressAmount !== null) {
      throw ApiError.conflict('Historical provenance has partial journal state; manual review required');
    }
    await tx.coinProvenance.update({ where: { id: lot.id }, data: {
      lotClass: 'UNCLASSIFIED', state: 'RECLASSIFIED',
      availableAmount: 0, reservedAmount: 0, requirementAmount: 0,
      progressAmount: 0, sourceOperationId: operationId,
      mintedAt: lot.createdAt, availableAt: lot.createdAt, closedAt: new Date(),
    } });
  }
}

/** Journal terminal pre-ledger withdrawals without adding their historical
 * value to today's wallet. The opening MINT/RESERVE records the old hold;
 * RELEASE or FINALIZE reverses its exact reservation. A refunded hold's
 * released value is folded into WALLET_REPLAY, which already classifies the
 * refund credit, so the transit lot finishes at zero rather than duplicating
 * the user's current balance. */
async function journalTerminalWithdrawalHistory(
  tx: Tx, userId: string, holds: TerminalHold[], rows: LedgerRow[], hash: string,
): Promise<void> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const hold of holds) {
    const debit = byId.get(hold.debitWalletTransactionId);
    if (!debit || debit.userId !== userId || debit.status !== 'SUCCEEDED'
        || debit.type !== 'COIN_DEBIT' || debit.ledgerType !== 'DEBIT'
        || debit.referenceType !== 'WITHDRAWAL' || debit.referenceId !== hold.withdrawalId
        || debit.amount !== hold.coinAmount) {
      throw ApiError.conflict('Historical withdrawal hold lacks its exact Coin debit proof');
    }
    const refund = hold.status === 'REFUNDED' && hold.refundWalletTransactionId
      ? byId.get(hold.refundWalletTransactionId) : null;
    if (hold.status === 'REFUNDED' && (!refund || refund.userId !== userId
        || refund.status !== 'SUCCEEDED' || refund.type !== 'COIN_CREDIT'
        || refund.ledgerType !== 'CREDIT' || refund.referenceType !== 'WITHDRAWAL'
        || refund.referenceId !== hold.withdrawalId || refund.amount !== hold.coinAmount
        || refund.createdAt < debit.createdAt)) {
      throw ApiError.conflict('Historical withdrawal refund lacks its exact Coin credit proof');
    }
    if (hold.status === 'CONSUMED' && hold.refundWalletTransactionId !== null) {
      throw ApiError.conflict('Consumed historical withdrawal has a refund credit');
    }

    const opening = await tx.economicOperation.create({ data: {
      type: 'LEGACY_OPENING', userId, scopeType: 'WITHDRAWAL', scopeId: hold.withdrawalId,
      walletTransactionIds: [debit.id], createdBy: 'SYSTEM', createdAt: debit.createdAt,
      snapshot: { ledgerReplayHash: hash, historicalTerminalHold: true,
        holdId: hold.id, status: hold.status },
    } });
    const transit = await tx.coinProvenance.create({ data: {
      userId, amount: hold.coinAmount, provenanceType: 'WITHDRAWAL',
      restrictionStatus: 'RESTRICTED', originalSource: 'WITHDRAWAL',
      lotClass: 'UNCLASSIFIED', state: 'OPEN', availableAmount: 0,
      reservedAmount: 0, requirementAmount: 0, progressAmount: 0,
      mintedAt: debit.createdAt, availableAt: debit.createdAt,
      sourceOperationId: opening.id,
    } });
    await tx.coinLotEntry.create({ data: {
      operationId: opening.id, lotId: transit.id, userId, sequence: 0,
      entryType: 'MINT', availableDelta: hold.coinAmount,
    } });
    const reserve = await tx.coinLotEntry.create({ data: {
      operationId: opening.id, lotId: transit.id, userId, sequence: 1,
      entryType: 'RESERVE', availableDelta: -hold.coinAmount,
      reservedDelta: hold.coinAmount,
    } });
    await tx.withdrawalHold.update({ where: { id: hold.id },
      data: { holdOperationId: opening.id } });

    const terminal = await tx.economicOperation.create({ data: {
      type: hold.status === 'REFUNDED' ? 'WITHDRAWAL_RELEASE' : 'WITHDRAWAL_FINALIZE',
      userId, scopeType: 'WITHDRAWAL', scopeId: hold.withdrawalId,
      reversesOperationId: opening.id,
      walletTransactionIds: refund ? [refund.id] : [],
      createdBy: 'SYSTEM', createdAt: refund?.createdAt ?? hold.consumedAt ?? hold.createdAt,
      snapshot: { ledgerReplayHash: hash, historicalTerminalHold: true,
        holdId: hold.id },
    } });
    await tx.coinLotEntry.create({ data: {
      operationId: terminal.id, lotId: transit.id, userId, sequence: 0,
      entryType: hold.status === 'REFUNDED' ? 'RELEASE' : 'FINALIZE',
      availableDelta: refund ? hold.coinAmount : 0,
      reservedDelta: -hold.coinAmount, reversesEntryId: reserve.id,
    } });
    if (refund) {
      const fold = await tx.economicOperation.create({ data: {
        type: 'LEGACY_OPENING', userId, scopeType: 'WITHDRAWAL_HISTORY_FOLD',
        scopeId: hold.id, walletTransactionIds: [], createdBy: 'SYSTEM',
        snapshot: { ledgerReplayHash: hash, refundWalletTransactionId: refund.id,
          reason: 'Refund value is already represented by wallet replay' },
      } });
      await tx.coinLotEntry.create({ data: {
        operationId: fold.id, lotId: transit.id, userId, sequence: 0,
        entryType: 'CONSUME', availableDelta: -hold.coinAmount,
      } });
    }
    await tx.coinProvenance.update({ where: { id: transit.id },
      data: { state: 'EXHAUSTED', closedAt: new Date() } });
  }
}

async function reclassifyReplayLot(
  tx: Tx, userId: string, sourceLotId: string, target: ReplayLot,
  hash: string,
): Promise<void> {
  const isPurchase = target.sourceKind === 'PURCHASE';
  const isBonus = target.sourceKind === 'BONUS' || target.sourceKind === 'BONUS_CONVERSION';
  const operation = await tx.economicOperation.create({ data: {
    type: 'LEGACY_OPENING', userId,
    scopeType: isPurchase ? 'AGENT_ORDER' : isBonus ? 'TRIVIA_SESSION' : 'LEDGER_ROW',
    scopeId: target.sourceScopeId,
    walletTransactionIds: target.sourceWalletTransactionId ? [target.sourceWalletTransactionId] : [],
    countryPolicyId: target.policy?.id ?? null,
    countryPolicyVersion: target.policy?.version ?? null,
    createdBy: 'SYSTEM', snapshot: { ledgerReplayHash: hash, sourceKind: target.sourceKind,
      sourceWalletTransactionId: target.sourceWalletTransactionId },
  } });
  await tx.coinLotEntry.create({ data: {
    operationId: operation.id, lotId: sourceLotId, userId, sequence: 0,
    entryType: 'RECLASS_OUT', availableDelta: -target.availableAmount,
  } });
  const sourceClass: LotClass = isBonus ? 'RESTRICTED' : target.lotClass;
  const amount = target.availableAmount;
  const policy = target.policy;
  const required = isBonus ? target.requirementAmount : 0;
  const progress = isBonus ? target.progressAmount : 0;
  const created = await tx.coinProvenance.create({ data: {
    userId, amount,
    provenanceType: isPurchase ? 'PURCHASE' : isBonus ? 'TRIVIA_REWARD' : 'LEGACY_UNTRACKED',
    restrictionStatus: sourceClass === 'WITHDRAWABLE' ? 'UNRESTRICTED' : 'RESTRICTED',
    originalSource: isPurchase ? 'PURCHASE' : isBonus ? 'TRIVIA_REWARD' : 'LEGACY_UNTRACKED',
    walletTransactionId: target.sourceWalletTransactionId || null,
    originalGrantReferenceType: isPurchase ? 'AGENT_ORDER' : isBonus ? 'GAME' : null,
    originalGrantReferenceId: target.sourceScopeId,
    countryPolicyId: policy?.id ?? null, countryPolicyVersion: policy?.version ?? null,
    requiredPlaythrough: required, completedPlaythrough: progress,
    lotClass: sourceClass, state: 'OPEN', availableAmount: 0, reservedAmount: 0,
    requirementAmount: 0, progressAmount: 0, mintedAt: target.mintedAt,
    availableAt: target.availableAt, expiresAt: target.expiresAt,
    sourceOperationId: operation.id, parentLotId: sourceLotId, rootLotId: sourceLotId,
  } });
  await tx.coinLotEntry.create({ data: {
    operationId: operation.id, lotId: created.id, userId, sequence: 1,
    entryType: 'RECLASS_IN', availableDelta: amount,
    progressDelta: progress, obligationDelta: required - progress,
  } });
  if (target.sourceKind !== 'BONUS_CONVERSION') return;
  if (!policy || progress < required) throw ApiError.internal('Unproven bonus conversion');
  const conversion = await tx.economicOperation.create({ data: {
    type: 'BONUS_CONVERSION', userId, scopeType: 'LOT', scopeId: created.id,
    countryPolicyId: policy.id, countryPolicyVersion: policy.version,
    walletTransactionIds: [], createdBy: 'SYSTEM',
    snapshot: { ledgerReplayHash: hash, legacyReplay: true },
  } });
  const successor = await tx.coinProvenance.create({ data: {
    userId, amount, provenanceType: 'CONVERSION', restrictionStatus: 'UNRESTRICTED',
    originalSource: 'TRIVIA_REWARD', requiredPlaythrough: 0, completedPlaythrough: 0,
    lotClass: 'WITHDRAWABLE', state: 'OPEN', availableAmount: 0, reservedAmount: 0,
    requirementAmount: 0, progressAmount: 0, mintedAt: target.mintedAt,
    availableAt: target.availableAt, sourceOperationId: conversion.id,
    parentLotId: created.id, rootLotId: sourceLotId,
  } });
  await tx.coinLotEntry.create({ data: {
    operationId: conversion.id, lotId: created.id, userId, sequence: 0,
    entryType: 'CONVERT_OUT', availableDelta: -amount,
  } });
  await tx.coinLotEntry.create({ data: {
    operationId: conversion.id, lotId: successor.id, userId, sequence: 1,
    entryType: 'CONVERT_IN', availableDelta: amount,
  } });
  await tx.coinProvenance.update({ where: { id: created.id },
    data: { state: 'CONVERTED', closedAt: new Date() } });
}

/**
 * One user is an atomic, resumable unit. Dry-run computes the same replay
 * without writing. A retry after commit returns the existing classification;
 * a crash before commit leaves every historical row unchanged.
 */
export async function classifyLegacyCoinAccount(
  userId: string, dryRun = true, actorId?: string,
): Promise<LegacyReplayPlan> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(${'legacy_classify:' + userId},0))) AS acquired`;
    const users = (await tx.$queryRaw`
      SELECT "id", "role"::text AS "role", "status"::text AS "status"
      FROM "users" WHERE "id"=${userId} OR "id"=${actorId ?? userId}
      ORDER BY "id" FOR SHARE
    `) as { id: string; role: string; status: string }[];
    if (!users.some((user) => user.id === userId)) throw ApiError.notFound('User not found');
    if (actorId && !users.some((user) => user.id === actorId
        && user.role === 'SUPER_ADMIN' && user.status === 'ACTIVE')) {
      throw ApiError.forbidden('Active SUPER_ADMIN required for legacy classification');
    }
    // L4 before L5/L6: terminal hold metadata is locked before its historical
    // operation link is written. Live holds were bridged by migration M4.
    const terminalHolds = (await tx.$queryRaw`
      SELECT h."id", h."withdrawalId", h."coinAmount", h."status"::text AS "status",
             h."debitWalletTransactionId", h."refundWalletTransactionId", h."createdAt",
             h."consumedAt", h."releasedAt"
      FROM "withdrawal_holds" h
      JOIN "withdrawals" w ON w."id"=h."withdrawalId"
      WHERE w."userId"=${userId} AND h."status" IN ('CONSUMED','REFUNDED')
        AND h."holdOperationId" IS NULL
      ORDER BY h."id" FOR UPDATE OF h
    `) as TerminalHold[];
    const walletRows = (await tx.$queryRaw`
      SELECT "coinsBalance" FROM "wallets" WHERE "userId"=${userId} FOR UPDATE
    `) as { coinsBalance: number }[];
    const wallet = walletRows[0];
    if (!wallet) throw ApiError.notFound('Wallet not found');
    const account = await tx.coinLedgerAccount.findUnique({ where: { userId } });
    if (account?.classifiedAt) {
      const opening = await tx.economicOperation.findUnique({
        where: { type_scopeType_scopeId: {
          type: 'LEGACY_OPENING', scopeType: 'WALLET_REPLAY', scopeId: userId,
        } }, select: { snapshot: true },
      });
      const prior = (opening?.snapshot as { classificationPlan?: LegacyReplayPlan } | null)?.classificationPlan;
      if (prior) return { ...prior, idempotent: true,
        sources: prior.sources.map((source) => ({ ...source,
          mintedAt: new Date(source.mintedAt), availableAt: new Date(source.availableAt),
          expiresAt: source.expiresAt ? new Date(source.expiresAt) : null,
        })) };
      throw ApiError.conflict('Coin account was classified by another operation');
    }
    const oldLots = (await tx.$queryRaw`
      SELECT * FROM "coin_provenance" WHERE "userId"=${userId} ORDER BY "id" FOR UPDATE
    `) as RawCoinProvenanceRow[];
    const rows = (await tx.walletTransaction.findMany({
      where: { userId, currency: 'COINS', status: 'SUCCEEDED' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })) as LedgerRow[];
    const hash = walletLedgerHash(rows, wallet.coinsBalance);
    const replay = await replayLedger(tx, userId, wallet.coinsBalance, rows, hash);
    const oldAvailableAmount = oldLots.reduce((sum, lot) => sum + (lot.availableAmount ?? 0), 0);
    const activeReservedAmount = oldLots.reduce((sum, lot) => sum + (lot.reservedAmount ?? 0), 0);
    const reviewAmount = replay.sources.filter((lot) => lot.lotClass === 'UNCLASSIFIED')
      .reduce((sum, lot) => sum + lot.availableAmount, 0);
    const plan: LegacyReplayPlan = { userId, walletBalance: wallet.coinsBalance,
      ledgerReplayHash: hash, sources: replay.sources, reviewAmount,
      reviewReasons: replay.reasons, ledgerReconciled: replay.reconciled,
      oldAvailableAmount, activeReservedAmount,
      purchaseOverageAmount: replay.purchaseOverageAmount,
      conversionOverageAmount: replay.conversionOverageAmount };
    if (dryRun) return plan;
    await reverseOldOpeningLots(tx, userId, oldLots, hash);
    const opening = await createReplaySource(tx, userId, wallet.coinsBalance, hash, plan);
    await retireUnmanagedHistoricalLots(tx, oldLots, opening.operationId);
    const sourceLotId = opening.lotId;
    if (sourceLotId) {
      for (const target of replay.sources) {
        if (target.lotClass === 'UNCLASSIFIED') continue;
        await reclassifyReplayLot(tx, userId, sourceLotId, target, hash);
      }
      if (reviewAmount > 0) {
        const review = await tx.legacyBalanceReview.create({ data: {
          userId, lotId: sourceLotId, amount: reviewAmount, status: 'OPEN',
          evidence: { ledgerReplayHash: hash, reasons: replay.reasons,
            reconciled: replay.reconciled, purchaseOverageAmount: replay.purchaseOverageAmount,
            conversionOverageAmount: replay.conversionOverageAmount },
        } });
        await tx.coinProvenance.update({ where: { id: sourceLotId }, data: { reviewId: review.id } });
      } else {
        await tx.coinProvenance.update({ where: { id: sourceLotId },
          data: { state: 'RECLASSIFIED', closedAt: new Date() } });
      }
    }
    await journalTerminalWithdrawalHistory(tx, userId, terminalHolds, rows, hash);
    const currentRows = (await tx.$queryRaw`
      SELECT COALESCE(SUM("availableAmount"),0)::int AS available
      FROM "coin_provenance" WHERE "userId"=${userId}
    `) as { available: number }[];
    const current = currentRows[0]?.available;
    if (current !== wallet.coinsBalance) throw ApiError.internal('Legacy classification does not balance');
    if (account) {
      await tx.coinLedgerAccount.update({ where: { userId }, data: {
        classifiedAt: new Date(), classificationRunId: hash,
      } });
    } else {
      await tx.coinLedgerAccount.create({ data: { userId,
        classifiedAt: new Date(), classificationRunId: hash } });
    }
    await flushCoinLedgerConstraints(tx);
    return plan;
  }, { isolationLevel: 'Serializable', timeout: 120_000 });
}
