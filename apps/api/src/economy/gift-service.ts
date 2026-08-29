import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';
import { executeBalanceChange, getOrCreateWallet } from './wallet-service';

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
  giftName: string;
  quantity: number;
  totalCoins: number;
  totalGamePoints: number;
  coinPriceAtTransaction: number;
  pointValueAtTransaction: number;
  createdAt: Date;
}

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

  // 1. Validate quantity
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_GIFT_QUANTITY) {
    throw ApiError.badRequest(`Quantity must be between 1 and ${MAX_GIFT_QUANTITY}`);
  }

  // 2. Prevent self-sending
  if (senderId === recipientId) {
    throw ApiError.badRequest('Cannot send gifts to yourself');
  }

  // 3. Load gift from server
  const gift = await prisma.gift.findUnique({ where: { id: giftId } });

  if (!gift) {
    throw ApiError.notFound('Gift not found');
  }

  if (!gift.isActive) {
    throw ApiError.badRequest('This gift is no longer available');
  }

  if (gift.isLimited && gift.limitedQuantity !== null && gift.limitedQuantity < quantity) {
    throw ApiError.badRequest(`Only ${gift.limitedQuantity} of this gift remaining`);
  }

  // 4. Server-calculated costs
  const totalCoins = gift.coinPrice * quantity;
  const totalGamePoints = gift.recipientPointValue * quantity;

  // 5. Ensure both wallets exist
  await getOrCreateWallet(senderId);
  await getOrCreateWallet(recipientId);

  // 6. Load wallets for recipient existence check
  const recipientUser = await prisma.user.findUnique({ where: { id: recipientId } });
  if (!recipientUser) {
    throw ApiError.notFound('Recipient not found');
  }

  // 7. Execute atomic gift transaction
  return prisma.$transaction(async (tx) => {
    // Check idempotency
    if (idempotencyKey) {
      const existing = await tx.idempotencyRecord.findUnique({
        where: {
          userId_key: { userId: senderId, key: idempotencyKey },
        },
      });

      if (existing) {
        if (existing.status === 'SUCCEEDED' && existing.responseKey) {
          const gt = await tx.giftTransaction.findUnique({
            where: { id: existing.responseKey },
          });
          if (gt) {
            return {
              giftId: gift.id,
              giftName: gift.name,
              quantity: gt.quantity,
              totalCoins: gt.totalCoins,
              totalGamePoints: gt.totalGamePoints,
              coinPriceAtTransaction: gt.coinPriceAtTransaction,
              pointValueAtTransaction: gt.pointValueAtTransaction,
              createdAt: gt.createdAt,
            };
          }
        }
        throw ApiError.conflict('Operation already in progress');
      }
    }

    // Load sender wallet with version lock
    const senderWallet = await tx.wallet.findUnique({
      where: { userId: senderId },
      select: { id: true, coinsBalance: true, version: true },
    });

    if (!senderWallet) {
      throw ApiError.internal('Sender wallet not found');
    }

    // Verify sufficient coins
    if (senderWallet.coinsBalance < totalCoins) {
      throw ApiError.badRequest(
        `Insufficient Coins: have ${senderWallet.coinsBalance}, need ${totalCoins}`
      );
    }

    // Load recipient wallet
    const recipientWallet = await tx.wallet.findUnique({
      where: { userId: recipientId },
      select: { id: true, gamePointsBalance: true, version: true },
    });

    if (!recipientWallet) {
      throw ApiError.internal('Recipient wallet not found');
    }

    // Debit sender coins (version-locked)
    const newSenderCoins = senderWallet.coinsBalance - totalCoins;
    const senderDebit = await tx.wallet.updateMany({
      where: {
        id: senderWallet.id,
        version: senderWallet.version,
      },
      data: {
        coinsBalance: newSenderCoins,
        version: { increment: 1 },
      },
    });

    if (senderDebit.count === 0) {
      throw ApiError.conflict('Concurrent wallet modification — please retry');
    }

    // Credit recipient game points (version-locked)
    const newRecipientGamePoints = recipientWallet.gamePointsBalance + totalGamePoints;
    const recipientCredit = await tx.wallet.updateMany({
      where: {
        id: recipientWallet.id,
        version: recipientWallet.version,
      },
      data: {
        gamePointsBalance: newRecipientGamePoints,
        version: { increment: 1 },
      },
    });

    if (recipientCredit.count === 0) {
      throw ApiError.conflict('Concurrent wallet modification — please retry');
    }

    // Create sender wallet transaction
    await tx.walletTransaction.create({
      data: {
        walletId: senderWallet.id,
        userId: senderId,
        type: 'COIN_DEBIT',
        ledgerType: 'DEBIT',
        currency: 'COINS',
        amount: totalCoins,
        balanceBefore: senderWallet.coinsBalance,
        balanceAfter: newSenderCoins,
        referenceType: 'GIFT',
        description: `Sent ${quantity}x ${gift.name} to ${recipientUser.username}`,
      },
    });

    // Create recipient wallet transaction
    await tx.walletTransaction.create({
      data: {
        walletId: recipientWallet.id,
        userId: recipientId,
        type: 'GAME_POINT_CREDIT',
        ledgerType: 'CREDIT',
        currency: 'GAME_POINTS',
        amount: totalGamePoints,
        balanceBefore: recipientWallet.gamePointsBalance,
        balanceAfter: newRecipientGamePoints,
        referenceType: 'GIFT',
        description: `Received ${quantity}x ${gift.name} from ${senderId}`,
      },
    });

    // Create gift transaction record
    const giftTransaction = await tx.giftTransaction.create({
      data: {
        senderId,
        recipientId,
        giftId: gift.id,
        quantity,
        totalCoins,
        totalGamePoints,
        coinPriceAtTransaction: gift.coinPrice,
        pointValueAtTransaction: gift.recipientPointValue,
        senderWalletId: senderWallet.id,
        recipientWalletId: recipientWallet.id,
      },
    });

    // Create notification for recipient
    await tx.notification.create({
      data: {
        userId: recipientId,
        type: 'GIFT_RECEIVED',
        title: 'Gift received',
        body: `You received ${quantity}x ${gift.name}`,
        data: {
          giftId: gift.id,
          giftName: gift.name,
          senderId,
          quantity,
          totalGamePoints,
        },
      },
    });

    // Record idempotency
    if (idempotencyKey) {
      await tx.idempotencyRecord.create({
        data: {
          userId: senderId,
          key: idempotencyKey,
          operation: 'gift_send',
          status: 'SUCCEEDED',
          responseKey: giftTransaction.id,
        },
      });
    }

    // Update limited gift quantity atomically and conditionally.
    // Because the gift row was read outside the transaction, we re-check the
    // current quantity inside the transaction and use a conditional update so
    // concurrent sends cannot drive the remaining quantity below zero.
    if (gift.isLimited && gift.limitedQuantity !== null) {
      const remaining = await tx.gift.findUnique({
        where: { id: gift.id },
        select: { limitedQuantity: true, isActive: true },
      });

      const currentRemaining = remaining?.limitedQuantity ?? 0;

      if (currentRemaining < quantity) {
        throw ApiError.badRequest(`Only ${currentRemaining} of this gift remaining`);
      }

      const newRemaining = currentRemaining - quantity;

      const result = await tx.gift.updateMany({
        where: {
          id: gift.id,
          limitedQuantity: { gte: quantity },
        },
        data: {
          limitedQuantity: newRemaining,
          isActive: newRemaining > 0,
        },
      });

      // If no row matched, another concurrent transaction consumed the stock.
      if (result.count === 0) {
        throw ApiError.conflict('This limited gift just sold out, please retry');
      }
    }

    return {
      giftId: gift.id,
      giftName: gift.name,
      quantity: giftTransaction.quantity,
      totalCoins: giftTransaction.totalCoins,
      totalGamePoints: giftTransaction.totalGamePoints,
      coinPriceAtTransaction: giftTransaction.coinPriceAtTransaction,
      pointValueAtTransaction: giftTransaction.pointValueAtTransaction,
      createdAt: giftTransaction.createdAt,
    };
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
