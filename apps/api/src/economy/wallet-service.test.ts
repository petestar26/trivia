import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@socialplay/database';
import { getOrCreateWallet, getWalletBalance, executeBalanceChange, applyBalanceChanges } from './wallet-service';
import { lockUserEconomicScope, reserveWithdrawalCoins, releaseWithdrawalCoins } from './coin-ledger-service.js';
import { activateTestWithdrawalPolicy, mintTestPurchasedCoins, nextTestCountryCode } from '../test/financial-policy-fixtures.js';

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
  await prisma.platformGate.updateMany({ where: { key: 'WITHDRAWAL_CREATE' }, data: { enabled: false } });
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
  // Coin provenance/allocation rows are a real foreign key to User —
  // must be cleared before the user row itself can be deleted. Covers
  // both rows this run created AND legacy backfill rows for any stale
  // fixture user left behind by a prior interrupted run (same id set).
  await prisma.coinAllocation.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.coinProvenance.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  const countries = await prisma.country.findMany({ where: { name: { startsWith: 'Wallet Cap Country' } } });
  for (const country of countries) {
    await prisma.countryJurisdiction.deleteMany({ where: { countryCode: country.code } });
    await prisma.countryCasinoPolicy.deleteMany({ where: { countryCode: country.code } });
    await prisma.country.delete({ where: { id: country.id } });
  }
}

/** Credits a fresh wallet's COINS balance up to exactly MAX_BALANCE via an
 * ordinary (non-withdrawal) credit — the normal cap check allows this. */
async function creditCoinsToCap(userId: string) {
  await mintTestPurchasedCoins(userId, MAX_BALANCE);
}

async function testWithdrawalPolicy(configuredBy: string) {
  const country = await prisma.country.create({ data: {
    code: await nextTestCountryCode(), name: `Wallet Cap Country ${randomUUID()}`,
    currencyCode: 'USD', isActive: true, agentPaymentEnabled: true,
  } });
  await activateTestWithdrawalPolicy(country.id, configuredBy);
  const policy = await prisma.countryCasinoPolicy.findFirstOrThrow({ where: { countryCode: country.code, state: 'ACTIVE' } });
  return policy;
}

async function holdCoins(userId: string, amount: number, policy: { id: string; version: number }) {
  const withdrawalId = randomUUID();
  const result = await prisma.$transaction(async (tx) => {
    await lockUserEconomicScope(tx, `test-hold:${userId}:${withdrawalId}`);
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR SHARE`;
    return reserveWithdrawalCoins(tx, userId, amount, {
      withdrawalId, policyId: policy.id, policyVersion: policy.version, holdingPeriodHours: 0,
    });
  });
  return { withdrawalId, holdOperationId: result.holdOperationId, amount };
}

async function releaseCoins(userId: string, hold: { withdrawalId: string; holdOperationId: string; amount: number }) {
  return prisma.$transaction(async (tx) => {
    await lockUserEconomicScope(tx, `test-release:${userId}:${hold.withdrawalId}`);
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR SHARE`;
    return releaseWithdrawalCoins(tx, userId, hold.withdrawalId, {
      holdOperationId: hold.holdOperationId, amount: hold.amount,
    });
  });
}

describeIf('economy/wallet-service — MAX_BALANCE withdrawal-refund exemption (W-1D0)', () => {
  it('rejects an ordinary (non-withdrawal) COINS credit that would exceed MAX_BALANCE', async () => {
    await cleanFixtures();
    const tag = `ordinary-cap-${Date.now()}`;
    const user = await createUser(tag);
    await creditCoinsToCap(user.id);

    await expect(mintTestPurchasedCoins(user.id, 1)).rejects.toThrow(/exceeds maximum/);

    const balance = await getWalletBalance(user.id);
    expect(balance.coinsBalance).toBe(MAX_BALANCE); // unchanged
  });

  it('allows a WITHDRAWAL/CREDIT to push COINS above MAX_BALANCE, within the safe ceiling', async () => {
    await cleanFixtures();
    const tag = `withdrawal-exempt-${Date.now()}`;
    const user = await createUser(tag);
    const policy = await testWithdrawalPolicy(user.id);
    await creditCoinsToCap(user.id);

    // Balance lands at 1.5e9 — above MAX_BALANCE, comfortably below the
    // 2e9 hard ceiling.
    const refundAmount = 500_000_000;
    const hold = await holdCoins(user.id, refundAmount, policy);
    await mintTestPurchasedCoins(user.id, refundAmount);
    await releaseCoins(user.id, hold);

    const balance = await getWalletBalance(user.id);
    expect(balance.coinsBalance).toBe(MAX_BALANCE + refundAmount);
    expect(balance.coinsBalance).toBeLessThanOrEqual(WITHDRAWAL_REFUND_CEILING);
  });

  it('still rejects a WITHDRAWAL/CREDIT that would exceed the hard 2x-MAX_BALANCE ceiling', async () => {
    await cleanFixtures();
    const tag = `withdrawal-ceiling-${Date.now()}`;
    const user = await createUser(tag);
    const policy = await testWithdrawalPolicy(user.id);
    await creditCoinsToCap(user.id);

    // Two authentic holds let the first release land exactly at 2x the cap.
    const largeHold = await holdCoins(user.id, MAX_BALANCE, policy);
    await mintTestPurchasedCoins(user.id, MAX_BALANCE);
    const smallHold = await holdCoins(user.id, 1, policy);
    await mintTestPurchasedCoins(user.id, 1);
    await releaseCoins(user.id, largeHold);
    const atCeiling = await getWalletBalance(user.id);
    expect(atCeiling.coinsBalance).toBe(WITHDRAWAL_REFUND_CEILING);

    // A second refund would push past the ceiling — must be rejected,
    // proving the exemption is bounded, not unlimited.
    await expect(releaseCoins(user.id, smallHold)).rejects.toThrow(/exceeds maximum/);

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
