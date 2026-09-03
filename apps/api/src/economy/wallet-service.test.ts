import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@socialplay/database';
import { getOrCreateWallet, getWalletBalance, executeBalanceChange, applyBalanceChanges } from './wallet-service';

// W-1D0: regression coverage for the withdrawal-refund exemption to
// applyBalanceChanges's MAX_BALANCE overflow guard. No withdrawal
// cancel/refund ROUTE exists yet (out of scope for this hardening
// slice) — these tests call applyBalanceChanges directly with a
// WITHDRAWAL/CREDIT change, exactly as a future refund path would.

// ─── DB availability probe ─────────────────────────────────────

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

const MAX_BALANCE = 1_000_000_000;
const WITHDRAWAL_REFUND_CEILING = 2 * MAX_BALANCE;

// ─── Fixtures ──────────────────────────────────────────────────

async function createUser(tag: string) {
  const email = `wallet-cap-${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `walletcaptest_${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `Wallet Cap Test ${tag}`,
    },
  });
}

async function cleanFixtures() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: 'wallet-cap-' } } });
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    await prisma.walletTransaction.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
  }
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

/** Credits a fresh wallet's COINS balance up to exactly MAX_BALANCE via an
 * ordinary (non-withdrawal) credit — the normal cap check allows this. */
async function creditCoinsToCap(userId: string) {
  await getOrCreateWallet(userId);
  await executeBalanceChange({
    userId,
    changes: [
      {
        currency: 'COINS',
        amount: MAX_BALANCE,
        ledgerType: 'CREDIT',
        transactionType: 'COIN_CREDIT',
        referenceType: 'ADMIN',
        description: 'test fixture: credit coins to cap',
      },
    ],
    operationName: 'test-fixture-credit-coins-to-cap',
  });
}

describeIf('economy/wallet-service — MAX_BALANCE withdrawal-refund exemption (W-1D0)', () => {
  it('rejects an ordinary (non-withdrawal) COINS credit that would exceed MAX_BALANCE', async () => {
    await cleanFixtures();
    const tag = `ordinary-cap-${Date.now()}`;
    const user = await createUser(tag);
    await creditCoinsToCap(user.id);

    await expect(
      prisma.$transaction((tx) =>
        applyBalanceChanges(tx, user.id, [
          {
            currency: 'COINS',
            amount: 1,
            ledgerType: 'CREDIT',
            transactionType: 'COIN_CREDIT',
            referenceType: 'ADMIN',
            description: 'would exceed cap',
          },
        ])
      )
    ).rejects.toThrow(/exceeds maximum/);

    const balance = await getWalletBalance(user.id);
    expect(balance.coinsBalance).toBe(MAX_BALANCE); // unchanged
  });

  it('allows a WITHDRAWAL/CREDIT to push COINS above MAX_BALANCE, within the safe ceiling', async () => {
    await cleanFixtures();
    const tag = `withdrawal-exempt-${Date.now()}`;
    const user = await createUser(tag);
    await creditCoinsToCap(user.id);

    // Balance lands at 1.5e9 — above MAX_BALANCE, comfortably below the
    // 2e9 hard ceiling.
    const refundAmount = 500_000_000;
    await prisma.$transaction((tx) =>
      applyBalanceChanges(tx, user.id, [
        {
          currency: 'COINS',
          amount: refundAmount,
          ledgerType: 'CREDIT',
          transactionType: 'COIN_CREDIT',
          referenceType: 'WITHDRAWAL',
          referenceId: 'test-withdrawal-id',
          description: 'withdrawal cancellation refund',
        },
      ])
    );

    const balance = await getWalletBalance(user.id);
    expect(balance.coinsBalance).toBe(MAX_BALANCE + refundAmount);
    expect(balance.coinsBalance).toBeLessThanOrEqual(WITHDRAWAL_REFUND_CEILING);
  });

  it('still rejects a WITHDRAWAL/CREDIT that would exceed the hard 2x-MAX_BALANCE ceiling', async () => {
    await cleanFixtures();
    const tag = `withdrawal-ceiling-${Date.now()}`;
    const user = await createUser(tag);
    await creditCoinsToCap(user.id);

    // First refund lands exactly at the ceiling — still allowed.
    await prisma.$transaction((tx) =>
      applyBalanceChanges(tx, user.id, [
        {
          currency: 'COINS',
          amount: MAX_BALANCE,
          ledgerType: 'CREDIT',
          transactionType: 'COIN_CREDIT',
          referenceType: 'WITHDRAWAL',
          referenceId: 'test-withdrawal-id-1',
          description: 'withdrawal refund landing exactly at the ceiling',
        },
      ])
    );
    const atCeiling = await getWalletBalance(user.id);
    expect(atCeiling.coinsBalance).toBe(WITHDRAWAL_REFUND_CEILING);

    // A second refund would push past the ceiling — must be rejected,
    // proving the exemption is bounded, not unlimited.
    await expect(
      prisma.$transaction((tx) =>
        applyBalanceChanges(tx, user.id, [
          {
            currency: 'COINS',
            amount: 1,
            ledgerType: 'CREDIT',
            transactionType: 'COIN_CREDIT',
            referenceType: 'WITHDRAWAL',
            referenceId: 'test-withdrawal-id-2',
            description: 'would exceed the hard ceiling',
          },
        ])
      )
    ).rejects.toThrow(/exceeds maximum/);

    const unchanged = await getWalletBalance(user.id);
    expect(unchanged.coinsBalance).toBe(WITHDRAWAL_REFUND_CEILING); // unchanged
  });

  it('keeps GAME_POINTS capped at MAX_BALANCE even for a change mislabeled referenceType WITHDRAWAL', async () => {
    // Withdrawals never touch GAME_POINTS anywhere in this domain — the
    // exemption is hardcoded to COINS only (see isWithdrawalRefundExempt),
    // so this path stays capped with no exception even if a caller
    // mistakenly attaches referenceType 'WITHDRAWAL' to a GAME_POINTS
    // change.
    await cleanFixtures();
    const tag = `game-points-cap-${Date.now()}`;
    const user = await createUser(tag);
    await getOrCreateWallet(user.id);
    await executeBalanceChange({
      userId: user.id,
      changes: [
        {
          currency: 'GAME_POINTS',
          amount: MAX_BALANCE,
          ledgerType: 'CREDIT',
          transactionType: 'GAME_POINT_CREDIT',
          referenceType: 'ADMIN',
          description: 'test fixture: game points to cap',
        },
      ],
      operationName: 'test-fixture-gp-cap',
    });

    await expect(
      prisma.$transaction((tx) =>
        applyBalanceChanges(tx, user.id, [
          {
            currency: 'GAME_POINTS',
            amount: 1,
            ledgerType: 'CREDIT',
            transactionType: 'GAME_POINT_CREDIT',
            referenceType: 'WITHDRAWAL',
            description: 'GAME_POINTS should never be exempt',
          },
        ])
      )
    ).rejects.toThrow(/exceeds maximum/);
  });
});
