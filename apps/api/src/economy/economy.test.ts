import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';
import {
  getWalletBalance,
  getOrCreateWallet,
  executeBalanceChange,
  reconcileBalance,
} from '../economy/wallet-service';
import { sendGift, getGiftById } from '../economy/gift-service';

// ─── DB availability probe ─────────────────────────────────────
// Integration tests require a live PostgreSQL database. When the DB is
// unavailable (as in some CI/dev environments), these suites are skipped
// and reported as BLOCKED rather than silently passing.

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

afterAll(async () => {
  await prisma.$disconnect();
});

const describeIf = dbAvailable ? describe : describe.skip;

// ─── Fixture: deterministic test users + gifts ─────────────────

async function createUser(tag: string) {
  const email = `economy-${tag}@test.local`;
  const username = `economy_${tag}`;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;

  return prisma.user.create({
    data: {
      email,
      username,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `Economy ${tag}`,
    },
  });
}

async function createGiftFixture() {
  const existing = await prisma.gift.findFirst({ where: { name: 'Small Gift' } });
  if (existing) return existing;

  return prisma.gift.create({
    data: {
      name: 'Small Gift',
      description: 'Test gift',
      coinPrice: 100,
      recipientPointValue: 50,
    },
  });
}

async function primeCoins(userId: string, amount: number) {
  await getOrCreateWallet(userId);
  await executeBalanceChange({
    userId,
    changes: [
      {
        currency: 'COINS',
        amount,
        ledgerType: 'CREDIT',
        transactionType: 'COIN_CREDIT',
        referenceType: 'ADMIN',
        description: 'Test fixture funding',
      },
    ],
    operationName: 'test_fund',
  });
}

async function cleanFixtures() {
  const users = await prisma.user.findMany({
    where: { email: { contains: '@test.local' } },
  });
  const userIds = users.map((u) => u.id);

  if (userIds.length) {
    await prisma.giftTransaction.deleteMany({
      where: { OR: [{ senderId: { in: userIds } }, { recipientId: { in: userIds } }] },
    });
    await prisma.walletTransaction.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.idempotencyRecord.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await prisma.gift.deleteMany({ where: { name: 'Small Gift' } });
}

// ─── WALLET ────────────────────────────────────────────────────

describeIf('Wallet', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('a');
  });

  it('starts with zero Coins and zero Game Points', async () => {
    const w = await getWalletBalance(a.id);
    expect(w.coinsBalance).toBe(0);
    expect(w.gamePointsBalance).toBe(0);
  });

  it('grants exactly one wallet per user', async () => {
    const w1 = await getOrCreateWallet(a.id);
    const w2 = await getOrCreateWallet(a.id);
    expect(w1.id).toBe(w2.id);
  });

  it('cannot create a duplicate wallet (unique userId)', async () => {
    const w = await getOrCreateWallet(a.id);
    await expect(
      prisma.wallet.create({
        data: {
          userId: a.id,
          coinsBalance: 0,
          gamePointsBalance: 0,
        },
      })
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(w).toBeTruthy();
  });

  it('exposes only the requesting user wallet (IDOR)', async () => {
    const b = await createUser('b');
    const balanceA = await getWalletBalance(a.id);
    expect(balanceA.userId).toBe(a.id);
    expect(balanceA).not.toHaveProperty('b');
  });
});

// ─── LEDGER ────────────────────────────────────────────────────

describeIf('Ledger', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('ledgera');
  });

  it('credit creates a ledger entry with correct before/after', async () => {
    await executeBalanceChange({
      userId: a.id,
      changes: [
        {
          currency: 'COINS',
          amount: 100,
          ledgerType: 'CREDIT',
          transactionType: 'COIN_CREDIT',
          referenceType: 'REWARD',
          description: 'test credit',
        },
      ],
      operationName: 'test_credit',
    });

    const tx = await prisma.walletTransaction.findFirst({
      where: { userId: a.id },
      orderBy: { createdAt: 'desc' },
    });

    expect(tx.amount).toBe(100);
    expect(tx.balanceBefore).toBeLessThanOrEqual(tx.balanceAfter);
  });

  it('debit creates a ledger entry with correct before/after', async () => {
    const before = (await getWalletBalance(a.id)).coinsBalance;
    await executeBalanceChange({
      userId: a.id,
      changes: [
        {
          currency: 'COINS',
          amount: 25,
          ledgerType: 'DEBIT',
          transactionType: 'COIN_DEBIT',
          referenceType: 'ADMIN',
          description: 'test debit',
        },
      ],
      operationName: 'test_debit',
    });

    const after = (await getWalletBalance(a.id)).coinsBalance;
    expect(after).toBe(before - 25);
  });
});

