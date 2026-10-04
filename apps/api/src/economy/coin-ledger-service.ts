import type { CoinProvenanceType, EntryType, Prisma } from '@socialplay/database';
import { ApiError } from '../middleware/api-error.js';
import { applyBalanceChanges, COIN_LEDGER_INTENT, getOrCreateWallet } from './wallet-service.js';
import type { BalanceChange } from './wallet-service.js';
import { allocateFunding, splitObligation, splitPayout } from './coin-allocator.js';
import type { FundingShare, LotClass } from './coin-allocator.js';

// Every caller takes its L0/L1/L2/L3/L4 locks before entering this module.
// This module always takes L5 wallet before L6 lots, and writes L7 records last.
export type EconomicTx = Prisma.TransactionClient;
export type PolicyPin = { id: string; version: number };

/** Prisma 5 can resolve a callback transaction even when PostgreSQL rejects
 * these deferred triggers at COMMIT. Evaluate them before callback return,
 * then restore deferral for another operation in the same outer transaction. */
export async function flushCoinLedgerConstraints(tx: EconomicTx): Promise<void> {
  // CORRECTION 2: lot_coin_lot_equality and coin_lot_journal_integrity_guard
  // (20260923120000_opus_lot_journal_integrity) are deferred constraints on
  // "coin_provenance" itself; every function in this module writes a lot and
  // must flush them at the same point as the pre-existing four, for the same
  // reason documented above (Prisma 5 can resolve this callback before
  // PostgreSQL's real COMMIT rejects a still-deferred violation).
  const names = '"wallet_coin_lot_equality", "entry_coin_lot_equality", ' +
    '"classification_coin_lot_equality", "coin_operation_obligation_guard", ' +
    '"lot_coin_lot_equality", "coin_lot_journal_integrity_guard", ' +
    '"scheduled_stake_row_proof", "scheduled_stake_operation_proof", "scheduled_stake_entry_proof", "scheduled_stake_lot_backing"';
  await tx.$executeRawUnsafe(`SET CONSTRAINTS ${names} IMMEDIATE`);
  await tx.$executeRawUnsafe(`SET CONSTRAINTS ${names} DEFERRED`);
}
export type OperationName =
  | 'SCHEDULED_STAKE_HOLD' | 'SCHEDULED_STAKE_REFUND' | 'SCHEDULED_STAKE_SETTLE'
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
  expiresAt: Date | null; provenanceType: string; bonusRule: string | null;
};

