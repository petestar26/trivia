import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';

export type Currency = 'COINS' | 'GAME_POINTS';

export interface WalletBalanceResponse {
  userId: string;
  coinsBalance: number;
  gamePointsBalance: number;
  updatedAt: Date;
}

export interface WalletTransactionResponse {
  id: string;
  type: string;
  currency: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  referenceType: string;
  referenceId: string | null;
  description: string;
  createdAt: Date;
}

export interface LedgerEntry {
  id: string;
  type: string;
  currency: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  referenceType: string;
  referenceId: string | null;
  description: string;
  createdAt: Date;
}

// ─── Wallet Helpers ─────────────────────────────────────────────

export async function getOrCreateWallet(userId: string, tx?: any) {
  const db = tx || prisma;

  const wallet = await db.wallet.findUnique({ where: { userId } });
  if (wallet) return wallet;

  // Create wallet — unique constraint prevents duplicates
  try {
    return await db.wallet.create({
      data: {
        userId,
        coinsBalance: 0,
        gamePointsBalance: 0,
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      return db.wallet.findUnique({ where: { userId } });
    }
    throw err;
  }
}

// ─── Get Wallet (read-only) ────────────────────────────────────

export async function getWalletBalance(userId: string): Promise<WalletBalanceResponse> {
  const wallet = await getOrCreateWallet(userId);

  return {
    userId: wallet.userId,
    coinsBalance: wallet.coinsBalance,
    gamePointsBalance: wallet.gamePointsBalance,
    updatedAt: wallet.updatedAt,
  };
}

// ─── Get Transaction History ───────────────────────────────────

export async function getWalletTransactions(
  userId: string,
  options: { page?: number; limit?: number; currency?: string } = {}
): Promise<{ data: LedgerEntry[]; total: number; page: number; totalPages: number }> {
  const { page = 1, limit = 20, currency } = options;

  const wallet = await getOrCreateWallet(userId);

  const where: Record<string, unknown> = { walletId: wallet.id };
  if (currency) {
    where.currency = currency.toUpperCase() as Currency;
  }

  const [transactions, total] = await Promise.all([
    prisma.walletTransaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        type: true,
        currency: true,
        amount: true,
        balanceBefore: true,
        balanceAfter: true,
        referenceType: true,
        referenceId: true,
        description: true,
        createdAt: true,
      },
    }),
    prisma.walletTransaction.count({ where }),
  ]);

  return {
    data: transactions,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  };
}

// ─── Atomically credit/debit wallet (internal use) ─────────────

export interface BalanceChange {
  currency: Currency;
  amount: number; // positive integer
  ledgerType: 'CREDIT' | 'DEBIT';
  transactionType: 'COIN_CREDIT' | 'COIN_DEBIT' | 'GAME_POINT_CREDIT' | 'GAME_POINT_DEBIT';
  referenceType: 'GIFT' | 'REWARD' | 'PURCHASE' | 'GAME' | 'ADMIN' | 'TRANSFER' | 'DAILY_REWARD' | 'TASK' | 'ACHIEVEMENT' | 'REFUND';
  referenceId?: string;
  description: string;
}

export interface ExecuteBalanceChangeArgs {
  userId: string;
  changes: BalanceChange[];
  idempotencyKey?: string;
  operationName: string;
}