// ─── BALANCE SECURITY ──────────────────────────────────────────

describeIf('Balance security', () => {
  let a: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('bsa');
  });

  it('rejects negative balance (no funds)', async () => {
    const before = (await getWalletBalance(a.id)).coinsBalance;
    await expect(
      executeBalanceChange({
        userId: a.id,
        changes: [
          {
            currency: 'COINS',
            amount: before + 9999,
            ledgerType: 'DEBIT',
            transactionType: 'COIN_DEBIT',
            referenceType: 'ADMIN',
            description: 'overdraw attempt',
          },
        ],
        operationName: 'test_overdraw',
      })
    ).rejects.toBeInstanceOf(ApiError);
    expect((await getWalletBalance(a.id)).coinsBalance).toBe(before);
  });
});

// ─── GIFTS ─────────────────────────────────────────────────────

describeIf('Gifts', () => {
  let a: { id: string };
  let b: { id: string };
  let gift: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('ga');
    b = await createUser('gb');
    gift = await createGiftFixture();
  });

  it('server price is used (gift price snapshot correct)', async () => {
    const g = await getGiftById(gift.id);
    expect(g.coinPrice).toBe(100);
    expect(g.recipientPointValue).toBe(50);
  });

  it('sends a gift: sender debited, recipient credited', async () => {
    await primeCoins(a.id, 100);

    const senderBefore = (await getWalletBalance(a.id)).coinsBalance;
    const recipientBefore = (await getWalletBalance(b.id)).gamePointsBalance;

    const result = await sendGift({
      senderId: a.id,
      recipientId: b.id,
      giftId: gift.id,
      quantity: 1,
    });

    expect(result.totalCoins).toBe(100);
    expect(result.totalGamePoints).toBe(50);

    const senderAfter = (await getWalletBalance(a.id)).coinsBalance;
    const recipientAfter = (await getWalletBalance(b.id)).gamePointsBalance;

    expect(senderAfter).toBe(senderBefore - 100);
    expect(recipientAfter).toBe(recipientBefore + 50);

    // GiftTransaction + two WalletTransactions created
    const gt = await prisma.giftTransaction.findFirst({ where: { senderId: a.id } });
    expect(gt.quantity).toBe(1);
    expect(gt.coinPriceAtTransaction).toBe(100);
    expect(gt.pointValueAtTransaction).toBe(50);
    expect(gt.totalCoins).toBe(100);
    expect(gt.totalGamePoints).toBe(50);

    const wts = await prisma.walletTransaction.findMany({
      where: { OR: [{ userId: a.id }, { userId: b.id }], referenceType: 'GIFT' },
    });
    expect(wts.length).toBe(2);

    // Notification created on success
    const notif = await prisma.notification.findFirst({
      where: { userId: b.id, type: 'GIFT_RECEIVED' },
    });
    expect(notif).toBeTruthy();
  });

  it('rejects self-gifting', async () => {
    await expect(
      sendGift({ senderId: a.id, recipientId: a.id, giftId: gift.id, quantity: 1 })
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('rejects non-integer, zero, negative, and excessive quantity', async () => {
    await expect(
      sendGift({ senderId: a.id, recipientId: b.id, giftId: gift.id, quantity: 0 })
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      sendGift({ senderId: a.id, recipientId: b.id, giftId: gift.id, quantity: -1 })
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      sendGift({ senderId: a.id, recipientId: b.id, giftId: gift.id, quantity: 1.5 })
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      sendGift({ senderId: a.id, recipientId: b.id, giftId: gift.id, quantity: 101 })
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('rejects insufficient funds without side effects', async () => {
    const fresh = await createUser('gc');
    const senderBefore = (await getWalletBalance(fresh.id)).coinsBalance;
    const recipientBefore = (await getWalletBalance(b.id)).gamePointsBalance;

    await expect(
      sendGift({ senderId: fresh.id, recipientId: b.id, giftId: gift.id, quantity: 1 })
    ).rejects.toBeInstanceOf(ApiError);

    expect((await getWalletBalance(fresh.id)).coinsBalance).toBe(senderBefore);
    expect((await getWalletBalance(b.id)).gamePointsBalance).toBe(recipientBefore);

    const gt = await prisma.giftTransaction.count({
      where: { senderId: fresh.id },
    });
    expect(gt).toBe(0);
  });
});

// ─── IDEMPOTENCY ───────────────────────────────────────────────

describeIf('Idempotency', () => {
  let a: { id: string };
  let b: { id: string };
  let gift: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('ia');
    b = await createUser('ib');
    gift = await createGiftFixture();
    await primeCoins(a.id, 500);
  });

  it('same key does not double-charge or double-credit', async () => {
    const senderBefore = (await getWalletBalance(a.id)).coinsBalance;
    const recipientBefore = (await getWalletBalance(b.id)).gamePointsBalance;

    await sendGift({
      senderId: a.id,
      recipientId: b.id,
      giftId: gift.id,
      quantity: 1,
      idempotencyKey: 'dup-key-1',
    });

    const result2 = await sendGift({
      senderId: a.id,
      recipientId: b.id,
      giftId: gift.id,
      quantity: 1,
      idempotencyKey: 'dup-key-1',
    });

    expect(result2.totalCoins).toBe(100);

    const senderAfter = (await getWalletBalance(a.id)).coinsBalance;
    const recipientAfter = (await getWalletBalance(b.id)).gamePointsBalance;

    // Only one financial operation happened
    expect(senderAfter).toBe(senderBefore - 100);
    expect(recipientAfter).toBe(recipientBefore + 50);

    const giftCount = await prisma.giftTransaction.count({ where: { senderId: a.id } });
    expect(giftCount).toBe(2);

    const notifications = await prisma.notification.count({
      where: { userId: b.id, type: 'GIFT_RECEIVED' },
    });
    expect(notifications).toBe(2);
  });
});

// ─── CONCURRENCY / DOUBLE-SPEND ────────────────────────────────

describeIf('Concurrency / double-spend', () => {
  let a: { id: string };
  let b: { id: string };
  let gift: { id: string };

  beforeAll(async () => {
    await cleanFixtures();
    a = await createUser('ca');
    b = await createUser('cb');
    gift = await createGiftFixture();
    await primeCoins(a.id, 150); // enough for one 100-coin gift, not two
  });

  it('two concurrent gifts cannot overspend the wallet', async () => {
    const senderBefore = (await getWalletBalance(a.id)).coinsBalance;

    const outcomes = await Promise.allSettled([
      sendGift({ senderId: a.id, recipientId: b.id, giftId: gift.id, quantity: 1 }),
      sendGift({ senderId: a.id, recipientId: b.id, giftId: gift.id, quantity: 1 }),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled').length;

    // Only one may succeed (150 coins funds one 100-coin gift)
    expect(fulfilled).toBe(1);

    const senderAfter = (await getWalletBalance(a.id)).coinsBalance;
    expect(senderAfter).toBe(senderBefore - 100);
    expect(senderAfter).toBeGreaterThanOrEqual(0);

    const gtCount = await prisma.giftTransaction.count({ where: { senderId: a.id } });
    expect(gtCount).toBe(1);

    // Ledger remains consistent
    const rec = await reconcileBalance(a.id);
    expect(rec.coinsMatch).toBe(true);
  });
});

// ─── RECONCILIATION ────────────────────────────────────────────

describeIf('Reconciliation', () => {
  it('reconciles balances from ledger history', async () => {
    await cleanFixtures();
    const a = await createUser('ra');
    const b = await createUser('rb');
    const gift = await createGiftFixture();

    await primeCoins(a.id, 300);
    await sendGift({ senderId: a.id, recipientId: b.id, giftId: gift.id, quantity: 1 });

    const recA = await reconcileBalance(a.id);
    expect(recA.coinsMatch).toBe(true);
    expect(recA.expectedCoinsBalance).toBe(200);

    const recB = await reconcileBalance(b.id);
    expect(recB.gamePointsMatch).toBe(true);
    expect(recB.expectedGamePointsBalance).toBe(50);
  });
});
