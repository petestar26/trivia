import { randomUUID } from 'node:crypto';
import { prisma } from '@socialplay/database';
import type { Prisma } from '@socialplay/database';
import { ApiError } from '../middleware/error-handler.js';
import { applyBalanceChanges, getOrCreateWallet } from './wallet-service.js';
import type { BalanceChange } from './wallet-service.js';
import { debitCoins, lockEconomicWallet, lockUserEconomicScope } from './coin-ledger-service.js';
import { requireActiveGiftPolicy } from './jurisdiction-service.js';

export interface GiftCatalogItem {
  id: string;
  name: string;
  description: string;
  imageUrl: string | null;
  coinPrice: number;
  recipientPointValue: number;
  isAnimated: boolean;
  isLimited: boolean;
  limitedQuantity: number | null;
  isActive: boolean;
}

export interface SendGiftArgs {
  senderId: string;
  recipientId: string;
  giftId: string;
  quantity: number;
  idempotencyKey?: string;
}

export interface GiftTransactionResult {
  giftId: string;
  // Null only for a replay of a pre-CORRECTION-3 row that has no stored
  // snapshot: the historical name is unknown and is never fabricated from
  // the current (possibly renamed) catalog entry.
  giftName: string | null;
  quantity: number;
  totalCoins: number;
  totalGamePoints: number;
  coinPriceAtTransaction: number;
  pointValueAtTransaction: number;
  createdAt: Date;
  isReplay?: boolean;
}

// The exact, immutable snapshot persisted to GiftTransaction.responseSnapshot
// at send time. JSON-serializable (createdAt round-trips as an ISO string).
type GiftResponseSnapshot = Omit<GiftTransactionResult, 'isReplay' | 'createdAt'> & {
  createdAt: string;
};

const MAX_GIFT_QUANTITY = 100;

// ─── Gift Catalog ──────────────────────────────────────────────

export async function listActiveGifts(): Promise<GiftCatalogItem[]> {
  return prisma.gift.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      name: true,
      description: true,
      imageUrl: true,
      coinPrice: true,
      recipientPointValue: true,
      isAnimated: true,
      isLimited: true,
      limitedQuantity: true,
      isActive: true,
    },
  });
}

export async function getGiftById(giftId: string): Promise<GiftCatalogItem> {
  const gift = await prisma.gift.findUnique({
    where: { id: giftId },
    select: {
      id: true,
      name: true,
      description: true,
      imageUrl: true,
      coinPrice: true,
      recipientPointValue: true,
      isAnimated: true,
      isLimited: true,
      limitedQuantity: true,
      isActive: true,
    },
  });

  if (!gift) {
    throw ApiError.notFound('Gift not found');
  }

  return gift;
}

// ─── Send Gift (server-authoritative) ──────────────────────────