type OperationArgs = {
  type: OperationName; userId: string; scopeType: string; scopeId: string;
  idempotencyKey?: string; requestHash?: string; policy?: PolicyPin | null;
  walletTransactionIds?: string[]; reversesOperationId?: string;
  snapshot?: Prisma.InputJsonObject; createdBy?: string;
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
           "expiresAt", "bonusRule", "provenanceType"::text AS "provenanceType"
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
  entryType: EntryType; availableDelta?: number; reservedDelta?: number;
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

export interface AdjustmentApprovalPin { id: string; amount: number }

/** An ADMIN_ADJUST operation snapshot: the approval's id, signed amount and
 * evidence, which the database compares with the approval it executes. */
function adjustmentSnapshot(args: { evidence?: Record<string, unknown>; adjustmentApproval?: AdjustmentApprovalPin }): Prisma.InputJsonObject {
  if (!args.adjustmentApproval || !args.evidence) {
    throw ApiError.forbidden('A Coin adjustment requires an executed two-administrator approval');
  }
  return { evidence: args.evidence as Prisma.InputJsonObject, approvalId: args.adjustmentApproval.id, amount: args.adjustmentApproval.amount };
}

export type CreditCoinsArgs = {
  type: 'PURCHASE' | 'BONUS_GRANT' | 'ADMIN_ADJUST';
  scopeType: string; scopeId: string; referenceType: BalanceChange['referenceType']; referenceId?: string;
  description: string; createdBy?: string; idempotencyKey?: string;
  requestHash?: string;
  lotClass?: LotClass; provenanceType?: CoinProvenanceType; policy?: PolicyPin | null;
  requirementAmount?: number; expiresAt?: Date | null; availableAt?: Date | null;
  originalGrantReferenceType?: string; originalGrantReferenceId?: string;
  bonusRule?: 'NET_WINNINGS_V1';
  evidence?: Record<string, unknown>;
  /** ADMIN_ADJUST only: the approval this operation executes (see
   * admin-adjustment-service). The database binds the two exactly. */
  adjustmentApproval?: AdjustmentApprovalPin;
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
    snapshot: args.type === 'ADMIN_ADJUST' ? adjustmentSnapshot(args) : undefined,
  });
  const provenanceType = args.provenanceType ?? (
    args.type === 'PURCHASE' ? 'PURCHASE' : args.type === 'BONUS_GRANT' ? 'TRIVIA_REWARD' : 'ADMIN_ADJUSTMENT'
  );
  const lot = await tx.coinProvenance.create({
    data: {
      userId, walletTransactionId, amount, provenanceType, bonusRule: args.bonusRule,
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
  /** ADMIN_ADJUST only: the approval this operation executes. */
  adjustmentApproval?: AdjustmentApprovalPin;
};

/** Gifts spend proven spendable Coins only; administrative debits retain their approved allocation. */
export async function debitCoins(tx: EconomicTx, userId: string, amount: number, args: DebitCoinsArgs) {
  safePositive(amount, 'Coin debit');
  const { wallet, account } = await lockEconomicWallet(tx, userId);
  const lots = await lockLots(tx, userId);
  requireClassified(account.classifiedAt);
  assertBalanceMatchesLots(wallet.coinsBalance, lots, account.classifiedAt);
  let funding: FundingShare[];
  try {
    funding = allocateFunding(usableSpendLots(lots, new Date()).filter(lot=>args.type!=='GIFT_SPEND'||lot.lotClass==='WITHDRAWABLE'), amount);
  } catch (error) {
    if (error instanceof RangeError) throw ApiError.badRequest(args.type==='GIFT_SPEND'?'Insufficient spendable Coins. Free reward Coins are for betting only.':'Insufficient tracked Coins');
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
    snapshot: args.type === 'ADMIN_ADJUST' ? adjustmentSnapshot(args) : undefined,
  });
  const sourceById = new Map(lots.map((lot) => [lot.id, lot]));
  for (const [index, share] of funding.entries()) {
    const source = sourceById.get(share.lotId)!;
    const obligationShare = source.lotClass === 'RESTRICTED'
      ? splitObligation(Math.max(0, source.requirementAmount - source.progressAmount),
          share.amount, source.availableAmount + source.reservedAmount).moved : undefined;
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
  const profitPlans: {lot:LockedLot;amount:number}[]=[];
  const conversionPlans: {
    lot: LockedLot; availableAfter: number; progressAfter: number;
    convertAmount: number; forfeitAmount: number;
  }[] = [];

  // Predict the post-settlement state while every source lot is locked. This
  // lets the immutable WAGER snapshot include cap forfeitures as well.
  for (const share of funding) {
    const lot = sourceById.get(share.lotId)!;
    if (lot.lotClass !== 'RESTRICTED') continue;
    if(lot.bonusRule==='NET_WINNINGS_V1') {
      const profit=Math.min(Math.max(0,(payoutById.get(lot.id)??0)-share.amount),Number(BigInt(Math.max(0,args.payout-args.stake))*BigInt(share.amount)/BigInt(args.stake)));
      if(profit)profitPlans.push({lot,amount:profit});
      continue;
    }
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
    // Offsetting Spin Win tickets can turn a bonus obligation into low-variance
    // wagering. Keep it non-qualifying even if an older policy lists the game.
    const qualifies = args.gameKey !== 'spin_win'
      && games.includes(args.gameKey) && args.stake <= pinned.maxQualifyingStake;
    const progress = qualifies
      ? Math.min(share.amount, Math.max(0, lot.requirementAmount - lot.progressAmount)) : 0;
    progressById.set(lot.id, progress);
    const progressAfter = lot.progressAmount + progress;
    const availableAfter = lot.availableAmount - share.amount + (payoutById.get(lot.id) ?? 0);
    // A pending hold must retain this source lot and its original restriction.
    // Conversion waits until all reserved value returns or settles.
    if (progressAfter < lot.requirementAmount || availableAfter <= 0 || lot.reservedAmount > 0) continue;
    const cap = pinned.maxConversionMultiple === null
      ? availableAfter
      : exactConversionCap(lot.amount, pinned.maxConversionMultiple);
    const convertAmount = Math.min(availableAfter, cap);
    conversionPlans.push({ lot, availableAfter, progressAfter,
      convertAmount, forfeitAmount: availableAfter - convertAmount });
  }

  const changes: BalanceChange[] = [{
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
    snapshot: args.responseSnapshot(finalCoinsBalance) as Prisma.InputJsonObject,
  });
  let sequence = 0;
  for (const share of funding) {
    const source = sourceById.get(share.lotId)!;
    const obligationShare = source.lotClass === 'RESTRICTED'
      ? splitObligation(Math.max(0, source.requirementAmount - source.progressAmount),
          share.amount, source.availableAmount + source.reservedAmount).moved : undefined;
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
  for(const {lot,amount} of profitPlans) await convertRewardProfit(tx,userId,lot,amount,args.sessionId,'GAME_SESSION',args.createdBy);
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
    walletTransactionIds: [...balanceResult.transactions.map((t) => t.id),
      ...forfeitureTransactions.values()],
    wagerOperationId: wager.id, payoutOperationId, funding, payoutShares };
}


async function convertRewardProfit(tx:EconomicTx,userId:string,lot:LockedLot,amount:number,settlementId:string,sourceKind:'GAME_SESSION'|'SCHEDULED_STAKE',createdBy?:string) {
    const source=await tx.coinProvenance.findUniqueOrThrow({where:{id:lot.id}});
    const conversion=await createOperation(tx,{type:'BONUS_CONVERSION',userId,scopeType:'BONUS_NET_WIN',scopeId:`${settlementId}:${lot.id}`,
      policy:{id:lot.countryPolicyId!,version:lot.countryPolicyVersion!},createdBy,
      snapshot:{rule:'NET_WINNINGS_V1',sourceLotId:lot.id,sessionId:settlementId,sourceKind}});
    const successor=await tx.coinProvenance.create({data:{userId,amount,provenanceType:'CONVERSION',restrictionStatus:'UNRESTRICTED',
      originalSource:source.originalSource,originalGrantReferenceType:source.originalGrantReferenceType,originalGrantReferenceId:source.originalGrantReferenceId,
      countryPolicyId:lot.countryPolicyId,countryPolicyVersion:lot.countryPolicyVersion,lotClass:'WITHDRAWABLE',state:'OPEN',
      availableAmount:0,reservedAmount:0,requirementAmount:0,progressAmount:0,mintedAt:new Date(),availableAt:new Date(),
      sourceOperationId:conversion.id,parentLotId:lot.id,rootLotId:lot.rootLotId??lot.id}});
    await entry(tx,{operationId:conversion.id,userId,lotId:lot.id,sequence:0,entryType:'CONVERT_OUT',availableDelta:-amount,counterpartyLotId:successor.id});
    await entry(tx,{operationId:conversion.id,userId,lotId:successor.id,sequence:1,entryType:'CONVERT_IN',availableDelta:amount,counterpartyLotId:lot.id});
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
  const total = source.reduce((n: number, row: { reservedDelta: number }) => n + row.reservedDelta, 0);
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
  const total = source.reduce((n: number, row: { reservedDelta: number }) => n + row.reservedDelta, 0);
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

export interface ScheduledStakeArgs {
  holdId: string;
  amount: number;
  policy: PolicyPin;
  gameKey: "spin_win";
  rulesId: "single-zero-rtp90-v2";
  /** Owner-admission-only terms. No player route accepts this snapshot. */
  financialTicket?: { roundId: string; bets: string; payouts: number[] };
}

/** Internal primitive. Caller owns admission/jurisdiction locks before L5/L6.
 * No player route calls it; the new SQL gate defaults disabled.
 * The stable hold ID is the replay identity, never generated on a retry.
 */
export async function reserveScheduledStakeCoins(
  tx: EconomicTx,
  userId: string,
  args: ScheduledStakeArgs,
) {
  safePositive(args.amount, "Scheduled stake");
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(args.holdId) ||
    args.gameKey !== "spin_win" ||
    args.rulesId !== "single-zero-rtp90-v2"
  ) {
    throw ApiError.badRequest("Invalid scheduled hold terms");
  }
  if (args.financialTicket && (
    !/^[A-Za-z0-9_:-]{1,128}$/.test(args.financialTicket.roundId) ||
    args.financialTicket.bets.length > 4096 ||
    args.financialTicket.payouts.length !== 37 ||
    args.financialTicket.payouts.some((value) => !Number.isSafeInteger(value) || value < 0)
  )) throw ApiError.badRequest("Invalid financial ticket terms");
  // This scope lock must precede wallet/lot acquisition for every caller.
  await lockUserEconomicScope(tx, `scheduled-stake:${args.holdId}`);
  const prior = await tx.scheduledStakeHold.findUnique({
    where: { id: args.holdId },
    include: { holdOperation: true },
  });
  if (prior) {
    if (
      prior.userId !== userId ||
      prior.amount !== args.amount ||
      prior.gameKey !== args.gameKey ||
      prior.rulesId !== args.rulesId ||
      prior.policyId !== args.policy.id ||
      prior.policyVersion !== args.policy.version ||
      (() => {
        const stored = (prior.holdOperation.snapshot as Record<string, unknown> | null)?.financialTicket as
          { roundId?: string; bets?: string; payouts?: number[] } | undefined;
        const requested = args.financialTicket;
        return stored?.roundId !== requested?.roundId || stored?.bets !== requested?.bets ||
          JSON.stringify(stored?.payouts) !== JSON.stringify(requested?.payouts);
      })()
    )
      throw ApiError.conflict(
        "Scheduled hold identity reused with different terms",
      );
    const walletEntry = await tx.walletTransaction.findUniqueOrThrow({
      where: { id: prior.holdOperation.walletTransactionIds[0] },
    });
    return {
      holdId: prior.id,
      holdOperationId: prior.holdOperationId,
      coinsBalance: walletEntry.balanceAfter,
      isReplay: true,
    };
  }
  const gate = await tx.$queryRaw<
    { enabled: boolean }[]
  >`SELECT enabled FROM platform_gates WHERE key='SCHEDULED_STAKE_HOLD' FOR SHARE`;
  if (!gate[0]?.enabled)
    throw ApiError.forbidden("Scheduled stake holds are disabled");
  const published = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM public.country_casino_policies
    WHERE id=${args.policy.id} AND version=${args.policy.version} AND state='ACTIVE' FOR SHARE`;
  if (!published.length)
    throw ApiError.conflict("Scheduled stake requires an active published policy");
  const { wallet, account } = await lockEconomicWallet(tx, userId);
  const lots = await lockLots(tx, userId);
  requireClassified(account.classifiedAt);
  assertBalanceMatchesLots(wallet.coinsBalance, lots, account.classifiedAt);
  const [{ now }] = await tx.$queryRaw<
    { now: Date }[]
  >`SELECT clock_timestamp() AS now`;
  let funding: FundingShare[];
  try {
    funding = allocateFunding(usableSpendLots(lots, now), args.amount);
  } catch (error) {
    if (error instanceof RangeError)
      throw ApiError.badRequest("Insufficient tracked Coins");
    throw error;
  }
  const balance = await applyBalanceChanges(
    tx,
    userId,
    [
      {
        currency: "COINS",
        amount: args.amount,
        ledgerType: "DEBIT",
        transactionType: "COIN_DEBIT",
        referenceType: "GAME",
        referenceId: args.holdId,
        description: "Scheduled stake hold",
      },
    ],
    { coinLedgerIntent: COIN_LEDGER_INTENT },
  );
  const operation = await createOperation(tx, {
    type: "SCHEDULED_STAKE_HOLD",
    userId,
    scopeType: "SCHEDULED_STAKE",
    scopeId: args.holdId,
    policy: args.policy,
    walletTransactionIds: [balance.transactions[0].id],
    snapshot: { gameKey: args.gameKey, rulesId: args.rulesId,
      ...(args.financialTicket ? { financialTicket: args.financialTicket } : {}) },
  });
  await tx.scheduledStakeHold.create({
    data: {
      id: args.holdId,
      userId,
      amount: args.amount,
      policyId: args.policy.id,
      policyVersion: args.policy.version,
      gameKey: args.gameKey,
      rulesId: args.rulesId,
      holdOperationId: operation.id,
    },
  });
  for (const [sequence, share] of funding.entries())
    await entry(tx, {
      operationId: operation.id,
      userId,
      lotId: share.lotId,
      sequence,
      entryType: "RESERVE",
      availableDelta: -share.amount,
      reservedDelta: share.amount,
    });
  await flushCoinLedgerConstraints(tx);
  // This new deferred trigger must be checked before Prisma's callback
  // resolves. Financial admission flushes it after its matching reserve.
  if (!args.financialTicket) {
    await tx.$executeRawUnsafe('SET CONSTRAINTS house_financial_hold_proof, house_financial_reserve_proof IMMEDIATE');
    await tx.$executeRawUnsafe('SET CONSTRAINTS house_financial_hold_proof, house_financial_reserve_proof DEFERRED');
  }
  return {
    holdId: args.holdId,
    holdOperationId: operation.id,
    coinsBalance: balance.coinsBalance,
    isReplay: false,
  };
}

/** Full source-preserving refund only. No generic MINT or reclassification. */
export async function refundScheduledStakeCoins(
  tx: EconomicTx,
  userId: string,
  holdId: string,
) {
  await lockUserEconomicScope(tx, `scheduled-stake:${holdId}`);
  const hold = await tx.scheduledStakeHold.findUnique({
    where: { id: holdId },
    include: { refundOperation: true },
  });
  if (!hold || hold.userId !== userId)
    throw ApiError.notFound("Scheduled hold not found");
  if (hold.refundOperation) {
    const walletEntry = await tx.walletTransaction.findUniqueOrThrow({
      where: { id: hold.refundOperation.walletTransactionIds[0] },
    });
    return {
      refundOperationId: hold.refundOperationId!,
      coinsBalance: walletEntry.balanceAfter,
      isReplay: true,
    };
  }
  const [financial] = await tx.$queryRaw<Array<{ has_ticket: boolean }>>`
    SELECT snapshot ? 'financialTicket' AS has_ticket
    FROM public.economic_operations WHERE id=${hold.holdOperationId}`;
  if (financial?.has_ticket) {
    throw ApiError.conflict('Financial ticket settlement is not available');
  }
  const { wallet, account } = await lockEconomicWallet(tx, userId);
  const lots = await lockLots(tx, userId);
  assertBalanceMatchesLots(wallet.coinsBalance, lots, account.classifiedAt);
  const source = await tx.coinLotEntry.findMany({
    where: { operationId: hold.holdOperationId, entryType: "RESERVE" },
    orderBy: { sequence: "asc" },
  });
  if (source.reduce((sum, e) => sum + e.reservedDelta, 0) !== hold.amount)
    throw ApiError.internal("Scheduled hold proof mismatch");
  const balance = await applyBalanceChanges(
    tx,
    userId,
    [
      {
        currency: "COINS",
        amount: hold.amount,
        ledgerType: "CREDIT",
        transactionType: "COIN_CREDIT",
        referenceType: "GAME",
        referenceId: hold.id,
        description: "Scheduled stake refund",
      },
    ],
    { coinLedgerIntent: COIN_LEDGER_INTENT },
  );
  const operation = await createOperation(tx, {
    type: "SCHEDULED_STAKE_REFUND",
    userId,
    scopeType: "SCHEDULED_STAKE",
    scopeId: hold.id,
    policy: { id: hold.policyId, version: hold.policyVersion },
    walletTransactionIds: [balance.transactions[0].id],
    reversesOperationId: hold.holdOperationId,
  });
  for (const [sequence, reserve] of source.entries())
    await entry(tx, {
      operationId: operation.id,
      userId,
      lotId: reserve.lotId,
      sequence,
      entryType: "RELEASE",
      availableDelta: -reserve.availableDelta,
      reservedDelta: -reserve.reservedDelta,
      reversesEntryId: reserve.id,
    });
  await tx.scheduledStakeHold.update({
    where: { id: hold.id },
    data: { state: "REFUNDED", refundOperationId: operation.id },
  });
  await flushCoinLedgerConstraints(tx);
  await tx.$executeRawUnsafe('SET CONSTRAINTS house_financial_hold_proof, house_financial_reserve_proof IMMEDIATE');
  await tx.$executeRawUnsafe('SET CONSTRAINTS house_financial_hold_proof, house_financial_reserve_proof DEFERRED');
  return {
    refundOperationId: operation.id,
    coinsBalance: balance.coinsBalance,
    isReplay: false,
  };
}

/** Owner settlement adapter only. Caller locks user, capital, round and hold,
 * then writes the matching capital resolution before flushing constraints.
 * Funds were already debited at admission: settlement never debits again.
 */
export async function resolveFinancialStakeCoins(
  tx: EconomicTx,
  userId: string,
  args: { holdId: string; roundId: string; disposition: 'SETTLED' | 'CANCELLED';
    payout: number; outcome: number | null; reason?: string },
) {
  safeNonnegative(args.payout, 'Scheduled payout');
  await lockUserEconomicScope(tx, `scheduled-stake:${args.holdId}`);
  const hold = await tx.scheduledStakeHold.findUniqueOrThrow({ where: { id: args.holdId } });
  if (hold.userId !== userId || hold.state !== 'HELD')
    throw ApiError.conflict('Financial hold is not pending');
  const { wallet, account } = await lockEconomicWallet(tx, userId);
  const lots = await lockLots(tx, userId);
  requireClassified(account.classifiedAt);
  assertBalanceMatchesLots(wallet.coinsBalance, lots, account.classifiedAt);
  const sources = await tx.coinLotEntry.findMany({
    where: { operationId: hold.holdOperationId, entryType: 'RESERVE' },
    orderBy: { sequence: 'asc' },
  });
  if (sources.reduce((sum, e) => sum + e.reservedDelta, 0) !== hold.amount)
    throw ApiError.conflict('Financial source proof mismatch');
  if (args.disposition === 'CANCELLED' && args.payout !== hold.amount)
    throw ApiError.conflict('Cancellation must return the complete stake');
  const balance = args.payout === 0 ? null : await applyBalanceChanges(tx, userId, [{
    currency: 'COINS', amount: args.payout, ledgerType: 'CREDIT', transactionType: 'COIN_CREDIT',
    referenceType: 'GAME', referenceId: hold.id,
    description: args.disposition === 'CANCELLED' ? 'Cancelled scheduled stake refund' : 'Scheduled Spin Win payout',
  }], { coinLedgerIntent: COIN_LEDGER_INTENT });
  const coinsBalance = balance?.coinsBalance ?? wallet.coinsBalance;
  const operation = await createOperation(tx, {
    type: args.disposition === 'CANCELLED' ? 'SCHEDULED_STAKE_REFUND' : 'SCHEDULED_STAKE_SETTLE',
    userId, scopeType: 'SCHEDULED_STAKE', scopeId: hold.id,
    policy: { id: hold.policyId, version: hold.policyVersion },
    reversesOperationId: hold.holdOperationId,
    walletTransactionIds: balance ? [balance.transactions[0].id] : [],
    snapshot: { roundId: args.roundId, outcome: args.outcome, payout: args.payout,
      coinsBalance, ...(args.reason ? { reason: args.reason } : {}) },
  });
  let sequence = 0;
  for (const source of sources) {
    await entry(tx, { operationId: operation.id, userId, lotId: source.lotId, sequence: sequence++,
      entryType: args.disposition === 'CANCELLED' ? 'RELEASE' : 'FINALIZE',
      availableDelta: args.disposition === 'CANCELLED' ? source.reservedDelta : 0,
      reservedDelta: -source.reservedDelta, reversesEntryId: source.id });
  }
  if (args.disposition === 'SETTLED' && args.payout > 0) {
    // SQL and the deferred proof use the same exact source allocation; ties
    // use database C collation, so localeCompare cannot change the split.
    const returns = await tx.$queryRaw<Array<{ lot_id: string; amount: bigint }>>`
      SELECT lot_id,amount FROM public.scheduled_stake_payout_sources(${hold.id},${args.payout}::integer)`;
    for (const share of returns) if (share.amount > 0n) {
      await entry(tx, { operationId: operation.id, userId, lotId: share.lot_id,
        sequence: sequence++, entryType: 'RETURN', availableDelta: Number(share.amount) });
    }
  }
  if(args.disposition==='SETTLED'&&args.payout>hold.amount) {
    const returns=await tx.coinLotEntry.findMany({where:{operationId:operation.id,entryType:'RETURN'}});
    for(const source of sources) {
      const lot=lots.find(item=>item.id===source.lotId)!;
      if(lot.bonusRule!=='NET_WINNINGS_V1')continue;
      const returned=returns.find(item=>item.lotId===source.lotId)?.availableDelta??0;
      const amount=Math.min(Math.max(0,returned-source.reservedDelta),Number(BigInt(args.payout-hold.amount)*BigInt(source.reservedDelta)/BigInt(hold.amount)));
      if(amount)await convertRewardProfit(tx,userId,lot,amount,hold.id,'SCHEDULED_STAKE');
    }
  }
  await tx.scheduledStakeHold.update({ where: { id: hold.id }, data: args.disposition === 'CANCELLED'
    ? { state: 'REFUNDED', refundOperationId: operation.id }
    : { state: 'SETTLED', settlementOperationId: operation.id } });
  await closeEmptyLots(tx, userId);
  return { operationId: operation.id, coinsBalance };
}
