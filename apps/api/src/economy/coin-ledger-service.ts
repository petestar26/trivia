import { ApiError } from '../middleware/error-handler.js';
import { applyBalanceChanges, COIN_LEDGER_INTENT, getOrCreateWallet } from './wallet-service.js';
import type { BalanceChange } from './wallet-service.js';
import { allocateFunding, splitObligation, splitPayout } from './coin-allocator.js';
import type { FundingShare, LotClass } from './coin-allocator.js';

// Every caller takes its L0/L1/L2/L3/L4 locks before entering this module.
// This module always takes L5 wallet before L6 lots, and writes L7 records last.
export type EconomicTx = any;
export type PolicyPin = { id: string; version: number };

/** Prisma 5 can resolve a callback transaction even when PostgreSQL rejects
 * these deferred triggers at COMMIT. Evaluate them before callback return,
 * then restore deferral for another operation in the same outer transaction. */
export async function flushCoinLedgerConstraints(tx: EconomicTx): Promise<void> {
  await tx.$executeRawUnsafe(
    'SET CONSTRAINTS "wallet_coin_lot_equality", "entry_coin_lot_equality", "classification_coin_lot_equality", "coin_operation_obligation_guard" IMMEDIATE',
  );
  await tx.$executeRawUnsafe(
    'SET CONSTRAINTS "wallet_coin_lot_equality", "entry_coin_lot_equality", "classification_coin_lot_equality", "coin_operation_obligation_guard" DEFERRED',
  );
}
export type OperationName =
  | 'PURCHASE' | 'BONUS_GRANT' | 'WAGER' | 'PAYOUT' | 'GIFT_SPEND'
  | 'COMPETITION_ESCROW' | 'COMPETITION_RELEASE' | 'COMPETITION_PAYOUT'
  | 'WITHDRAWAL_HOLD' | 'WITHDRAWAL_RELEASE' | 'WITHDRAWAL_FINALIZE'
  | 'BONUS_CONVERSION' | 'BONUS_EXPIRY' | 'LEGACY_OPENING' | 'LEGACY_RESOLVE'
  | 'ADMIN_ADJUST' | 'ADMIN_QUALIFY' | 'COMPENSATION';

type LockedLot = {
  id: string; userId: string; lotClass: LotClass; state: string; amount: number; rootLotId: string | null;
  availableAmount: number; reservedAmount: number; requirementAmount: number;
  progressAmount: number; countryPolicyId: string | null;
  countryPolicyVersion: number | null; mintedAt: Date; availableAt: Date | null;
  expiresAt: Date | null; provenanceType: string;
};

type OperationArgs = {
  type: OperationName; userId: string; scopeType: string; scopeId: string;
  idempotencyKey?: string; requestHash?: string; policy?: PolicyPin | null;
  walletTransactionIds?: string[]; reversesOperationId?: string;
  snapshot?: Record<string, unknown>; createdBy?: string;
};

function safePositive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1_000_000_000) {
    throw ApiError.badRequest(`${name} must be a positive integer within the Coin limit`);
  }
}

function safeNonnegative(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_000_000_000) {
    throw ApiError.badRequest(`${name} is outside the supported range`);
  }
}