// Atomic wallet balance change — uses transaction + version lock
export async function executeBalanceChange(args: ExecuteBalanceChangeArgs) {
  const { userId, changes, idempotencyKey, operationName } = args;

  // Check idempotency
  if (idempotencyKey) {
    const existing = await prisma.idempotencyRecord.findUnique({
      where: {
        userId_key: {
          userId,
          key: idempotencyKey,
        },
      },
    });

    if (existing) {
      if (existing.status === 'SUCCEEDED') {
        return { success: true, idempotent: true, recordId: existing.id };
      }
      throw ApiError.conflict('Operation already in progress or failed');
    }
  }

  // Create wallet if needed
  await getOrCreateWallet(userId);

  return prisma.$transaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({
      where: { userId },
      select: { id: true, coinsBalance: true, gamePointsBalance: true, version: true },
    });

    if (!wallet) {
      throw ApiError.internal('Wallet not found');
    }

    // Verify sufficient balance for debits
    for (const change of changes) {
      if (change.ledgerType === 'DEBIT') {
        const balance =
          change.currency === 'COINS' ? wallet.coinsBalance : wallet.gamePointsBalance;
        if (balance < change.amount) {
          throw ApiError.badRequest(
            `Insufficient ${change.currency === 'COINS' ? 'Coins' : 'Game Points'}: have ${balance}, need ${change.amount}`
          );
        }
      }
    }

    // Calculate new balances
    let newCoins = wallet.coinsBalance;
    let newGamePoints = wallet.gamePointsBalance;

    for (const change of changes) {
      if (change.currency === 'COINS') {
        newCoins =
          change.ledgerType === 'CREDIT' ? newCoins + change.amount : newCoins - change.amount;
      } else {
        newGamePoints =
          change.ledgerType === 'CREDIT' ? newGamePoints + change.amount : newGamePoints - change.amount;
      }
    }

    // Ensure non-negative
    if (newCoins < 0) throw ApiError.internal('Negative coin balance detected');
    if (newGamePoints < 0) throw ApiError.internal('Negative game points balance detected');

    // Update wallet with version lock. updateMany returns { count } without
    // throwing when no row matches, so we explicitly check the matched count
    // to detect a concurrent modification.
    const walletUpdate = await tx.wallet.updateMany({
      where: {
        id: wallet.id,
        version: wallet.version,
      },
      data: {
        coinsBalance: newCoins,
        gamePointsBalance: newGamePoints,
        version: { increment: 1 },
      },
    });

    if (walletUpdate.count === 0) {
      throw ApiError.conflict('Concurrent wallet modification — please retry');
    }

    // Create ledger entries
    const walletTransactions = [];
    let tempCoins = wallet.coinsBalance;
    let tempGamePoints = wallet.gamePointsBalance;

    for (const change of changes) {
      const balanceBefore =
        change.currency === 'COINS' ? tempCoins : tempGamePoints;
      const balanceAfter =
        change.ledgerType === 'CREDIT' ? balanceBefore + change.amount : balanceBefore - change.amount;

      const wt = await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          userId,
          type: change.transactionType,
          ledgerType: change.ledgerType,
          currency: change.currency,
          amount: change.amount,
          balanceBefore,
          balanceAfter,
          referenceType: change.referenceType,
          referenceId: change.referenceId ?? null,
          description: change.description,
        },
      });

      walletTransactions.push(wt);

      if (change.currency === 'COINS') tempCoins = balanceAfter;
      else tempGamePoints = balanceAfter;
    }

    // Record idempotency
    if (idempotencyKey) {
      await tx.idempotencyRecord.create({
        data: {
          userId,
          key: idempotencyKey,
          operation: operationName,
          status: 'SUCCEEDED',
          responseKey: walletTransactions[0]?.id,
        },
      });
    }

    return {
      success: true,
      coinsBalance: newCoins,
      gamePointsBalance: newGamePoints,
      transactions: walletTransactions,
    };
  });
}

// ─── Balance Reconciliation (internal / admin) ─────────────────

export async function reconcileBalance(userId: string) {
  const wallet = await getOrCreateWallet(userId);

  const allTx = await prisma.walletTransaction.findMany({
    where: { walletId: wallet.id, status: 'SUCCEEDED' },
    orderBy: { createdAt: 'asc' },
  });

  let expectedCoins = 0;
  let expectedGamePoints = 0;

  for (const tx_ of allTx) {
    const amount = tx_.ledgerType === 'CREDIT' ? tx_.amount : -tx_.amount;
    if (tx_.currency === 'COINS') expectedCoins += amount;
    else expectedGamePoints += amount;
  }

  return {
    userId,
    recordedCoinsBalance: wallet.coinsBalance,
    expectedCoinsBalance: expectedCoins,
    recordedGamePointsBalance: wallet.gamePointsBalance,
    expectedGamePointsBalance: expectedGamePoints,
    coinsMatch: wallet.coinsBalance === expectedCoins,
    gamePointsMatch: wallet.gamePointsBalance === expectedGamePoints,
    totalTransactions: allTx.length,
  };
}
