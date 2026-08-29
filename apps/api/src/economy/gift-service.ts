import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';
import { getOrCreateWallet, applyBalanceChanges, BalanceChange } from './wallet-service';

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

    // Update limited gift quantity atomically and conditionally.
    // Re-check inside the transaction so concurrent sends cannot drive
    // the remaining quantity below zero.
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

      if (result.count === 0) {
        throw ApiError.conflict('This limited gift just sold out, please retry');
      }
    }

    // Resolve wallet ids for the GiftTransaction record.
    const senderWalletRow = await tx.wallet.findUnique({ where: { userId: senderId } });
    const recipientWalletRow = await tx.wallet.findUnique({ where: { userId: recipientId } });
    if (!senderWalletRow) throw ApiError.internal('Sender wallet not found');
    if (!recipientWalletRow) throw ApiError.internal('Recipient wallet not found');

    // Create the GiftTransaction FIRST so its id can be used as the
    // ledger referenceId, making ledger entries traceable to the gift.
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
        senderWalletId: senderWalletRow.id,
        recipientWalletId: recipientWalletRow.id,
      },
    });

    // Create notification for recipient.
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

    // Debit sender Coins via the SINGLE authoritative balance path.
    // Non-negativity check, version-lock, and ledger entry are all handled
    // by applyBalanceChanges — no second balance implementation here.
    await applyBalanceChanges(tx, senderId, [
      {
        currency: 'COINS',
        amount: totalCoins,
        ledgerType: 'DEBIT',
        transactionType: 'COIN_DEBIT',
        referenceType: 'GIFT',
        referenceId: giftTransaction.id,
        description: `Sent ${quantity}x ${gift.name} to ${recipientUser.username}`,
      },
    ]);

    // Credit recipient Game Points via the same authoritative path.
    await applyBalanceChanges(tx, recipientId, [
      {
        currency: 'GAME_POINTS',
        amount: totalGamePoints,
        ledgerType: 'CREDIT',
        transactionType: 'GAME_POINT_CREDIT',
        referenceType: 'GIFT',
        referenceId: giftTransaction.id,
        description: `Received ${quantity}x ${gift.name} from ${senderId}`,
      },
    ]);

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