export async function lockUserEconomicScope(tx: EconomicTx, scope: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))) AS lock_wait`;
}

export async function lockEconomicWallet(tx: EconomicTx, userId: string) {
  await getOrCreateWallet(userId, tx);
  const rows = (await tx.$queryRaw`
    SELECT "id", "userId", "coinsBalance", "gamePointsBalance"
    FROM "wallets" WHERE "userId" = ${userId} FOR UPDATE
  `) as { id: string; userId: string; coinsBalance: number; gamePointsBalance: number }[];
  const wallet = rows[0];
  if (!wallet) throw ApiError.internal('Wallet lock failed');
  let account = await tx.coinLedgerAccount.findUnique({ where: { userId } });
  if (!account) {
    if (wallet.coinsBalance !== 0) {
      throw ApiError.conflict('Coin balance requires legacy classification');
    }
    account = await tx.coinLedgerAccount.create({
      data: { userId, classifiedAt: new Date() },
    });
  }
  return { wallet, account };
}

async function lockLots(tx: EconomicTx, userId: string): Promise<LockedLot[]> {
  const lots = (await tx.$queryRaw`
    SELECT "id", "userId", "amount", "rootLotId", "lotClass"::text AS "lotClass", "state"::text AS "state",
           "availableAmount", "reservedAmount", "requirementAmount", "progressAmount",
           "countryPolicyId", "countryPolicyVersion", "mintedAt", "availableAt",
           "expiresAt", "provenanceType"::text AS "provenanceType"
    FROM "coin_provenance"
    WHERE "userId" = ${userId} AND "lotClass" IS NOT NULL
    ORDER BY "id" FOR UPDATE
  `) as LockedLot[];
  for (const lot of lots) {
    if (lot.availableAmount === null || lot.reservedAmount === null ||
        lot.requirementAmount === null || lot.progressAmount === null) {
      throw ApiError.conflict('Coin lot requires legacy classification');
    }
  }
  return lots;
}

function usableSpendLots(lots: LockedLot[], now: Date): LockedLot[] {
  // The worker records expiry with BONUS_EXPIRY/FORFEIT. A delayed sweep
  // must never let an already-expired restricted grant fund a wager or gift.
  return lots.filter((lot) => lot.state === 'OPEN' && lot.availableAmount > 0 &&
    (lot.lotClass !== 'RESTRICTED' || lot.expiresAt === null || lot.expiresAt > now));
}

async function closeEmptyLots(tx: EconomicTx, userId: string): Promise<void> {
  const empty = await tx.coinProvenance.findMany({
    where: { userId, state: 'OPEN', availableAmount: 0, reservedAmount: 0, lotClass: 'RESTRICTED' },
    select: { id: true }, orderBy: { id: 'asc' },
  });
  for (const lot of empty) {
    await tx.coinProvenance.update({ where: { id: lot.id },
      data: { state: 'EXHAUSTED', closedAt: new Date() } });
  }
}

function requireClassified(classifiedAt: Date | null): void {
  if (!classifiedAt) throw ApiError.forbidden('Coin account is pending ledger classification');
}

function assertBalanceMatchesLots(walletBalance: number, lots: LockedLot[], classifiedAt: Date | null): void {
  if (!classifiedAt) return;
  const sum = lots.reduce((n, lot) => n + lot.availableAmount, 0);
  if (sum !== walletBalance) throw ApiError.internal('Coin ledger and wallet are out of balance');
}

async function createOperation(tx: EconomicTx, args: OperationArgs) {
  return tx.economicOperation.create({
    data: {
      type: args.type,
      userId: args.userId,
      scopeType: args.scopeType,
      scopeId: args.scopeId,
      idempotencyKey: args.idempotencyKey,
      requestHash: args.requestHash,
      countryPolicyId: args.policy?.id ?? null,
      countryPolicyVersion: args.policy?.version ?? null,
      walletTransactionIds: args.walletTransactionIds ?? [],
      reversesOperationId: args.reversesOperationId,
      snapshot: args.snapshot,
      createdBy: args.createdBy ?? args.userId,
    },
  });
}

async function entry(tx: EconomicTx, args: {
  operationId: string; userId: string; lotId: string; sequence: number;
  entryType: string; availableDelta?: number; reservedDelta?: number;
  progressDelta?: number; obligationDelta?: number; obligationShare?: number;
  counterpartyLotId?: string; reversesEntryId?: string;
}) {
  return tx.coinLotEntry.create({
    data: {
      operationId: args.operationId,
      userId: args.userId,
      lotId: args.lotId,
      sequence: args.sequence,
      entryType: args.entryType,
      availableDelta: args.availableDelta ?? 0,
      reservedDelta: args.reservedDelta ?? 0,
      progressDelta: args.progressDelta ?? 0,
      obligationDelta: args.obligationDelta ?? 0,
      obligationShare: args.obligationShare,
      counterpartyLotId: args.counterpartyLotId,
      reversesEntryId: args.reversesEntryId,
    },
  });
}

export type CreditCoinsArgs = {
  type: 'PURCHASE' | 'BONUS_GRANT' | 'ADMIN_ADJUST';
  scopeType: string; scopeId: string; referenceType: BalanceChange['referenceType']; referenceId?: string;
  description: string; createdBy?: string; idempotencyKey?: string;
  requestHash?: string;
  lotClass?: LotClass; provenanceType?: string; policy?: PolicyPin | null;
  requirementAmount?: number; expiresAt?: Date | null; availableAt?: Date | null;
  originalGrantReferenceType?: string; originalGrantReferenceId?: string;
  evidence?: Record<string, unknown>;
  /** PURCHASE callers must write the matching settled Agent-order witness
   * before the ledger helper can return. The deferred DB guard verifies it. */
  completePurchaseProof?: (tx: EconomicTx, walletTransactionId: string) => Promise<string>;
};

/** Wallet credit and economic MINT are atomic. PURCHASE is the only normal withdrawable mint. */
export async function creditCoins(tx: EconomicTx, userId: string, amount: number, args: CreditCoinsArgs) {
  safePositive(amount, 'Coin credit');
  if (args.type === 'PURCHASE' &&
      (args.scopeType !== 'AGENT_ORDER' || args.referenceType !== 'AGENT_ORDER' ||
       args.referenceId !== args.scopeId || !args.completePurchaseProof)) {
    throw ApiError.forbidden('Purchase credit requires a settled Agent order proof');
  }
  const lotClass: LotClass = args.lotClass ?? (args.type === 'PURCHASE' ? 'WITHDRAWABLE' : args.type === 'BONUS_GRANT' ? 'RESTRICTED' : 'UNCLASSIFIED');
  if (lotClass === 'WITHDRAWABLE' && !['PURCHASE'].includes(args.type)) {
    throw ApiError.forbidden('This operation cannot mint withdrawable Coins');
  }
  const requirement = lotClass === 'RESTRICTED' ? args.requirementAmount ?? 0 : 0;
  safeNonnegative(requirement, 'Coin playthrough requirement');
  if (lotClass === 'RESTRICTED' && (!args.policy || requirement === 0)) {
    throw ApiError.forbidden('Restricted Coin mint requires a configured policy and playthrough');
  }
  const { wallet, account } = await lockEconomicWallet(tx, userId);
  const lots = await lockLots(tx, userId);
  requireClassified(account.classifiedAt);
  assertBalanceMatchesLots(wallet.coinsBalance, lots, account.classifiedAt);
  const balanceResult = await applyBalanceChanges(tx, userId, [{
    currency: 'COINS', amount, ledgerType: 'CREDIT', transactionType: 'COIN_CREDIT',
    referenceType: args.referenceType, referenceId: args.referenceId ?? args.scopeId,
    description: args.description,
  }], { coinLedgerIntent: COIN_LEDGER_INTENT });
  const walletTransactionId = balanceResult.transactions[0]?.id;
  if (!walletTransactionId) throw ApiError.internal('Coin credit has no wallet transaction');
  const operation = await createOperation(tx, {
    type: args.type, userId, scopeType: args.scopeType, scopeId: args.scopeId,
    idempotencyKey: args.idempotencyKey, requestHash: args.requestHash, policy: args.policy,
    walletTransactionIds: [walletTransactionId], createdBy: args.createdBy,
    snapshot: args.type === 'ADMIN_ADJUST' ? { evidence: args.evidence ?? {
      description: args.description, referenceType: args.referenceType,
      referenceId: args.referenceId ?? args.scopeId, recordedBy: args.createdBy ?? userId,
    } } : undefined,
  });
  const provenanceType = args.provenanceType ?? (
    args.type === 'PURCHASE' ? 'PURCHASE' : args.type === 'BONUS_GRANT' ? 'TRIVIA_REWARD' : 'ADMIN_ADJUSTMENT'
  );
  const lot = await tx.coinProvenance.create({
    data: {
      userId, walletTransactionId, amount, provenanceType,
      restrictionStatus: lotClass === 'WITHDRAWABLE' ? 'UNRESTRICTED' : 'RESTRICTED',
      originalSource: provenanceType,
      originalGrantReferenceType: args.originalGrantReferenceType ?? args.referenceType,
      originalGrantReferenceId: args.originalGrantReferenceId ?? args.referenceId ?? args.scopeId,
      countryPolicyId: args.policy?.id ?? null,
      countryPolicyVersion: args.policy?.version ?? null,
      requiredPlaythrough: requirement,
      completedPlaythrough: 0,
      expiresAt: args.expiresAt ?? null,
      lotClass, state: 'OPEN', availableAmount: 0, reservedAmount: 0,
      requirementAmount: 0, progressAmount: 0,
      mintedAt: new Date(), availableAt: args.availableAt ?? new Date(),
      sourceOperationId: operation.id,
    },
  });
  if (lotClass === 'UNCLASSIFIED') {
    const review = await tx.legacyBalanceReview.create({
      data: { userId, lotId: lot.id, amount, evidence: { sourceOperationId: operation.id } },
    });
    await tx.coinProvenance.update({ where: { id: lot.id }, data: { reviewId: review.id } });
  }
  await entry(tx, {
    operationId: operation.id, userId, lotId: lot.id, sequence: 0,
    entryType: 'MINT', availableDelta: amount, obligationDelta: requirement,
  });
  let purchaseSettlementId: string | undefined;
  if (args.type === 'PURCHASE') {
    purchaseSettlementId = await args.completePurchaseProof!(tx, walletTransactionId);
    if (!purchaseSettlementId) throw ApiError.internal('Purchase settlement proof was not recorded');
    // Prisma 5 may resolve a callback whose deferred COMMIT later aborts.
    // Force the relational purchase witness before any caller can report success.
    await tx.$executeRawUnsafe('SET CONSTRAINTS "purchase_settlement_proof_guard" IMMEDIATE');
    await tx.$executeRawUnsafe('SET CONSTRAINTS "purchase_settlement_proof_guard" DEFERRED');
  }
  await flushCoinLedgerConstraints(tx);
  return { walletTransactionId, operationId: operation.id, lotId: lot.id,
    coinsBalance: balanceResult.coinsBalance, purchaseSettlementId };
}

export type DebitCoinsArgs = {
  type: 'GIFT_SPEND' | 'ADMIN_ADJUST';
  scopeType: string; scopeId: string; referenceType: BalanceChange['referenceType']; referenceId?: string;
  description: string; idempotencyKey?: string; createdBy?: string;
  requestHash?: string;
  evidence?: Record<string, unknown>;
};

/** Spend all Coin classes by the contract's restricted-first order. */
export async function debitCoins(tx: EconomicTx, userId: string, amount: number, args: DebitCoinsArgs) {
  safePositive(amount, 'Coin debit');
  const { wallet, account } = await lockEconomicWallet(tx, userId);
  const lots = await lockLots(tx, userId);
  requireClassified(account.classifiedAt);
  assertBalanceMatchesLots(wallet.coinsBalance, lots, account.classifiedAt);
  let funding: FundingShare[];
  try {
    funding = allocateFunding(usableSpendLots(lots, new Date()), amount);
  } catch (error) {
    if (error instanceof RangeError) throw ApiError.badRequest('Insufficient tracked Coins');
    throw error;
  }
  const balanceResult = await applyBalanceChanges(tx, userId, [{
    currency: 'COINS', amount, ledgerType: 'DEBIT', transactionType: 'COIN_DEBIT',
    referenceType: args.referenceType, referenceId: args.referenceId ?? args.scopeId,
    description: args.description,
  }], { coinLedgerIntent: COIN_LEDGER_INTENT });
  const walletTransactionId = balanceResult.transactions[0]?.id;
  const operation = await createOperation(tx, {
    type: args.type, userId, scopeType: args.scopeType, scopeId: args.scopeId,
    idempotencyKey: args.idempotencyKey, requestHash: args.requestHash,
    walletTransactionIds: [walletTransactionId],
    createdBy: args.createdBy,
    snapshot: args.type === 'ADMIN_ADJUST' ? { evidence: args.evidence ?? {
      description: args.description, referenceType: args.referenceType,
      referenceId: args.referenceId ?? args.scopeId, recordedBy: args.createdBy ?? userId,
    } } : undefined,
  });
  const sourceById = new Map(lots.map((lot) => [lot.id, lot]));
  for (const [index, share] of funding.entries()) {
    const source = sourceById.get(share.lotId)!;
    const obligationShare = source.lotClass === 'RESTRICTED'
      ? splitObligation(Math.max(0, source.requirementAmount - source.progressAmount),
          share.amount, source.availableAmount).moved : undefined;
    await entry(tx, { operationId: operation.id, userId, lotId: share.lotId,
      sequence: index, entryType: 'CONSUME', availableDelta: -share.amount,
      obligationShare });
  }
  await closeEmptyLots(tx, userId);
  await flushCoinLedgerConstraints(tx);
  return { funding, operationId: operation.id, walletTransactionId, coinsBalance: balanceResult.coinsBalance };
}

export type WagerCoinsArgs = {
  sessionId: string; gameKey: string; stake: number; payout: number;
  idempotencyKey: string; policy: PolicyPin; createdBy?: string;
  responseSnapshot: (coinsBalance: number) => Record<string, unknown>;
};

/** Debit and proportional payout, with progress under each bonus lot's pinned terms. */
export async function settleWagerCoins(tx: EconomicTx, userId: string, args: WagerCoinsArgs) {
  safePositive(args.stake, 'Wager stake');
  safeNonnegative(args.payout, 'Wager payout');
  const { wallet, account } = await lockEconomicWallet(tx, userId);
  const lots = await lockLots(tx, userId);
  requireClassified(account.classifiedAt);
  assertBalanceMatchesLots(wallet.coinsBalance, lots, account.classifiedAt);
  let funding: FundingShare[];
  try {
    funding = allocateFunding(usableSpendLots(lots, new Date()), args.stake);
  } catch (error) {
    if (error instanceof RangeError) throw ApiError.badRequest('Insufficient tracked Coins');
    throw error;
  }
  const payoutShares = args.payout > 0 ? splitPayout(funding, args.payout) : [];
  const sourceById = new Map(lots.map((lot) => [lot.id, lot]));
  const payoutById = new Map(payoutShares.map((share) => [share.lotId, share.amount]));
  const progressById = new Map<string, number>();
  const conversionPlans: {
    lot: LockedLot; availableAfter: number; progressAfter: number;
    convertAmount: number; forfeitAmount: number;
  }[] = [];

  // Predict the post-settlement state while every source lot is locked. This
  // lets the immutable WAGER snapshot include cap forfeitures as well.
  for (const share of funding) {
    const lot = sourceById.get(share.lotId)!;
    if (lot.lotClass !== 'RESTRICTED') continue;
    if (!lot.countryPolicyId || lot.countryPolicyVersion === null) {
      throw ApiError.internal('Restricted lot has no pinned country policy');
    }
    const pinned = await tx.countryCasinoPolicy.findUnique({
      where: { id: lot.countryPolicyId },
      select: { version: true, qualifyingGames: true, maxQualifyingStake: true,
        maxConversionMultiple: true },
    });
    if (!pinned || pinned.version !== lot.countryPolicyVersion) {
      throw ApiError.internal('Restricted lot policy pin is invalid');
    }
    const games = Array.isArray(pinned.qualifyingGames) ? pinned.qualifyingGames : [];
    const qualifies = games.includes(args.gameKey) && args.stake <= pinned.maxQualifyingStake;
    const progress = qualifies
      ? Math.min(share.amount, Math.max(0, lot.requirementAmount - lot.progressAmount)) : 0;
    progressById.set(lot.id, progress);
    const progressAfter = lot.progressAmount + progress;
    const availableAfter = lot.availableAmount - share.amount + (payoutById.get(lot.id) ?? 0);
    if (progressAfter < lot.requirementAmount || availableAfter <= 0) continue;
    const cap = pinned.maxConversionMultiple === null
      ? availableAfter
      : exactConversionCap(lot.amount, pinned.maxConversionMultiple);
    const convertAmount = Math.min(availableAfter, cap);
    conversionPlans.push({ lot, availableAfter, progressAfter,
      convertAmount, forfeitAmount: availableAfter - convertAmount });
  }

  const changes: any[] = [{
    currency: 'COINS', amount: args.stake, ledgerType: 'DEBIT', transactionType: 'COIN_DEBIT',
    referenceType: 'GAME', referenceId: args.sessionId, description: `Game bet: ${args.gameKey}`,
  }];
  if (args.payout > 0) changes.push({
    currency: 'COINS', amount: args.payout, ledgerType: 'CREDIT', transactionType: 'COIN_CREDIT',
    referenceType: 'GAME', referenceId: args.sessionId, description: `Game reward: ${args.gameKey}`,
  });
  const balanceResult = await applyBalanceChanges(tx, userId, changes, { coinLedgerIntent: COIN_LEDGER_INTENT });
  let finalCoinsBalance = balanceResult.coinsBalance;
  const forfeitureTransactions = new Map<string, string>();
  for (const plan of conversionPlans.sort((a, b) => a.lot.id.localeCompare(b.lot.id))) {
    if (plan.forfeitAmount === 0) continue;
    // Separate balance updates avoid the wallet helper's per-change
    // affordability check rejecting a debit funded by the wager payout.
    const forfeit = await applyBalanceChanges(tx, userId, [{
      currency: 'COINS', amount: plan.forfeitAmount,
      ledgerType: 'DEBIT', transactionType: 'COIN_DEBIT',
      referenceType: 'GAME', referenceId: args.sessionId,
      description: 'Bonus conversion cap forfeiture',
    }], { coinLedgerIntent: COIN_LEDGER_INTENT });
    finalCoinsBalance = forfeit.coinsBalance;
    forfeitureTransactions.set(plan.lot.id, forfeit.transactions[0].id);
  }

  const wager = await createOperation(tx, {
    type: 'WAGER', userId, scopeType: 'GAME_SESSION', scopeId: args.sessionId,
    idempotencyKey: args.idempotencyKey, policy: args.policy,
    walletTransactionIds: [balanceResult.transactions[0].id], createdBy: args.createdBy,
    snapshot: args.responseSnapshot(finalCoinsBalance),
  });
  let sequence = 0;
  for (const share of funding) {
    const source = sourceById.get(share.lotId)!;
    const obligationShare = source.lotClass === 'RESTRICTED'
      ? splitObligation(Math.max(0, source.requirementAmount - source.progressAmount),
          share.amount, source.availableAmount).moved : undefined;
    await entry(tx, { operationId: wager.id, userId, lotId: share.lotId,
      sequence: sequence++, entryType: 'CONSUME', availableDelta: -share.amount,
      obligationShare });
  }
  for (const share of funding) {
    const progress = progressById.get(share.lotId) ?? 0;
    if (progress === 0) continue;
    await entry(tx, { operationId: wager.id, userId, lotId: share.lotId,
      sequence: sequence++, entryType: 'PROGRESS', progressDelta: progress,
      obligationDelta: -progress });
  }
  let payoutOperationId: string | null = null;
  if (args.payout > 0) {
    const payout = await createOperation(tx, {
      type: 'PAYOUT', userId, scopeType: 'GAME_SESSION', scopeId: args.sessionId,
      policy: args.policy, walletTransactionIds: [balanceResult.transactions[1].id],
      createdBy: args.createdBy,
    });
    payoutOperationId = payout.id;
    let payoutSequence = 0;
    for (const share of payoutShares) {
      if (share.amount === 0) continue;
      await entry(tx, { operationId: payout.id, userId, lotId: share.lotId,
        sequence: payoutSequence++, entryType: 'RETURN', availableDelta: share.amount });
    }
  }
  for (const plan of conversionPlans) {
    const latest = await tx.coinProvenance.findUnique({ where: { id: plan.lot.id },
      select: { availableAmount: true, progressAmount: true, state: true,
        originalSource: true, originalGrantReferenceType: true,
        originalGrantReferenceId: true } });
    if (!latest || latest.state !== 'OPEN' || latest.availableAmount !== plan.availableAfter ||
        latest.progressAmount !== plan.progressAfter) {
      throw ApiError.internal('Coin conversion source changed during locked settlement');
    }
    const conversion = await createOperation(tx, {
      type: 'BONUS_CONVERSION', userId, scopeType: 'LOT', scopeId: plan.lot.id,
      policy: { id: plan.lot.countryPolicyId!, version: plan.lot.countryPolicyVersion! },
      walletTransactionIds: forfeitureTransactions.has(plan.lot.id)
        ? [forfeitureTransactions.get(plan.lot.id)!] : [],
      createdBy: args.createdBy,
    });
    let successorId: string | null = null;
    if (plan.convertAmount > 0) {
      const successor = await tx.coinProvenance.create({ data: {
        userId, amount: plan.convertAmount, provenanceType: 'CONVERSION',
        restrictionStatus: 'UNRESTRICTED', originalSource: latest.originalSource,
        originalGrantReferenceType: latest.originalGrantReferenceType,
        originalGrantReferenceId: latest.originalGrantReferenceId,
        countryPolicyId: plan.lot.countryPolicyId,
        countryPolicyVersion: plan.lot.countryPolicyVersion,
        lotClass: 'WITHDRAWABLE', state: 'OPEN', availableAmount: 0,
        reservedAmount: 0, requirementAmount: 0, progressAmount: 0,
        mintedAt: new Date(), availableAt: new Date(), sourceOperationId: conversion.id,
        parentLotId: plan.lot.id, rootLotId: plan.lot.rootLotId ?? plan.lot.id,
      } });
      successorId = successor.id;
      await entry(tx, { operationId: conversion.id, userId, lotId: plan.lot.id,
        sequence: 0, entryType: 'CONVERT_OUT', availableDelta: -plan.convertAmount,
        counterpartyLotId: successor.id });
      await entry(tx, { operationId: conversion.id, userId, lotId: successor.id,
        sequence: 1, entryType: 'CONVERT_IN', availableDelta: plan.convertAmount,
        counterpartyLotId: plan.lot.id });
    }
    if (plan.forfeitAmount > 0) {
      await entry(tx, { operationId: conversion.id, userId, lotId: plan.lot.id,
        sequence: successorId ? 2 : 0,
        entryType: 'FORFEIT', availableDelta: -plan.forfeitAmount });
    }
    await tx.coinProvenance.update({ where: { id: plan.lot.id },
      data: { state: 'CONVERTED', closedAt: new Date() } });
  }
  await closeEmptyLots(tx, userId);
  await flushCoinLedgerConstraints(tx);
  return { coinsBalance: finalCoinsBalance,
    walletTransactionIds: [...balanceResult.transactions.map((t: any) => t.id),
      ...forfeitureTransactions.values()],
    wagerOperationId: wager.id, payoutOperationId, funding, payoutShares };
}

/** Exact integer floor for policy Decimal caps; never round withdrawability up. */
function exactConversionCap(originAmount: number, decimal: { toString(): string } | number): number {
  const value = String(decimal);
  const [whole, fractional = ''] = value.split('.');
  if (!/^\d+$/.test(whole) || (fractional && !/^\d+$/.test(fractional))) {
    throw ApiError.internal('Invalid pinned conversion cap');
  }
  const scale = 10n ** BigInt(fractional.length);
  const numerator = BigInt(whole + fractional);
  const result = BigInt(originAmount) * numerator / scale;
  return Number(result > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : result);
}

export type WithdrawalReservationArgs = {
  withdrawalId: string; policyId: string; policyVersion: number;
  holdingPeriodHours: number; now?: Date; idempotencyKey?: string;
};

async function withdrawalSourceEntries(tx: EconomicTx, holdOperationId: string, userId: string, withdrawalId: string) {
  const holdOp = await tx.economicOperation.findUnique({ where: { id: holdOperationId },
    select: { type: true, userId: true, scopeType: true, scopeId: true } });
  if (!holdOp || !['WITHDRAWAL_HOLD', 'LEGACY_OPENING'].includes(holdOp.type) || holdOp.userId !== userId ||
      holdOp.scopeType !== 'WITHDRAWAL' || holdOp.scopeId !== withdrawalId) {
    throw ApiError.internal('Withdrawal hold operation mismatch');
  }
  const source = await tx.coinLotEntry.findMany({
    where: { operationId: holdOperationId, userId, entryType: 'RESERVE' },
    orderBy: { lotId: 'asc' },
  });
  if (source.length === 0) throw ApiError.internal('Withdrawal hold has no source lots');
  return source;
}

export async function reserveWithdrawalCoins(tx: EconomicTx, userId: string, amount: number, args: WithdrawalReservationArgs) {
  safePositive(amount, 'Withdrawal amount');
  const { wallet, account } = await lockEconomicWallet(tx, userId);
  const lots = await lockLots(tx, userId);
  requireClassified(account.classifiedAt);
  assertBalanceMatchesLots(wallet.coinsBalance, lots, account.classifiedAt);
  const now = args.now ?? new Date();
  const eligible = lots.filter((lot) => lot.state === 'OPEN' && lot.lotClass === 'WITHDRAWABLE'
    && lot.availableAmount > 0 && new Date(lot.availableAt ?? lot.mintedAt).getTime()
       + args.holdingPeriodHours * 3_600_000 <= now.getTime());
  eligible.sort((a, b) => (a.availableAt ?? a.mintedAt).getTime() - (b.availableAt ?? b.mintedAt).getTime()
    || a.id.localeCompare(b.id));
  let remaining = amount;
  const reservations: { lotId: string; amount: number }[] = [];
  for (const lot of eligible) {
    if (!remaining) break;
    const draw = Math.min(remaining, lot.availableAmount);
    reservations.push({ lotId: lot.id, amount: draw });
    remaining -= draw;
  }
  if (remaining > 0) throw ApiError.badRequest(`Insufficient withdrawable Coins: ${amount - remaining} eligible`);
  const balanceResult = await applyBalanceChanges(tx, userId, [{
    currency: 'COINS', amount, ledgerType: 'DEBIT', transactionType: 'COIN_DEBIT',
    referenceType: 'WITHDRAWAL', referenceId: args.withdrawalId, description: 'Withdrawal hold',
  }], { coinLedgerIntent: COIN_LEDGER_INTENT });
  const walletTransactionId = balanceResult.transactions[0].id;
  const operation = await createOperation(tx, {
    type: 'WITHDRAWAL_HOLD', userId, scopeType: 'WITHDRAWAL', scopeId: args.withdrawalId,
    idempotencyKey: args.idempotencyKey,
    policy: { id: args.policyId, version: args.policyVersion },
    walletTransactionIds: [walletTransactionId],
  });
  for (const [sequence, allocation] of reservations.entries()) {
    await entry(tx, { operationId: operation.id, userId, lotId: allocation.lotId,
      sequence, entryType: 'RESERVE', availableDelta: -allocation.amount,
      reservedDelta: allocation.amount });
  }
  await flushCoinLedgerConstraints(tx);
  return { walletTransactionId, holdOperationId: operation.id, reservations, coinsBalance: balanceResult.coinsBalance };
}

export async function releaseWithdrawalCoins(tx: EconomicTx, userId: string, withdrawalId: string,
  args: { holdOperationId: string; amount: number; createdBy?: string }) {
  const { wallet, account } = await lockEconomicWallet(tx, userId);
  const source = await withdrawalSourceEntries(tx, args.holdOperationId, userId, withdrawalId);
  const lots = await lockLots(tx, userId);
  assertBalanceMatchesLots(wallet.coinsBalance, lots, account.classifiedAt);
  const total = source.reduce((n: number, row: any) => n + row.reservedDelta, 0);
  if (total !== args.amount) throw ApiError.internal('Withdrawal source amount mismatch');
  const balanceResult = await applyBalanceChanges(tx, userId, [{
    currency: 'COINS', amount: args.amount, ledgerType: 'CREDIT', transactionType: 'COIN_CREDIT',
    referenceType: 'WITHDRAWAL', referenceId: withdrawalId, description: 'Withdrawal refund',
  }], { coinLedgerIntent: COIN_LEDGER_INTENT });
  const walletTransactionId = balanceResult.transactions[0].id;
  const operation = await createOperation(tx, {
    type: 'WITHDRAWAL_RELEASE', userId, scopeType: 'WITHDRAWAL', scopeId: withdrawalId,
    reversesOperationId: args.holdOperationId, walletTransactionIds: [walletTransactionId],
    createdBy: args.createdBy,
  });
  for (const [sequence, reserve] of source.entries()) {
    await entry(tx, { operationId: operation.id, userId, lotId: reserve.lotId,
      sequence, entryType: 'RELEASE', availableDelta: -reserve.availableDelta,
      reservedDelta: -reserve.reservedDelta, reversesEntryId: reserve.id });
  }
  await flushCoinLedgerConstraints(tx);
  return { walletTransactionId, releaseOperationId: operation.id, coinsBalance: balanceResult.coinsBalance };
}

export async function finalizeWithdrawalCoins(tx: EconomicTx, userId: string, withdrawalId: string,
  args: { holdOperationId: string; amount: number; createdBy?: string }) {
  const { wallet, account } = await lockEconomicWallet(tx, userId);
  const source = await withdrawalSourceEntries(tx, args.holdOperationId, userId, withdrawalId);
  const lots = await lockLots(tx, userId);
  assertBalanceMatchesLots(wallet.coinsBalance, lots, account.classifiedAt);
  const total = source.reduce((n: number, row: any) => n + row.reservedDelta, 0);
  if (total !== args.amount) throw ApiError.internal('Withdrawal source amount mismatch');
  const operation = await createOperation(tx, {
    type: 'WITHDRAWAL_FINALIZE', userId, scopeType: 'WITHDRAWAL', scopeId: withdrawalId,
    reversesOperationId: args.holdOperationId, createdBy: args.createdBy,
  });
  for (const [sequence, reserve] of source.entries()) {
    await entry(tx, { operationId: operation.id, userId, lotId: reserve.lotId,
      sequence, entryType: 'FINALIZE', reservedDelta: -reserve.reservedDelta,
      reversesEntryId: reserve.id });
  }
  await closeEmptyLots(tx, userId);
  await flushCoinLedgerConstraints(tx);
  return { finalizeOperationId: operation.id };
}

/** Forfeit one expired restricted lot, preserving a matched wallet debit and
 * append-only BONUS_EXPIRY operation. Caller holds L0 expiry scope and L1 User. */
export async function expireBonusLot(tx: EconomicTx, userId: string, lotId: string): Promise<boolean> {
  const { wallet, account } = await lockEconomicWallet(tx, userId);
  const lots = await lockLots(tx, userId);
  requireClassified(account.classifiedAt);
  assertBalanceMatchesLots(wallet.coinsBalance, lots, account.classifiedAt);
  const target = lots.find((lot) => lot.id === lotId);
  if (!target || target.lotClass !== 'RESTRICTED' || target.state !== 'OPEN' ||
      target.reservedAmount !== 0 || target.availableAmount <= 0 || !target.expiresAt) return false;
  const clock = (await tx.$queryRaw`SELECT clock_timestamp() AS "now"`) as { now: Date }[];
  if (target.expiresAt > clock[0].now) return false;
  const amount = target.availableAmount;
  const debit = await applyBalanceChanges(tx, userId, [{
    currency: 'COINS', amount, ledgerType: 'DEBIT', transactionType: 'COIN_DEBIT',
    referenceType: 'GAME', referenceId: lotId, description: 'Expired bonus forfeiture',
  }], { coinLedgerIntent: COIN_LEDGER_INTENT });
  const operation = await createOperation(tx, {
    type: 'BONUS_EXPIRY', userId, scopeType: 'LOT', scopeId: lotId,
    policy: target.countryPolicyId && target.countryPolicyVersion !== null
      ? { id: target.countryPolicyId, version: target.countryPolicyVersion } : null,
    walletTransactionIds: [debit.transactions[0].id],
    snapshot: { expiredAt: clock[0].now.toISOString(), amount },
  });
  await entry(tx, { operationId: operation.id, userId, lotId,
    sequence: 0, entryType: 'FORFEIT', availableDelta: -amount });
  await tx.coinProvenance.update({ where: { id: lotId },
    data: { state: 'EXPIRED', closedAt: clock[0].now } });
  await flushCoinLedgerConstraints(tx);
  return true;
}