export async function sendGift(args: SendGiftArgs): Promise<GiftTransactionResult> {
  const { senderId, recipientId, giftId, quantity, idempotencyKey } = args;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_GIFT_QUANTITY) {
    throw ApiError.badRequest(`Quantity must be between 1 and ${MAX_GIFT_QUANTITY}`);
  }
  if (senderId === recipientId) throw ApiError.badRequest('Cannot send gifts to yourself');
  if (typeof idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)) {
    throw ApiError.badRequest('Gift idempotency key is required');
  }
  const giftTransactionId = randomUUID();
  return prisma.$transaction(async (tx) => {
    await lockUserEconomicScope(tx, `gift:${senderId}:${idempotencyKey}`);
    const previous = await tx.idempotencyRecord.findUnique({
      where: { userId_key: { userId: senderId, key: idempotencyKey } },
    });
    if (previous) {
      if (previous.status !== 'SUCCEEDED' || !previous.responseKey) {
        throw ApiError.conflict('Gift operation is already in progress');
      }
      const prior = await tx.giftTransaction.findUnique({ where: { id: previous.responseKey } });
      if (!prior || prior.giftId !== giftId || prior.recipientId !== recipientId || prior.quantity !== quantity) {
        throw ApiError.conflict('This idempotency key was used for another gift');
      }
      // Exact replay returns the immutable snapshot taken at send time. It
      // must never read the (mutable) gift catalog: a renamed or deleted
      // catalog row must not change what a past response looked like.
      if (prior.responseSnapshot) {
        const snapshot = prior.responseSnapshot as unknown as GiftResponseSnapshot;
        return { ...snapshot, createdAt: new Date(snapshot.createdAt), isReplay: true };
      }
      // Legacy row from before CORRECTION 3: no snapshot was ever taken.
      // Return everything that was already immutably stored on the row
      // itself; the gift's name at send time is genuinely unknown and is
      // never fabricated from the current catalog.
      return {
        giftId: prior.giftId, giftName: null, quantity: prior.quantity,
        totalCoins: prior.totalCoins, totalGamePoints: prior.totalGamePoints,
        coinPriceAtTransaction: prior.coinPriceAtTransaction,
        pointValueAtTransaction: prior.pointValueAtTransaction, createdAt: prior.createdAt,
        isReplay: true,
      };
    }

    // L1: every participant locks user rows in the same order.
    const ids = [senderId, recipientId].sort();
    const users = (await tx.$queryRaw`
      SELECT "id", "username", "status"::text AS "status"
      FROM "users" WHERE "id" IN (${ids[0]}, ${ids[1]})
      ORDER BY "id" FOR SHARE
    `) as { id: string; username: string; status: string }[];
    if (users.length !== 2) throw ApiError.notFound('Gift participant not found');
    if (users.some((user) => user.status !== 'ACTIVE')) {
      throw ApiError.forbidden('Gift participants must have active accounts');
    }
    const recipient = users.find((user) => user.id === recipientId)!;

    // The helper locks the sender's ACTIVE payout account at L2, then the
    // country pointer and immutable active policy at L3.
    const policy = await requireActiveGiftPolicy(tx, senderId);

    // L4: the catalog row is authoritative and locked before any balance.
    const gifts = (await tx.$queryRaw`
      SELECT "id", "name", "coinPrice", "recipientPointValue", "isActive",
             "isLimited", "limitedQuantity"
      FROM "gifts" WHERE "id" = ${giftId} FOR UPDATE
    `) as { id: string; name: string; coinPrice: number; recipientPointValue: number;
      isActive: boolean; isLimited: boolean; limitedQuantity: number | null }[];
    const gift = gifts[0];
    if (!gift) throw ApiError.notFound('Gift not found');
    if (!gift.isActive) throw ApiError.badRequest('This gift is no longer available');
    if (gift.isLimited && (gift.limitedQuantity ?? 0) < quantity) {
      throw ApiError.badRequest(`Only ${gift.limitedQuantity ?? 0} of this gift remaining`);
    }
    const totalCoins = gift.coinPrice * quantity;
    const totalGamePoints = gift.recipientPointValue * quantity;
    if (!Number.isSafeInteger(totalCoins) || totalCoins <= 0 ||
        !Number.isSafeInteger(totalGamePoints) || totalGamePoints <= 0) {
      throw ApiError.badRequest('Gift price is invalid');
    }
    if (gift.isLimited) {
      const remaining = gift.limitedQuantity! - quantity;
      await tx.gift.update({ where: { id: giftId },
        data: { limitedQuantity: remaining, isActive: remaining > 0 } });
    }

    // L5: both wallets are locked ascending before L6 sender lots.
    let senderWallet: { id: string } | undefined;
    let recipientWallet: { id: string } | undefined;
    for (const id of ids) {
      if (id === senderId) {
        senderWallet = (await lockEconomicWallet(tx, id)).wallet;
      } else {
        // The recipient receives only Game Points. Lock their wallet for
        // ordered writes without requiring their unrelated legacy Coin
        // balance to have been classified already.
        await getOrCreateWallet(id, tx);
        const rows = (await tx.$queryRaw`
          SELECT "id" FROM "wallets" WHERE "userId" = ${id} FOR UPDATE
        `) as { id: string }[];
        recipientWallet = rows[0];
      }
    }
    if (!senderWallet || !recipientWallet) throw ApiError.internal('Gift wallet lock failed');

    // Daily aggregation must follow the sender wallet lock. Different gift
    // keys from one sender serialize here, so neither can pass on a stale sum.
    // Use the database clock once for both the UTC window and row timestamp.
    const clockRows = (await tx.$queryRaw`SELECT clock_timestamp() AS "now"`) as { now: Date }[];
    const giftAt = clockRows[0].now;
    const dayStart = new Date(Date.UTC(giftAt.getUTCFullYear(), giftAt.getUTCMonth(), giftAt.getUTCDate()));
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const daily = await tx.giftTransaction.aggregate({
      where: { senderId, createdAt: { gte: dayStart, lt: dayEnd } },
      _sum: { totalCoins: true },
    });
    const alreadySent = daily._sum.totalCoins ?? 0;
    if (totalCoins > policy.giftDailyLimit - alreadySent) {
      throw ApiError.badRequest('Daily gift Coin limit exceeded');
    }

    await debitCoins(tx, senderId, totalCoins, {
      type: 'GIFT_SPEND', scopeType: 'GIFT_TRANSACTION', scopeId: giftTransactionId,
      idempotencyKey, referenceType: 'GIFT', referenceId: giftTransactionId,
      description: `Sent ${quantity}x ${gift.name} to ${recipient.username}`,
    });
    await applyBalanceChanges(tx, recipientId, [{
      currency: 'GAME_POINTS', amount: totalGamePoints, ledgerType: 'CREDIT',
      transactionType: 'GAME_POINT_CREDIT', referenceType: 'GIFT',
      referenceId: giftTransactionId,
      description: `Received ${quantity}x ${gift.name} from ${senderId}`,
    }]);

    // The stored snapshot IS the future replay response. Built once, from
    // values already fixed in this transaction, and persisted verbatim.
    const snapshot: Omit<GiftResponseSnapshot, 'createdAt'> = {
      giftId, giftName: gift.name, quantity, totalCoins, totalGamePoints,
      coinPriceAtTransaction: gift.coinPrice,
      pointValueAtTransaction: gift.recipientPointValue,
    };

    // L7: business, idempotency and notification inserts are atomic with the
    // sender's economic CONSUME and recipient's GP credit.
    const giftTransaction = await tx.giftTransaction.create({
      data: {
        id: giftTransactionId, senderId, recipientId, giftId, quantity,
        createdAt: giftAt,
        totalCoins, totalGamePoints,
        coinPriceAtTransaction: gift.coinPrice,
        pointValueAtTransaction: gift.recipientPointValue,
        senderWalletId: senderWallet.id, recipientWalletId: recipientWallet.id,
        responseSnapshot: {
          ...snapshot, createdAt: giftAt.toISOString(),
        } as unknown as Prisma.InputJsonValue,
      },
    });
    await tx.notification.create({ data: {
      userId: recipientId, type: 'GIFT_RECEIVED', title: 'Gift received',
      body: `You received ${quantity}x ${gift.name}`,
      data: { giftId, giftName: gift.name, senderId, quantity, totalGamePoints },
    } });
    await tx.idempotencyRecord.create({ data: {
      userId: senderId, key: idempotencyKey, operation: 'gift_send',
      status: 'SUCCEEDED', responseKey: giftTransaction.id,
    } });
    return { ...snapshot, createdAt: giftTransaction.createdAt, isReplay: false };
  });
}

// ─── Get Gift Transactions ─────────────────────────────────────

export async function getGiftTransactions(
  userId: string,
  options: { page?: number; limit?: number; role?: 'sender' | 'recipient' } = {}
) {
  const { page = 1, limit = 20, role } = options;

  const where: Record<string, unknown> = {};
  if (role === 'sender') where.senderId = userId;
  else if (role === 'recipient') where.recipientId = userId;
  else where.OR = [{ senderId: userId }, { recipientId: userId }];

  const [transactions, total] = await Promise.all([
    prisma.giftTransaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        gift: {
          select: { id: true, name: true, imageUrl: true, coinPrice: true },
        },
      },
    }),
    prisma.giftTransaction.count({ where }),
  ]);

  return {
    data: transactions,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  };
}
